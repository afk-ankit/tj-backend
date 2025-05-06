import { Injectable } from '@nestjs/common';

@Injectable()
export class ContactService {
  async getCustomField(id: string) {
    return id;
  }
}
