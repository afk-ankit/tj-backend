import {
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CompanyGuard } from './guard/company.guard';
import { ContactService } from './contact.service';

@UseGuards(CompanyGuard)
@Controller('contact')
export class ContactController {
  constructor(private readonly ContactService: ContactService) {}
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(@UploadedFile() file: Express.Multer.File) {
    console.log(file);
  }

  @Get('custom-field/:id')
  getCustomField(@Param('id') id: string) {
    return this.ContactService.getCustomField(id);
  }
}
