import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ExistingOrderDto } from '../types/reply.dto';
import { formatMoney } from './money';
import { GeneratorService } from '../../pipeline/generator.service';

describe('formatMoney', () => {
  it('formats minor units with currency', () => {
    expect(formatMoney(2500, 'NPR')).toBe('NPR 25.00');
    expect(formatMoney(123456, 'NPR')).toBe('NPR 1,234.56');
    expect(formatMoney(1234, 'USD')).toBe('$12.34');
  });
});

describe('generator EXISTING_ORDER prompt', () => {
  const svc = new GeneratorService({} as any, {} as any, {} as any, {} as any);
  const build = (order: any) =>
    (svc as any).buildUserPayload({
      ctx: { history: [], existing_order: order },
      message: 'hi',
      triage: {},
      feedback: null,
      customerContext: {},
    }) as string;

  it('shows order total 2500 as NPR 25.00 and never the raw minor value', () => {
    const out = build({ ref: 'TRK-1', status: 'PENDING', total: 2500, currency: 'NPR', items: [] });
    expect(out).toContain('NPR 25.00');
    expect(out).not.toContain('2500');
  });

  it('falls back to NPR when currency is missing', () => {
    expect(build({ ref: 'T', status: 'PENDING', total: 2500, items: [] })).toContain('NPR 25.00');
  });
});

describe('ExistingOrderDto total tolerance', () => {
  it('accepts a fractional minor-unit total and formats it without throwing', () => {
    const dto = plainToInstance(ExistingOrderDto, {
      ref: 'T', status: 'PENDING', total: 2499.5, currency: 'NPR', items: [],
    });
    expect(validateSync(dto)).toEqual([]);
    expect(() => formatMoney(dto.total, 'NPR')).not.toThrow();
  });
  it('rejects a negative total', () => {
    const dto = plainToInstance(ExistingOrderDto, { ref: 'T', status: 'PENDING', total: -1, items: [] });
    expect(validateSync(dto).length).toBeGreaterThan(0);
  });
});
