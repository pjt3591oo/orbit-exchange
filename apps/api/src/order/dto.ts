import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @Matches(/^[A-Z0-9]+-[A-Z0-9]+$/)
  market!: string;

  @IsEnum(['BID', 'ASK'] as const)
  side!: 'BID' | 'ASK';

  @IsEnum(['LIMIT', 'MARKET'] as const)
  type!: 'LIMIT' | 'MARKET';

  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  price?: string;

  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  quantity!: string;
}
