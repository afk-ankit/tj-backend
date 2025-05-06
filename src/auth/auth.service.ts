import * as CryptoJS from 'crypto-js';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Company } from '@prisma/client';
import axios, { AxiosError } from 'axios';
import { Response } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { InstallEvent } from 'types/install-event';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  private readonly GHL_BASE_URL = this.configService.get('GHL_BASE_URL');
  private readonly GHL_APP_SSO_KEY = this.configService.get('GHL_APP_SSO_KEY');
  private async getInstalledLocation(
    access_token: string,
    companyId: string,
    planId: string,
  ): Promise<any> {
    const appId = this.configService.get('GHL_APP_ID');
    let url = `${this.GHL_BASE_URL}/oauth/installedLocations?companyId=${companyId}&appId=${appId}&isInstalled=true&limit=10000`;
    if (planId) {
      url += `&planId=${planId}`;
    }

    const locationsResponse = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Version: '2021-07-28',
      },
    });
    return locationsResponse;
  }
  async exchangeCodeForToken(code: string, res: Response) {
    try {
      const clientId = this.configService.get('GHL_CLIENT_ID');
      const clientSecret = this.configService.get('GHL_CLIENT_SECRET');

      const response = await axios.post(
        `${this.GHL_BASE_URL}/oauth/token`,
        {
          client_id: clientId,
          client_secret: clientSecret,
          user_type: 'Company',
          grant_type: 'authorization_code',
          code,
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      const { access_token, refresh_token, expires_in, companyId, planId } =
        response.data;

      const tokenExpiry = new Date(Date.now() + expires_in * 1000);
      const existing_company = await this.prisma.company.upsert({
        where: {
          companyId: companyId,
        },
        create: {
          accessToken: access_token,
          refreshToken: refresh_token,
          companyId: companyId,
          tokenExpiry,
        },
        update: {
          accessToken: access_token,
          refreshToken: refresh_token,
          tokenExpiry,
        },
      });

      const locationsResponse = await this.getInstalledLocation(
        access_token,
        companyId,
        planId,
      );

      if (locationsResponse.data.locations) {
        const promises = locationsResponse.data?.locations?.map(
          (item: { _id: string; name: string }) =>
            this.prisma.location.upsert({
              where: {
                locationId: item._id,
              },
              create: {
                name: item.name,
                locationId: item._id,
                companyId: existing_company.id,
              },
              update: {},
            }),
        );
        await Promise.all(promises);
      }
      res.send(`
            <html>
              <body>
                <script>
                  window.close();
                </script>
                <p>If the tab did not close, please close it manually.</p>
              </body>
            </html>
            `);
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error('GHL Error:', error);
        throw new BadRequestException(error.response?.data);
      }
      throw error;
    }
  }

  async refreshToken(id: string, scope: 'Agency' | 'Location') {
    let company: Company | Location;
    if (scope === 'Agency')
      company = await this.prisma.company.findUnique({
        where: { companyId: id },
      });
    else {
      company = await this.prisma.location.findUnique({
        where: { locationId: id },
      });
    }
    if (!company || !company.refreshToken) {
      throw new NotFoundException(
        'Agency/Location not found or refresh token missing',
      );
    }

    const response = await axios.post(
      `${this.GHL_BASE_URL}/oauth/token`,
      {
        client_id: this.configService.get('GHL_CLIENT_ID'),
        client_secret: this.configService.get('GHL_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: company.refreshToken,
      },

      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    const { access_token, refresh_token, expires_in } = response.data;
    const tokenExpiry = new Date(Date.now() + expires_in * 1000);

    if (scope == 'Agency')
      await this.prisma.company.update({
        where: { companyId: id },
        data: {
          accessToken: access_token,
          refreshToken: refresh_token,
          tokenExpiry,
        },
      });
    else
      await this.prisma.location.update({
        where: { locationId: id },
        data: {
          accessToken: access_token,
          refreshToken: refresh_token,
          tokenExpiry,
        },
      });

    return { success: 'Token refreshed successfully', data: { access_token } };
  }

  private decryptAndParseData(encryptedData: string): any {
    try {
      const decryptedData = CryptoJS.AES.decrypt(
        encryptedData,
        this.GHL_APP_SSO_KEY,
      ).toString(CryptoJS.enc.Utf8);
      return JSON.parse(decryptedData);
    } catch (error) {
      console.error('Decryption failed:', error);
      return null;
    }
  }

  async processEncryptedData(encryptedData: string) {
    return this.decryptAndParseData(encryptedData);
  }

  async webHookInstall(body: InstallEvent) {
    if (body.installType == 'Location') {
      const company = await this.prisma.company.findUnique({
        where: {
          companyId: body.companyId,
        },
      });
      const res = await this.prisma.location.upsert({
        where: {
          locationId: body.locationId,
        },
        create: {
          name: 'default',
          locationId: body.locationId,
          companyId: company.id,
        },
        update: {},
      });
      return res;
    }
  }
}
