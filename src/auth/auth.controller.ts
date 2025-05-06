import {
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Query,
  Res,
  ValidationPipe,
} from '@nestjs/common';
import { InstallEvent } from 'types/install-event';
import { EncryptedDataDto } from './dto/encrypted-data.dto';
import { AuthService } from './auth.service';
import { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('oauth/callback')
  async handleOAuthCallback(@Query('code') code: string, @Res() res: Response) {
    return this.authService.exchangeCodeForToken(code, res);
  }

  @Post('refresh-company/:id')
  async refreshCompanyToken(@Param('id') id: string) {
    return this.authService.refreshToken(id, 'Agency');
  }

  @Post('refresh-location/:id')
  async refreshLocationToken(@Param('id') id: string) {
    return this.authService.refreshToken(id, 'Location');
  }

  @Post('appInstalled')
  async appInstalled(@Body() body: InstallEvent) {
    return this.authService.webHookInstall(body);
  }

  @Post('decrypt')
  async decryptData(@Body(ValidationPipe) body: EncryptedDataDto) {
    const decryptedData = await this.authService.processEncryptedData(
      body.encryptedData,
    );

    if (!decryptedData) {
      throw new InternalServerErrorException(
        'Decryption failed or invalid data',
      );
    }

    console.log(decryptedData);
    return decryptedData;
  }
}
