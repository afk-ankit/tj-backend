import { IsNotEmpty, IsString } from 'class-validator';

export class EncryptedDataDto {
  @IsNotEmpty({ message: 'Encrypted data cannot be empty' })
  @IsString({ message: 'Encrypted data must be a string' })
  encryptedData: string;
}
