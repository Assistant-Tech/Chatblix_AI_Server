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

describe('generator EXISTING_ORDER status (finding 3)', () => {
  const svc = new GeneratorService({} as any, {} as any, {} as any, {} as any);
  const order = (o: any) =>
    JSON.parse(
      ((svc as any).buildUserPayload({ ctx: { history: [], existing_order: o }, message: 'hi', triage: {}, feedback: null, customerContext: {} }) as string)
        .split('EXISTING_ORDER: ')[1],
    );

  it('renders one customer-facing status from order + fulfillment + payment status', () => {
    const base = { ref: '#12', total: 100, currency: 'NPR', items: [] };
    expect(order({ ...base, status: 'CONFIRMED', paymentStatus: 'CAPTURED', fulfillmentStatus: 'SHIPPED' }).status).toBe('Confirmed, Shipped, Paid');
    expect(order({ ...base, status: 'PENDING', paymentStatus: 'CAPTURED', fulfillmentStatus: 'NOT_FULFILLED' }).status).toBe('Pending, Paid');
    expect(order({ ...base, status: 'PENDING', paymentStatus: 'NOT_PAID', fulfillmentStatus: 'NOT_FULFILLED' }).status).toBe('Pending');
  });

  it('tolerates older payloads without payment/fulfillment status and unknown values', () => {
    const base = { ref: '#12', total: 100, items: [] };
    expect(order({ ...base, status: 'CONFIRMED' }).status).toBe('Confirmed');
    expect(order({ ...base, status: 'ON_HOLD', paymentStatus: 'WEIRD' }).status).toBe('On Hold');
  });

  it('never hands the raw enum fields to the LLM', () => {
    const o = order({ ref: '#12', status: 'CONFIRMED', paymentStatus: 'CAPTURED', fulfillmentStatus: 'SHIPPED', total: 100, items: [] });
    expect(o).not.toHaveProperty('paymentStatus');
    expect(o).not.toHaveProperty('fulfillmentStatus');
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

describe('ExistingOrderDto payment/fulfillment status (finding 3, rollout-tolerant)', () => {
  const base = { ref: '#12', status: 'CONFIRMED', total: 100, items: [] };
  it('accepts the new optional fields', () => {
    const dto = plainToInstance(ExistingOrderDto, { ...base, paymentStatus: 'CAPTURED', fulfillmentStatus: 'SHIPPED' });
    expect(validateSync(dto)).toEqual([]);
    expect(dto).toMatchObject({ paymentStatus: 'CAPTURED', fulfillmentStatus: 'SHIPPED' });
  });
  it('accepts an older backend payload without them', () => {
    expect(validateSync(plainToInstance(ExistingOrderDto, base))).toEqual([]);
  });
  it('rejects values outside the backend enums', () => {
    expect(validateSync(plainToInstance(ExistingOrderDto, { ...base, paymentStatus: 'PAID' })).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(ExistingOrderDto, { ...base, fulfillmentStatus: 'LOST' })).length).toBeGreaterThan(0);
  });
});
