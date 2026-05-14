import { Injectable } from '@nestjs/common';
import type { TurnLog } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TurnsQuery {
  from?: string;
  to?: string;
  business_id?: string;
  limit?: number;
}

export interface LatencyStats {
  window_from: string;
  window_to: string;
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

export interface RateStats {
  window_from: string;
  window_to: string;
  total: number;
  numerator: number;
  rate: number;
}

@Injectable()
export class InternalService {
  constructor(private readonly prisma: PrismaService) {}

  async listTurns(q: TurnsQuery): Promise<TurnLog[]> {
    const { from, to } = this.parseWindow(q.from, q.to);
    const limit = clamp(q.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    return this.prisma.turnLog.findMany({
      where: {
        ts: { gte: from, lte: to },
        ...(q.business_id ? { business_id: q.business_id } : {}),
      },
      orderBy: { ts: 'desc' },
      take: limit,
    });
  }

  async latencyStats(q: Pick<TurnsQuery, 'from' | 'to' | 'business_id'>): Promise<LatencyStats> {
    const { from, to } = this.parseWindow(q.from, q.to);
    type Row = { count: bigint | number; p50: number | null; p95: number | null; p99: number | null };
    const rows = await this.prisma.$queryRaw<Row[]>(
      Prisma.sql`
        SELECT
          COUNT(*) AS count,
          PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY duration_ms)::int AS p50,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99
        FROM "TurnLog"
        WHERE ts >= ${from} AND ts <= ${to}
          ${q.business_id ? Prisma.sql`AND business_id = ${q.business_id}` : Prisma.empty}
      `,
    );
    const r = rows[0];
    return {
      window_from: from.toISOString(),
      window_to: to.toISOString(),
      count: Number(r?.count ?? 0),
      p50_ms: r?.p50 ?? null,
      p95_ms: r?.p95 ?? null,
      p99_ms: r?.p99 ?? null,
    };
  }

  async escalationRate(q: Pick<TurnsQuery, 'from' | 'to' | 'business_id'>): Promise<RateStats> {
    const { from, to } = this.parseWindow(q.from, q.to);
    const where = {
      ts: { gte: from, lte: to },
      ...(q.business_id ? { business_id: q.business_id } : {}),
    };
    const [total, escalates] = await Promise.all([
      this.prisma.turnLog.count({ where }),
      this.prisma.turnLog.count({ where: { ...where, status: 'escalate' } }),
    ]);
    return {
      window_from: from.toISOString(),
      window_to: to.toISOString(),
      total,
      numerator: escalates,
      rate: total === 0 ? 0 : escalates / total,
    };
  }

  async validatorPassRate(q: Pick<TurnsQuery, 'from' | 'to' | 'business_id'>): Promise<RateStats> {
    const { from, to } = this.parseWindow(q.from, q.to);
    const where = {
      ts: { gte: from, lte: to },
      ...(q.business_id ? { business_id: q.business_id } : {}),
    };
    const [total, passes] = await Promise.all([
      this.prisma.turnLog.count({ where }),
      this.prisma.turnLog.count({ where: { ...where, validator_pass: true } }),
    ]);
    return {
      window_from: from.toISOString(),
      window_to: to.toISOString(),
      total,
      numerator: passes,
      rate: total === 0 ? 0 : passes / total,
    };
  }

  private parseWindow(from?: string, to?: string): { from: Date; to: Date } {
    const now = new Date();
    const parsedTo = to ? new Date(to) : now;
    const parsedFrom = from ? new Date(from) : new Date(parsedTo.getTime() - DEFAULT_WINDOW_MS);
    if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime())) {
      throw new Error('invalid_window: from/to must be ISO 8601');
    }
    return { from: parsedFrom, to: parsedTo };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
