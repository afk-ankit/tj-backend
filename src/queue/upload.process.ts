import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { promises as fsPromises } from 'fs';
import * as csvParser from 'csv-parser';
import { createReadStream } from 'fs';
import { Injectable, Logger } from '@nestjs/common';

interface UploadJobData {
  filePath: string;
  mappings: string;
  locationId: string;
}

@Injectable()
@Processor('upload-csv')
export class UploadProcessor extends WorkerHost {
  private readonly logger = new Logger(UploadProcessor.name);

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
      // Parse CSV file
      const results = await this.parseCsvFile(filePath);

      await job.updateProgress(50);
      this.logger.log(`CSV parsed with ${results.length} records`);

      // Here you would call GHL APIs and save contacts
      // For demonstration purposes, we'll just log it
      this.logger.log(
        `Processed ${results.length} contacts for location ${locationId}`,
      );

      // Delete file after processing
      await fsPromises.unlink(filePath);

      await job.updateProgress(100);

      return { processedCount: results.length };
    } catch (error) {
      this.logger.error(`Error processing upload job ${job.id}:`, error);
      throw error;
    }
  }

  private async parseCsvFile(filePath: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      const stream = createReadStream(filePath).pipe(csvParser());

      stream.on('data', (row) => {
        results.push(row);
      });

      stream.on('error', (error) => {
        reject(error);
      });

      stream.on('end', () => {
        resolve(results);
      });
    });
  }

  async onActive(job: Job<UploadJobData, any, string>): Promise<void> {
    this.logger.log(`Job ${job.id} started processing`);
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
