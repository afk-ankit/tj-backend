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
    const id = request.params.id;
    const location = await this.prisma.location.findUnique({
      where: { id },
    });
    if (!location) {
      throw new BadRequestException('LocationId is invalid.');
    }
    return true;
  }
}
