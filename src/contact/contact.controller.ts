import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ContactService } from './contact.service';
import { CompanyGuard } from './guard/company.guard';
import { diskStorage } from 'multer';
import { QueueService } from 'src/queue/queue.service';

@UseGuards(CompanyGuard)
@Controller('contact')
export class ContactController {
  constructor(
    private readonly ContactService: ContactService,
    private readonly queueService: QueueService,
  ) {}

  @Post('upload/:id')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_, file, cb) => {
          const uniqueSuffix =
            Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `${uniqueSuffix}-${file.originalname}`);
        },
      }),
    }),
  )
  async uploadFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { mappings: string },
  ) {
    await this.queueService.addUploadJob({
      filePath: file.path,
      mappings: body.mappings,
      locationId: id,
    });
    return { message: 'Upload queued successfully.' };
  }

  @Get('custom-field/:id')
  getCustomField(@Param('id') id: string) {
    return this.ContactService.getCustomField(id);
  }
}
