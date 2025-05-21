import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { AuthService } from 'src/auth/auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { QueueService } from 'src/queue/queue.service';
import { GHLWorkflowData } from './types/ghl-workflow.type';
import pLimit from 'p-limit';

@Injectable()
export class ContactService {
  constructor(
    private readonly PrismaService: PrismaService,
    private readonly ConfigService: ConfigService,
    private readonly queueService: QueueService,
    private readonly authService: AuthService,
  ) {}
  private readonly logger = new Logger(ContactService.name);
  private readonly limit = pLimit(5);

  async handleUpload(
    file: Express.Multer.File,
    body: {
      mappings: string;
      tags: string;
    },
    id: string,
  ) {
    const location = await this.PrismaService.location.findUnique({
      where: { id },
    });
    const contact_mappings = JSON.parse(body.mappings);
    const tags = JSON.parse(body.tags);
    const custom_tags = tags.filter((tag: { id: string }) =>
      tag.id.startsWith('custom'),
    );
    const custom_fields_set: Set<string> = new Set();
    const phoneTypeKeys: string[] = [];

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
      this.logger.log('🔧 Starting custom fields creation...');
      const createdFields = await Promise.all(
        custom_fields.map((item) =>
          this.createCustomField(location.id, item, location.accessToken),
        ),
      );
      this.logger.log(
        `✅ ${createdFields.length} custom fields created successfully.`,
      );

      this.logger.log('🏷️ Starting tag creation...');
      const createdTags = await Promise.all(
        custom_tags.map((item: { name: string }) =>
          this.createTag(location.id, item.name, location.accessToken),
        ),
      );
      this.logger.log(`✅ ${createdTags.length} tags created successfully.`);
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
        fileName: file.filename,
        filePath: file.path,
        mappings: JSON.stringify(updatedMappings),
        locationId: id,
        tags: tags.map((item: { name: string }) => item.name),
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

  async getTag(id: string) {
    try {
      const url = `${this.ConfigService.get('GHL_BASE_URL')}/locations/${id}/tags`;
      const { accessToken } = await this.PrismaService.location.findUnique({
        where: {
          id,
        },
      });
      const res = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: '2021-07-28',
        },
      });
      return res.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status || error.status;
        switch (status) {
          case 400:
            this.logger.error(error.response?.data.message);
            throw new BadRequestException(error.response?.data.message);
          case 401:
            this.logger.error(error.response?.data.message);
            throw new UnauthorizedException(error.response?.data.message);
          default:
            throw error;
        }
      }
      throw error;
    }
  }
  async createTag(id: string, name: string, accessToken: string) {
    const url = `${this.ConfigService.get('GHL_BASE_URL')}/locations/${id}/tags`;
    const res = await axios.post(
      url,
      {
        name,
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
  async getJob(id: string) {
    const res = await this.PrismaService.job.findMany({
      where: {
        locationId: id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 5,
    });
    return res;
  }

  async workflow(body: GHLWorkflowData, action: 'DND' | 'DELETE') {
    await this.authService.refreshToken(body.location.id, 'Location');
    const { accessToken } = await this.PrismaService.location.findUnique({
      where: {
        id: body.location.id,
      },
    });
    const url = `${this.ConfigService.get('GHL_BASE_URL')}/contacts/search`;
    try {
      const res = await axios.post(
        url,
        {
          locationId: body.location.id,
          page: 1,
          pageLimit: 20,
          filters: [
            {
              field: 'firstNameLowerCase',
              operator: 'eq',
              value: body.first_name.toLowerCase(),
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Version: '2021-07-28',
          },
        },
      );
      const { contacts } = res.data as { contacts: [{ id: string }] };
      const counter = { success: 0, failure: 0 };
      const promiseMap = contacts.map((item) =>
        this.limit(() =>
          action == 'DND'
            ? this.updateGHLContactDND({
                accessToken,
                contactId: item.id,
                counter,
                exception: body.contact_id,
              })
            : this.deleteGHLContactDND({
                accessToken,
                contactId: item.id,
                counter,
                exception: body.contact_id,
              }),
        ),
      );
      await Promise.allSettled(promiseMap);
      return counter;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(error.response.data);
        throw new HttpException(error.response.data, error.response.status);
      }
      throw error;
    }
  }

  private async updateGHLContactDND({
    contactId,
    counter,
    accessToken,
    exception,
  }: {
    contactId: string;
    counter: { success: number; failure: number };
    accessToken: string;
    exception: string;
  }) {
    if (exception == contactId) return;
    try {
      const contact_update_url =
        this.ConfigService.get('GHL_BASE_URL') + `/contacts/${contactId}`;
      const result = await axios.put(
        contact_update_url,
        {
          dnd: true,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Version: '2021-07-28',
          },
        },
      );
      counter.success++;
      return result.data;
    } catch (error) {
      this.logger.error(`Failed to create contact: ${error.message}`);
      counter.failure++;
      throw error;
    }
  }

  private async deleteGHLContactDND({
    contactId,
    counter,
    accessToken,
    exception,
  }: {
    contactId: string;
    counter: { success: number; failure: number };
    accessToken: string;
    exception: string;
  }) {
    if (exception == contactId) return;
    try {
      const contact_delete_url =
        this.ConfigService.get('GHL_BASE_URL') + `/contacts/${contactId}`;
      const result = await axios.delete(contact_delete_url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: '2021-07-28',
        },
      });
      counter.success++;
      return result.data;
    } catch (error) {
      this.logger.error(`Failed to create contact: ${error.message}`);
      counter.failure++;
      throw error;
    }
  }
}
