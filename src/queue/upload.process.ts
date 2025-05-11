import { Processor, WorkerHost } from '@nestjs/bullmq';
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

interface UploadJobData {
  filePath: string;
  mappings: string;
  locationId: string;
  userId: string; // Added to identify which user should receive the progress updates
}

interface JobProgress {
  progress: number;
  status: 'processing' | 'completed' | 'failed';
  message?: string;
  result?: any;
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

  @WebSocketServer()
  server: Server;

  async process(
    job: Job<UploadJobData, any, string>,
  ): Promise<{ processedCount: number }> {
    this.logger.debug(`Processing upload job ${job.id}`);

    const { filePath, mappings, locationId } = job.data;
    const contact_mappings = JSON.parse(mappings);

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
      );

      const limit = pLimit(4);
      const counter = { success: 0, failure: 0 };
      const contact_map = results.map(
        (item) => limit(() => this.createGHLContact(item, locationId, counter)),
        // this.createGHLContact(item, locationId),
      );

      const settled_results = await Promise.allSettled(contact_map);

      const successCount = settled_results.filter(
        (r) => r.status === 'fulfilled',
      ).length;
      const failCount = settled_results.filter(
        (r) => r.status === 'rejected',
      ).length;

      this.logger.debug(`✅ Success: ${successCount}, ❌ Failed: ${failCount}`);

      this.emitProgress(
        locationId,
        50,
        'processing',
        `CSV parsed with ${results.length} records`,
      );
      this.logger.log(`CSV parsed with ${results.length} records`);

      // Here you would call GHL APIs and save contacts
      this.emitProgress(
        locationId,
        70,
        'processing',
        'Saving contacts to database',
      );

      this.logger.log(
        `Processed ${results.length} contacts for location ${locationId}`,
      );

      // Delete file after processing
      this.emitProgress(
        locationId,
        90,
        'processing',
        'Cleaning up temporary files',
      );
      await fsPromises.unlink(filePath);

      const result = { processedCount: results.length };
      this.emitProgress(
        locationId,
        100,
        'completed',
        'Upload completed successfully',
        result,
      );

      return result;
    } catch (error) {
      this.logger.error(`Error processing upload job ${job.id}:`, error);
      this.emitProgress(
        locationId,
        0,
        'failed',
        `Processing failed: ${error.message}`,
      );
      throw error;
    }
  }

  private async parseCsvFile(
    filePath: string,
    job: Job<UploadJobData>,
    userId: string,
    mappings: Record<string, string>,
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      const stream = createReadStream(filePath).pipe(csvParser());

      let rowCount = 0;
      const progressReportThreshold = 10;

      // this.logger.debug(mappings);

      stream.on('data', (row) => {
        // Group fields
        const grouped: Record<string, Record<string, string>> = {};
        const commonFields: Record<string, any> = {}; // allow customFields array
        const customFields: { key: string; field_value: string }[] = [];

        for (const [originalKey, value] of Object.entries(row)) {
          const mappedKey = mappings[originalKey] ?? originalKey;

          // Check if it's a phone/phoneType field with a number (e.g., Phone 1, Phone 2)
          const match = originalKey.match(/(\d+)/); // Extract number like '1', '2'
          const index = match ? match[1] : null;

          if (mappedKey === 'phone' || mappedKey === 'contact.phone_type') {
            if (index) {
              if (!grouped[index]) grouped[index] = {};
              grouped[index][mappedKey] = value as string;
            }
          } else {
            if (DEFAULT_CONTACT_FIELDS.has(mappedKey)) {
              commonFields[mappedKey] = value as string;
            } else {
              customFields.push({
                key: mappedKey,
                field_value: value as string,
              });
            }
          }
        }

        // if (customFields.length > 0) {
        //   commonFields.customFields = customFields;
        // }

        // Create one result per phone group
        for (const group of Object.values(grouped)) {
          if (group.phone) {
            results.push({
              ...commonFields,
              phone: group.phone,
              customFields: [
                ...customFields,
                {
                  key: 'contact.phone_type',
                  field_value: group['contact.phone_type'],
                },
              ],
            });
          }
          rowCount++;
        }

        // Report progress
        if (rowCount % progressReportThreshold === 0) {
          const progressMessage = `Parsed ${rowCount} rows from CSV`;
          const progressPercentage = Math.min(10 + rowCount / 100, 40);
          this.emitProgress(
            userId,
            progressPercentage,
            'processing',
            progressMessage,
          );
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
  ): void {
    const progressUpdate: JobProgress = {
      progress,
      status,
      message,
      result,
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
  async onActive(job: Job<UploadJobData, any, string>): Promise<void> {
    this.logger.log(`Job ${job.id} started processing`);
    this.emitProgress(job.id, 0, 'processing', 'Job started processing');
  }

  async onCompleted(
    job: Job<UploadJobData, any, string>,
    result: any,
  ): Promise<void> {
    this.logger.log(
      `Job ${job.id} completed. Processed ${result.processedCount} contacts`,
    );
  }

  async onFailed(
    job: Job<UploadJobData, any, string>,
    error: Error,
  ): Promise<void> {
    this.logger.error(
      `Job ${job.id} failed with error: ${error.message}`,
      error.stack,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      console.log(error.message);
      counter.failure++;
      error();
    } finally {
      console.log(
        `✅ Success: ${counter.success}, ❌ Failed: ${counter.failure}`,
      );
    }
  }
}
