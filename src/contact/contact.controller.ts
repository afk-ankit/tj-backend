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

@UseGuards(CompanyGuard)
@Controller('contact')
export class ContactController {
  constructor(private readonly ContactService: ContactService) {}

  @Post('upload/:id')
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(
    @Param('id') id: string,
    @UploadedFile()
    file: Express.Multer.File,
    @Body() body: { mappings: string },
  ) {
    return this.ContactService.handleUpload(file, body, id);
  }

  @Get('custom-field/:id')
  getCustomField(@Param('id') id: string) {
    return this.ContactService.getCustomField(id);
  }
}
