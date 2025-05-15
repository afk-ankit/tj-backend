import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class QueueService {
  constructor(@InjectQueue('upload-csv') private queue: Queue) {}

  async addUploadJob(data: {
    fileName: string;
    filePath: string;
    mappings: string;
    locationId: string;
  }) {
    await this.queue.add('upload-job', data, {
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
