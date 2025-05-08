import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';
import { QueueService } from 'src/queue/queue.service';

@Injectable()
export class ContactService {
  constructor(
    private readonly PrismaService: PrismaService,
    private readonly ConfigService: ConfigService,
    private readonly queueService: QueueService,
  ) {}

  async handleUpload(
    file: Express.Multer.File,
    body: {
      mappings: string;
    },
    id: string,
  ) {
    const location = await this.PrismaService.location.findUnique({
      where: {
        id,
      },
    });

    const contact_mappings = JSON.parse(body.mappings);
    const custom_fields: string[] = [];

    for (const [key, value] of Object.entries(contact_mappings)) {
      if (value == 'custom') {
        custom_fields.push(key);
      }
    }
    const custom_fields_promises = custom_fields.map((item) =>
      this.createCustomField(location.id, item, location.accessToken),
    );
    try {
      await Promise.all(custom_fields_promises);
      await this.queueService.addUploadJob({
        filePath: file.path,
        mappings: body.mappings,
        locationId: id,
      });
      return { message: 'Upload queued successfully.' };
    } catch (error) {
      if (error instanceof AxiosError) {
        switch (error.status) {
          case 400:
            throw new BadRequestException(error.response?.data.message);
          case 401:
            throw new UnauthorizedException(error.response?.data.message);
          default:
            throw error;
        }
      }
      throw error;
    }
  }

  async getCustomField(id: string) {
    const location = await this.PrismaService.location.findUnique({
      where: { id },
    });
    const custom_field_url =
      this.ConfigService.get('GHL_BASE_URL') +
      `/locations/${location.id}/customFields`;
    try {
      const res = await axios.get(custom_field_url, {
        headers: {
          Authorization: `Bearer ${location.accessToken}`,
          Version: '2021-07-28',
        },
      });
      return res.data;
    } catch (error) {
      switch (error.status) {
        case 400:
          throw new BadRequestException(error.response?.data.message);
        case 401:
          throw new UnauthorizedException(error.response?.data.message);
        default:
          throw error;
      }
    }
  }

  private async createCustomField(
    id: string,
    name: string,
    accessToken: string,
  ) {
    const url = `${this.ConfigService.get('GHL_BASE_URL')}/locations/${id}/customFields`;
    const res = await axios.post(
      url,
      {
        name,
        dataType: 'TEXT',
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: '2021-07-28',
        },
      },
    );
    return res.data;
  }
}
