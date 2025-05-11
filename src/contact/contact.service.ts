import {
  BadRequestException,
  Injectable,
  Logger,
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
  private readonly logger = new Logger(ContactService.name);

  async handleUpload(
    file: Express.Multer.File,
    body: {
      mappings: string;
    },
    id: string,
  ) {
    const location = await this.PrismaService.location.findUnique({
      where: { id },
    });
    const contact_mappings = JSON.parse(body.mappings);
    const custom_fields_set: Set<string> = new Set();
    const phoneTypeKeys: string[] = [];

    // First pass - identify all custom fields and phone type fields
    for (const [key, value] of Object.entries(contact_mappings)) {
      if (value === 'custom') {
        if (
          key.toLowerCase().includes('phone') &&
          key.toLowerCase().includes('type')
        ) {
          // Store phone type keys separately - we'll handle them specially
          phoneTypeKeys.push(key);
          // We only need to add Phone Type once to the set
          custom_fields_set.add('Phone Type');
        } else {
          custom_fields_set.add(key);
        }
      }
    }

    try {
      const custom_fields: string[] = [...custom_fields_set];
      // Step 1: Create custom fields
      const createdFields = await Promise.all(
        custom_fields.map((item) =>
          this.createCustomField(location.id, item, location.accessToken),
        ),
      );

      // Find the phone type field response - correctly access the nested fieldKey
      let phoneTypeFieldKey = null;
      for (let i = 0; i < custom_fields.length; i++) {
        if (custom_fields[i] === 'Phone Type') {
          phoneTypeFieldKey = createdFields[i].customField.fieldKey;
          break;
        }
      }

      // Make a copy of the original mappings
      const updatedMappings = { ...contact_mappings };

      // Step 2: Replace 'custom' with actual fieldKey in mappings
      for (const [key, value] of Object.entries(contact_mappings)) {
        if (value === 'custom') {
          if (
            key.toLowerCase().includes('phone') &&
            key.toLowerCase().includes('type')
          ) {
            // For all phone type fields, use the same fieldKey
            updatedMappings[key] = phoneTypeFieldKey;
          } else {
            // For other custom fields, find the corresponding created field
            const fieldIndex = custom_fields.findIndex(
              (field) => field === key,
            );
            if (fieldIndex !== -1) {
              updatedMappings[key] =
                createdFields[fieldIndex].customField.fieldKey;
            }
          }
        }
      }

      // Final check to ensure all phone type fields are in the mappings
      if (phoneTypeFieldKey) {
        for (const key of phoneTypeKeys) {
          updatedMappings[key] = phoneTypeFieldKey;
        }
      }

      await this.queueService.addUploadJob({
        filePath: file.path,
        mappings: JSON.stringify(updatedMappings),
        locationId: id,
      });

      return { message: 'Upload queued successfully.' };
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status || error.status;
        switch (status) {
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
