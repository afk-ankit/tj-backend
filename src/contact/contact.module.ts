import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { QueueModule } from 'src/queue/queue.module';

@Module({
  controllers: [ContactController],
  providers: [ContactService],
  imports: [QueueModule],
})
export class ContactModule {}
