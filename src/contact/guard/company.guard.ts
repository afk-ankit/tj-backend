import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class CompanyGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    if (
      request.method === 'POST' &&
      request.path.startsWith('/contact/verify')
    ) {
      return true;
    }
    const id = request.params.id;

    if (!id) {
      throw new BadRequestException('Missing required parameter: location ID.');
    }

    const location = await this.prisma.location.findUnique({
      where: { id },
    });

    if (!location) {
      throw new BadRequestException(
        `No location found with the provided ID: ${id}. Please verify the ID and try again.`,
      );
    }

    return true;
  }
}
