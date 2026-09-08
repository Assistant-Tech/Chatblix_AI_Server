import { checkOrderGrounding, fuzzyProductMatch } from './order-grounding';
import type { BusinessProfileDto } from '../../types/business-profile.dto';

const meta = (obj: Record<string, unknown>) =>
  `<reply>ok</reply><metadata>${JSON.stringify(obj)}</metadata>`;

const profileWith = (catalog: Array<{ name: string }>): Pick<BusinessProfileDto, 'product_catalog'> =>
  ({ product_catalog: catalog as BusinessProfileDto['product_catalog'] });

describe('checkOrderGrounding', () => {
  it('blocks the phantom-order incident: order_confirmed for a product with no catalog and no stock_check', () => {
    // Reproduces conv f70cb2ec… — "Neem Face Wash" confirmed with an empty catalog.
    const shipped = meta({
      order_confirmed: true,
      extracted_data: { product_interest: 'Neem Face Wash' },
    });
    const res = checkOrderGrounding(shipped, profileWith([]), []);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ ok: false, product: 'Neem Face Wash' });
  });

  it('allows the confirmation when a stock_check ran this turn', () => {
    const shipped = meta({
      order_confirmed: true,
      extracted_data: { product_interest: 'Neem Face Wash' },
    });
    expect(checkOrderGrounding(shipped, profileWith([]), ['stock_check']).ok).toBe(true);
  });

  it('allows the confirmation when the product is in the catalog (fuzzy match)', () => {
    const shipped = meta({
      order_confirmed: true,
      extracted_data: { product_interest: 'Neem Face Wash' },
    });
    const catalog = [{ name: 'Neem Face Wash 100ml' }];
    expect(checkOrderGrounding(shipped, profileWith(catalog), []).ok).toBe(true);
  });

  it('blocks when the catalog exists but the confirmed product is not in it', () => {
    const shipped = meta({
      order_confirmed: true,
      extracted_data: { product_interest: 'Neem Face Wash' },
    });
    const catalog = [{ name: 'Green Tea Mask' }];
    expect(checkOrderGrounding(shipped, profileWith(catalog), []).ok).toBe(false);
  });

  it('is a no-op on turns that do not confirm an order', () => {
    const shipped = meta({ order_confirmed: false, extracted_data: { product_interest: 'Neem Face Wash' } });
    expect(checkOrderGrounding(shipped, profileWith([]), []).ok).toBe(true);
    expect(checkOrderGrounding(meta({ stage: 'warm' }), profileWith([]), []).ok).toBe(true);
  });

  it('is a no-op when metadata is missing or malformed', () => {
    expect(checkOrderGrounding('<reply>hi</reply>', profileWith([]), []).ok).toBe(true);
    expect(checkOrderGrounding('<reply>hi</reply><metadata>{not json</metadata>', profileWith([]), []).ok).toBe(true);
  });

  it('blocks a confirmation with no product named at all', () => {
    const shipped = meta({ order_confirmed: true, extracted_data: {} });
    const res = checkOrderGrounding(shipped, profileWith([]), []);
    expect(res).toMatchObject({ ok: false, product: null });
  });
});

describe('fuzzyProductMatch', () => {
  it('matches either-direction substrings, case-insensitively', () => {
    expect(fuzzyProductMatch('Neem Face Wash 100ml', 'neem face wash')).toBe(true);
    expect(fuzzyProductMatch('Neem Soap', 'Neem Soap')).toBe(true);
    expect(fuzzyProductMatch('Green Tea Mask', 'Neem Soap')).toBe(false);
  });

  it('is false for empty/nullish names', () => {
    expect(fuzzyProductMatch(null, 'x')).toBe(false);
    expect(fuzzyProductMatch('  ', 'x')).toBe(false);
    expect(fuzzyProductMatch('x', '')).toBe(false);
  });
});
