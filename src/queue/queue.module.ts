import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { UploadProcessor } from './upload.process';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
      },
    }),
    BullModule.registerQueue({
      name: 'upload-csv',
    }),
  ],
  providers: [QueueService, UploadProcessor],
  exports: [QueueService],
})
export class QueueModule {}
