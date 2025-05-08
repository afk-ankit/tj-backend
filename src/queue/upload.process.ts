import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { promises as fsPromises } from 'fs';
import * as csvParser from 'csv-parser';
import { createReadStream } from 'fs';
import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

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
  private readonly logger = new Logger(UploadProcessor.name);

  @WebSocketServer()
  server: Server;

  async process(
    job: Job<UploadJobData, any, string>,
  ): Promise<{ processedCount: number }> {
    this.logger.debug(`Processing upload job ${job.id}`);

    const { filePath, mappings, locationId } = job.data;
    const contact_mappings = JSON.parse(mappings);
    const custom_fields: string[] = [];

    for (const [key, value] of Object.entries(contact_mappings)) {
      if (value === 'custom') custom_fields.push(key);
    }

    try {
      // Emit initial progress
      this.emitProgress(locationId, 0, 'processing', 'Starting CSV processing');

      // Parse CSV file
      this.emitProgress(locationId, 10, 'processing', 'Reading CSV file');
      const results = await this.parseCsvFile(filePath, job, locationId);

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

      // Simulate some processing time
      await new Promise((resolve) => setTimeout(resolve, 500));

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
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      const stream = createReadStream(filePath).pipe(csvParser());

      let rowCount = 0;
      const progressReportThreshold = 10;

      stream.on('data', (row) => {
        results.push(row);
        rowCount++;

        // Report progress every 10 rows or so (adjust threshold for larger files)
        if (rowCount % progressReportThreshold === 0) {
          const progressMessage = `Parsed ${rowCount} rows from CSV`;
          // Calculate progress between 10 and 50 percent based on rows processed
          // This is approximate since we don't know total rows upfront
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
}
