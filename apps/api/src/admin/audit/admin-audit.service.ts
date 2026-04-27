import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { KeycloakClaims } from '../keycloak/keycloak-claims';

export interface WriteAuditInput {
  admin: KeycloakClaims;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  ua?: string;
}

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(input: WriteAuditInput) {
    return this.prisma.adminAuditLog.create({
      data: {
        adminId: input.admin.sub,
        adminEmail: input.admin.email ?? input.admin.preferred_username ?? '',
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        before:
          input.before === undefined
            ? Prisma.JsonNull
            : (input.before as Prisma.InputJsonValue),
        after:
          input.after === undefined
            ? Prisma.JsonNull
            : (input.after as Prisma.InputJsonValue),
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        ua: input.ua ?? null,
      },
    });
  }

  async list(opts: {
    actor?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    since?: Date;
    until?: Date;
    take?: number;
    cursor?: string;
  }) {
    const where: Prisma.AdminAuditLogWhereInput = {};
    if (opts.actor) {
      where.OR = [
        { adminId: opts.actor },
        { adminEmail: { contains: opts.actor, mode: 'insensitive' } },
      ];
    }
    if (opts.action) where.action = { contains: opts.action };
    if (opts.targetType) where.targetType = opts.targetType;
    if (opts.targetId) where.targetId = opts.targetId;
    if (opts.since || opts.until) {
      where.createdAt = {
        ...(opts.since && { gte: opts.since }),
        ...(opts.until && { lte: opts.until }),
      };
    }
    const take = Math.min(opts.take ?? 100, 500);
    const rows = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: take + 1,
      ...(opts.cursor && { cursor: { id: BigInt(opts.cursor) }, skip: 1 }),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((r) => ({
        id: r.id.toString(),
        adminId: r.adminId,
        adminEmail: r.adminEmail,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        before: r.before,
        after: r.after,
        reason: r.reason,
        ip: r.ip,
        ua: r.ua,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? items[items.length - 1].id.toString() : null,
    };
  }
}
