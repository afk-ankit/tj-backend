import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';
import { QueueModule } from 'src/queue/queue.module';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  controllers: [ContactController],
  providers: [ContactService],
  imports: [QueueModule, AuthModule],
})
export class ContactModule {}
