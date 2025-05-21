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
import { GHLWorkflowData } from './types/ghl-workflow.type';

@UseGuards(CompanyGuard)
@Controller('contact')
export class ContactController {
  constructor(private readonly ContactService: ContactService) {}

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
    @Body() body: { mappings: string; tags: string },
  ) {
    return this.ContactService.handleUpload(file, body, id);
  }

  @Get('custom-field/:id')
  getCustomField(@Param('id') id: string) {
    return this.ContactService.getCustomField(id);
  }
  @Get('/tag/:id')
  getTag(@Param('id') id: string) {
    return this.ContactService.getTag(id);
  }
  @Get('/job/:id')
  getJob(@Param('id') id: string) {
    return this.ContactService.getJob(id);
  }
  @Post('/verify/dnd')
  worflowDnd(@Body() body: GHLWorkflowData) {
    return this.ContactService.workflow(body, 'DND');
  }

  @Post('/verify/delete')
  workflowDelete(@Body() body: GHLWorkflowData) {
    return this.ContactService.workflow(body, 'DELETE');
  }
}
