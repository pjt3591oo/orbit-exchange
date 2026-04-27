import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import type { KeycloakClaims } from '../keycloak/keycloak-claims';

export interface AdjustInput {
  delta: string; // signed Decimal string — "+1000" or "-0.5"
  field: 'balance' | 'locked';
  reason: string;
}

@Injectable()
export class AdminWalletsService {
  private readonly log = new Logger(AdminWalletsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  listForUser(userId: string) {
    return this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { asset: 'asc' },
      select: { asset: true, balance: true, locked: true },
    }).then((rows) =>
      rows.map((w) => ({
        asset: w.asset,
        balance: w.balance.toString(),
        locked: w.locked.toString(),
      })),
    );
  }

  /**
   * Adjust a single wallet field by a signed delta. Wraps in $transaction so
   * the audit row reflects the row state we actually applied (no race with
   * concurrent locks/settles).
   *
   * Records BOTH `before` and `after` directly via AdminAuditService — bypasses
   * the interceptor since we want diff fidelity beyond what the response
   * payload alone gives.
   */
  async adjust(
    admin: KeycloakClaims,
    userId: string,
    asset: string,
    input: AdjustInput,
    meta: { ip?: string; ua?: string },
  ) {
    if (!input.reason?.trim()) {
      throw new BadRequestException('reason required');
    }
    let delta: Decimal;
    try {
      delta = new Decimal(input.delta);
    } catch {
      throw new BadRequestException('delta must be a decimal string (e.g. "100" or "-0.5")');
    }
    if (input.field !== 'balance' && input.field !== 'locked') {
      throw new BadRequestException('field must be "balance" or "locked"');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_asset: { userId, asset } },
      });
      if (!wallet) throw new NotFoundException(`wallet ${asset} not found`);

      const beforeBal = new Decimal(wallet.balance.toString());
      const beforeLock = new Decimal(wallet.locked.toString());
      const after =
        input.field === 'balance' ? beforeBal.plus(delta) : beforeLock.plus(delta);
      if (after.lt(0)) {
        throw new BadRequestException(
          `result would be negative: ${input.field}=${after.toString()}`,
        );
      }
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          [input.field]: after.toString() as unknown as Prisma.Decimal,
        },
      });
      return {
        before: {
          asset,
          balance: beforeBal.toString(),
          locked: beforeLock.toString(),
        },
        after: {
          asset,
          balance: updated.balance.toString(),
          locked: updated.locked.toString(),
        },
      };
    });

    await this.audit.write({
      admin,
      action: 'wallet.adjust',
      targetType: 'Wallet',
      targetId: `${userId}:${asset}`,
      before: result.before,
      after: result.after,
      reason: input.reason.trim(),
      ip: meta.ip,
      ua: meta.ua,
    });

    this.log.warn(
      `wallet.adjust by ${admin.email ?? admin.sub} on ${userId}/${asset} ` +
        `${input.field} ${input.delta} reason="${input.reason}"`,
    );

    return result.after;
  }
}
