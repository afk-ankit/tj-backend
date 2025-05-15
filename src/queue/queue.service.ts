import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('upload-csv') private queue: Queue,
    private readonly PrismaService: PrismaService,
  ) {}

  async addUploadJob(data: {
    fileName: string;
    filePath: string;
    mappings: string;
    locationId: string;
    tags: string[];
  }) {
    const job = await this.queue.add('upload-job', data, {
      removeOnComplete: true,
      removeOnFail: false,
    });
    await this.PrismaService.job.create({
      data: {
        jobId: parseInt(job.id),
        locationId: data.locationId,
        status: 'pending',
        message: 'Job pending in queue',
        fileName: data.fileName,
      },
    });
  }
}
