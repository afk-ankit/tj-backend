import { Injectable } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class ContactService {
  constructor(private readonly PrismaService: PrismaService) {}
  url = 'https://services.leadconnectorhq.com/';
  async getCustomField(id: string) {
    const location = await this.PrismaService.location.findUnique({
      where: { id },
    });
    const custom_field_url = this.url + `locations/${location.id}/customFields`;
    try {
      const res = await axios.get(custom_field_url, {
        headers: {
          Authorization: `Bearer ${location.accessToken}`,
          Version: '2021-07-28',
        },
      });
      return res.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        console.log(error.response?.data);
        throw error;
      }
    }
  }
}
