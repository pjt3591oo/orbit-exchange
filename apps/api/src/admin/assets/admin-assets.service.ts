import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AssetInput {
  symbol: string;
  name: string;
  decimals: number;
}

@Injectable()
export class AdminAssetsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.asset.findMany({ orderBy: { symbol: 'asc' } });
  }

  async create(input: AssetInput) {
    if (!/^[A-Z0-9]{2,12}$/.test(input.symbol)) {
      throw new BadRequestException('symbol must be 2-12 chars, [A-Z0-9]');
    }
    if (input.decimals < 0 || input.decimals > 18) {
      throw new BadRequestException('decimals out of range');
    }
    const exists = await this.prisma.asset.findUnique({ where: { symbol: input.symbol } });
    if (exists) throw new ConflictException('asset already exists');
    return this.prisma.asset.create({ data: input });
  }

  async update(symbol: string, input: Partial<Omit<AssetInput, 'symbol'>>) {
    const asset = await this.prisma.asset.findUnique({ where: { symbol } });
    if (!asset) throw new NotFoundException('asset not found');
    return this.prisma.asset.update({
      where: { symbol },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.decimals !== undefined && { decimals: input.decimals }),
      },
    });
  }

  async remove(symbol: string) {
    const used = await this.prisma.market.findFirst({
      where: { OR: [{ baseAsset: symbol }, { quoteAsset: symbol }] },
      select: { symbol: true },
    });
    if (used) {
      throw new ConflictException(
        `asset is referenced by market ${used.symbol} — disable that market first`,
      );
    }
    const wallet = await this.prisma.wallet.findFirst({
      where: { asset: symbol },
      select: { id: true },
    });
    if (wallet) {
      throw new ConflictException('asset has user wallets — manual cleanup required');
    }
    await this.prisma.asset.delete({ where: { symbol } });
    return { deleted: symbol };
  }
}
