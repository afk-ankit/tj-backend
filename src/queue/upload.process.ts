import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import axios from 'axios';
import { Job } from 'bullmq';
import * as csvParser from 'csv-parser';
import { createReadStream, promises as fsPromises } from 'fs';
import pLimit from 'p-limit';
import { Server } from 'socket.io';
import { DEFAULT_CONTACT_FIELDS } from 'src/contact/constants/default-fields';
import { PrismaService } from 'src/prisma/prisma.service';
import { JobStatus } from '@prisma/client';

interface UploadJobData {
  fileName: string;
  filePath: string;
  mappings: string;
  locationId: string;
  userId: string; // Added to identify which user should receive the progress updates
  tags: string[];
}

interface JobProgress {
  progress: number;
  status: 'processing' | 'completed' | 'failed';
  message?: string;
  result?: any;
  successCount?: number;
  failureCount?: number;
  totalRecords?: number;
}

@WebSocketGateway({
  cors: {
    origin: '*', // In production, restrict this to your frontend domain
  },
})
@Injectable()
@Processor('upload-csv')
export class UploadProcessor extends WorkerHost {
  constructor(
    private readonly ConfigService: ConfigService,
    private readonly PrismaService: PrismaService,
  ) {
    super();
  }
  private readonly logger = new Logger(UploadProcessor.name);
  private readonly limit = pLimit(1);

  @WebSocketServer()
  server: Server;

  async process(job: Job<UploadJobData, any, string>): Promise<{
    processedCount: number;
    successCount: number;
    failureCount: number;
  }> {
    this.logger.debug(`Processing upload job ${job.id}`);

    const { fileName, filePath, mappings, locationId, tags } = job.data;
    const contact_mappings = JSON.parse(mappings);

    // Check if job entry already exists, if not create initial DB entry for job
    const existingJob = await this.PrismaService.job.findFirst({
      where: { jobId: Number(job.id) },
    });

    if (!existingJob) {
      await this.createDbJobEntry({
        locationId: locationId,
        jobId: Number(job.id),
        status: 'processing',
        message: 'Starting CSV processing',
        fileName,
      });
    } else {
      await this.updateDbJobEntry({
        jobId: Number(job.id),
        status: 'processing',
        message: 'Starting CSV processing',
        fileName,
      });
    }

    try {
      // Emit initial progress
      this.emitProgress(locationId, 0, 'processing', 'Starting CSV processing');

      // Parse CSV file
      this.emitProgress(locationId, 10, 'processing', 'Reading CSV file');
      const results = await this.parseCsvFile(
        filePath,
        job,
        locationId,
        contact_mappings,
        tags,
      );

      const counter = { success: 0, failure: 0 };

      // Update total records count early to improve UX
      const progressMessage = `Started processing of ${results.length} contacts`;
      this.emitProgress(
        locationId,
        30,
        'processing',
        progressMessage,
        undefined,
        0,
        0,
        results.length,
      );

      // Update DB with total records info (no success/failure counts yet)
      await this.updateDbJobEntry({
        jobId: Number(job.id),
        status: 'processing',
        message: progressMessage,
        totalRecords: results.length,
      });

      const contact_map = results.map((item) =>
        this.limit(() => this.createGHLContact(item, locationId, counter)),
      );

      // Start periodic status updates while contacts are being created
      const statusInterval = setInterval(async () => {
        const totalProcessed = counter.success + counter.failure;
        const percentage = Math.min(
          30 + Math.round((totalProcessed / results.length) * 50),
          80,
        );

        const statusMessage = `Processing contacts (${totalProcessed}/${results.length})`;

        this.emitProgress(
          locationId,
          percentage,
          'processing',
          statusMessage,
          undefined,
          counter.success,
          counter.failure,
          results.length,
        );
      }, 1000);

      const settled_results = await Promise.allSettled(contact_map);

      // Clear interval once all promises are settled
      clearInterval(statusInterval);

      const successCount = settled_results.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      const failCount = settled_results.filter(
        (r) => r.status === 'rejected',
      ).length;

      this.logger.debug(`✅ Success: ${successCount}, ❌ Failed: ${failCount}`);

      const processingCompleteMessage = `CSV processed with ${results.length} records`;
      this.emitProgress(
        locationId,
        85,
        'processing',
        processingCompleteMessage,
        undefined,
        counter.success,
        counter.failure,
        results.length,
      );

      // Still no success/failure counts in DB until completion
      await this.updateDbJobEntry({
        jobId: Number(job.id),
        status: 'processing',
        message: processingCompleteMessage,
        totalRecords: results.length,
      });

      this.logger.log(`CSV parsed with ${results.length} records`);
      this.logger.log(
        `Processed ${results.length} contacts for location ${locationId}`,
      );

      // Delete file after processing
      const cleanupMessage = 'Cleaning up temporary files';
      this.emitProgress(
        locationId,
        95,
        'processing',
        cleanupMessage,
        undefined,
        counter.success,
        counter.failure,
        results.length,
      );

      await this.updateDbJobEntry({
        jobId: Number(job.id),
        status: 'processing',
        message: cleanupMessage,
        totalRecords: results.length,
      });

      await fsPromises.unlink(filePath);

      const result = {
        processedCount: results.length,
        successCount: counter.success,
        failureCount: counter.failure,
        totalRecords: results.length,
      };

      const completionMessage = 'Upload completed successfully';
      this.emitProgress(
        locationId,
        100,
        'completed',
        completionMessage,
        result,
        counter.success,
        counter.failure,
        results.length,
      );

      // NOW update DB with success/failure counts at completion
      await this.updateDbJobEntry({
        jobId: Number(job.id),
        status: 'completed',
        message: completionMessage,
        result,
        successCount: counter.success,
        failureCount: counter.failure,
        totalRecords: results.length,
      });

      return result;
    } catch (error) {
      this.logger.error(`Error processing upload job ${job.id}:`, error);

      const errorMessage = `Processing failed: ${error.message}`;

      // Include any partial success/failure counts in the error message
      this.emitProgress(locationId, 0, 'failed', errorMessage, undefined, 0, 0);

      // Update DB with failure status
      await this.updateDbJobEntry({
        jobId: Number(job.id),
        status: 'failed',
        message: errorMessage,
      });

      throw error;
    }
  }

  private async createDbJobEntry({
    locationId,
    jobId,
    status,
    message = null,
    result = null,
    successCount = null,
    failureCount = null,
    totalRecords = null,
    fileName = null,
  }: {
    locationId: string;
    jobId: number;
    status: JobStatus;
    message?: string;
    result?: any;
    successCount?: number;
    failureCount?: number;
    totalRecords?: number;
    fileName?: string;
  }): Promise<void> {
    try {
      await this.PrismaService.job.create({
        data: {
          locationId,
          jobId,
          status,
          message,
          result: result ? JSON.stringify(result) : null,
          successCount,
          failureCount,
          totalRecords,
          fileName,
        },
      });
      this.logger.debug(`Created new job entry in DB for job ID ${jobId}`);
    } catch (error) {
      this.logger.error(`Failed to create job entry in DB: ${error.message}`);
    }
  }

  private async updateDbJobEntry({
    jobId,
    status,
    message,
    locationId = null,
    result = null,
    successCount = null,
    failureCount = null,
    totalRecords = null,
    fileName = null,
  }: {
    jobId: number;
    status: JobStatus;
    message: string;
    result?: any;
    successCount?: number;
    failureCount?: number;
    totalRecords?: number;
    fileName?: string;
    locationId?: string;
  }): Promise<void> {
    try {
      // Find the existing job entry by jobId
      const existingJob = await this.PrismaService.job.findFirst({
        where: { jobId },
        orderBy: { createdAt: 'desc' },
      });

      if (existingJob) {
        // Prepare update data - only include fields that should be updated
        const updateData: any = { status, message };

        // Only include these fields if they are provided (not null)
        if (result !== null) updateData.result = result;
        if (successCount !== null) updateData.successCount = successCount;
        if (failureCount !== null) updateData.failureCount = failureCount;
        if (totalRecords !== null) updateData.totalRecords = totalRecords;
        if (fileName !== null) updateData.fileName = fileName;
        if (locationId !== null) updateData.locationId = locationId;

        // Update existing entry
        await this.PrismaService.job.update({
          where: { id: existingJob.id },
          data: updateData,
        });
        this.logger.debug(
          `Updated job entry in DB for job ID ${jobId} to status ${status}`,
        );
      } else {
        // Create new entry if not found
        await this.createDbJobEntry({
          locationId,
          jobId,
          status,
          message,
          result,
          successCount,
          failureCount,
          totalRecords,
          fileName,
        });
      }
    } catch (error) {
      this.logger.error(`Failed to update job entry in DB: ${error.message}`);
    }
  }

  private async parseCsvFile(
    filePath: string,
    job: Job<UploadJobData>,
    userId: string,
    mappings: Record<string, string>,
    tags: string[],
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      const stream = createReadStream(filePath).pipe(csvParser());

      let rowCount = 0;
      const progressReportThreshold = 10;

      stream.on('data', (row) => {
        // Group fields
        const grouped: Record<string, Record<string, string>> = {};
        const commonFields: Record<string, any> = {};
        const customFields: { key: string; field_value: string }[] = [];

        for (const [originalKey, value] of Object.entries(row)) {
          const mappedKey = mappings[originalKey] ?? originalKey;

          let parsedValue = value;

          //DND
          if (!['firstName', 'lastName'].includes(originalKey)) {
            if (String(value).toLowerCase() === 'true') {
              parsedValue = true;
            } else if (String(value).toLowerCase() === 'false') {
              parsedValue = false;
            }
          }
          // Check if it's a phone/phoneType field with a number
          const match = originalKey.match(/(\d+)/);
          const index = match ? match[1] : null;

          if (mappedKey === 'phone' || mappedKey === 'contact.phone_type') {
            if (index) {
              if (!grouped[index]) grouped[index] = {};
              grouped[index][mappedKey] = parsedValue as string;
            }
          } else {
            if (DEFAULT_CONTACT_FIELDS.has(mappedKey)) {
              commonFields[mappedKey] = parsedValue as string;
            } else {
              customFields.push({
                key: mappedKey.replace(/^contact\./, ''),
                field_value: parsedValue as string,
              });
            }
          }
        }

        // Create one result per phone group
        for (const group of Object.values(grouped)) {
          if (group.phone) {
            results.push({
              ...commonFields,
              phone: group.phone,
              tags,
              customFields: [
                ...customFields,
                ...(group['contact.phone_type']
                  ? [
                      {
                        key: 'phone_type',
                        field_value: group['contact.phone_type'],
                      },
                    ]
                  : []),
              ],
            });
          }
          rowCount++;
        }

        // Report progress with more detailed information
        if (rowCount % progressReportThreshold === 0) {
          const progressMessage = `Parsed ${rowCount} rows from CSV`;
          const progressPercentage = Math.min(10 + rowCount / 100, 30);

          this.emitProgress(
            userId,
            progressPercentage,
            'processing',
            progressMessage,
            undefined,
            0,
            0,
            results.length,
          );

          // Update job progress in BullMQ
          job.updateProgress(progressPercentage).catch((err) => {
            this.logger.warn(`Failed to update job progress: ${err.message}`);
          });
        }
      });

      stream.on('error', (error) => {
        reject(error);
      });

      stream.on('end', () => {
        resolve(results);
      });
    });
  }

  private emitProgress(
    locationId: string,
    progress: number,
    status: JobProgress['status'],
    message: string,
    result?: any,
    successCount?: number,
    failureCount?: number,
    totalRecords?: number,
  ): void {
    const progressUpdate: JobProgress = {
      progress,
      status,
      message,
      result,
      successCount,
      failureCount,
      totalRecords,
    };

    // Emit to a room specific to this user
    this.server.to(`user-${locationId}`).emit('job-progress', progressUpdate);
  }

  // Socket.IO event handlers
  handleConnection(client: any): void {
    const userId = client.handshake.query.userId;
    if (userId) {
      client.join(`user-${userId}`);
      this.logger.log(`Client connected with userId: ${userId}`);
    }

    const jobId = client.handshake.query.jobId;
    if (jobId) {
      client.join(`job-${jobId}`);
      this.logger.log(`Client subscribed to job: ${jobId}`);
    }
  }

  handleDisconnect(): void {
    this.logger.log('Client disconnected');
  }

  // BullMQ event handlers
  @OnWorkerEvent('active')
  async onActive(job: Job<UploadJobData, any, string>): Promise<void> {
    this.logger.log(`Job ${job.id} started processing`);
    this.emitProgress(
      job.data.locationId,
      0,
      'processing',
      'Job started processing',
    );
  }

  @OnWorkerEvent('completed')
  async onCompleted(
    job: Job<UploadJobData, any, string>,
    result: any,
  ): Promise<void> {
    const completionMessage = `Job ${job.id} completed. Processed ${result.processedCount} contacts.`;
    this.logger.log(completionMessage);

    // Update with final completed status and result with counts
    await this.updateDbJobEntry({
      jobId: Number(job.id),
      status: 'completed',
      message: completionMessage,
      result,
      successCount: result.successCount,
      failureCount: result.failureCount,
      totalRecords: result.processedCount,
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<UploadJobData, any, string>,
    error: Error,
  ): Promise<void> {
    const errorMessage = `Job ${job.id} failed with error: ${error.message}`;
    this.logger.error(errorMessage);

    // Update job status to failed in the database
    await this.updateDbJobEntry({
      jobId: Number(job.id),
      status: 'failed',
      message: errorMessage,
    });
  }

  private async createGHLContact(
    data: Record<string, string>,
    id: string,
    counter: { success: number; failure: number },
  ) {
    try {
      const contact_creation_url =
        this.ConfigService.get('GHL_BASE_URL') + '/contacts/upsert';
      const { accessToken } = await this.PrismaService.location.findUnique({
        where: {
          id,
        },
      });
      const result = await axios.post(
        contact_creation_url,
        { ...data, locationId: id },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Version: '2021-07-28',
          },
        },
      );
      counter.success++;
      return result.data;
    } catch (error) {
      this.logger.error(`Failed to create contact: ${error.message}`);
      counter.failure++;
      throw error; // Re-throw to ensure it's counted as a failure in Promise.allSettled
    }
  }
}
