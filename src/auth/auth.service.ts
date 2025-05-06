import * as CryptoJS from 'crypto-js';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Location } from '@prisma/client';
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

  async exchangeCodeForToken(code: string, res: Response) {
    try {
      const clientId = this.configService.get('GHL_CLIENT_ID');
      const clientSecret = this.configService.get('GHL_CLIENT_SECRET');

      const response = await axios.post(
        `${this.GHL_BASE_URL}/oauth/token?scope=contacts.readonly contacts.write locations/customFields/readonly locations/customFields.write`,
        {
          client_id: clientId,
          client_secret: clientSecret,
          user_type: 'Location',
          grant_type: 'authorization_code',
          code,
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );
      const { access_token, refresh_token, expires_in, companyId, locationId } =
        response.data;
      const tokenExpiry = new Date(Date.now() + expires_in * 1000);
      await this.prisma.location.upsert({
        where: {
          id: locationId,
        },
        create: {
          accessToken: access_token,
          refreshToken: refresh_token,
          companyId: companyId,
          tokenExpiry,
          id: locationId,
        },
        update: {
          accessToken: access_token,
          refreshToken: refresh_token,
          tokenExpiry,
        },
      });

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
        throw new BadRequestException(error.response?.data);
      }
      throw error;
    }
  }

  async refreshToken(id: string, scope: 'Agency' | 'Location') {
    let company: Location | Location;
    if (scope === 'Agency')
      company = await this.prisma.location.findUnique({
        where: { companyId: id },
      });
    else {
      company = await this.prisma.location.findUnique({
        where: { id: id },
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
      await this.prisma.location.update({
        where: { id: id },
        data: {
          accessToken: access_token,
          refreshToken: refresh_token,
          tokenExpiry,
        },
      });
    else
      await this.prisma.location.update({
        where: { id: id },
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
      await this.prisma.location.findUnique({
        where: {
          companyId: body.companyId,
        },
      });
    }
  }
}
