import { Controller, Get, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/current-user.decorator';

@Controller({ path: 'wallets', version: '1' })
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const rows = await this.prisma.wallet.findMany({ where: { userId: user.userId } });
    return rows.map((w) => ({
      asset: w.asset,
      balance: w.balance.toString(),
      locked: w.locked.toString(),
    }));
  }
}
