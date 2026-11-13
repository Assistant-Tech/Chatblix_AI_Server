/**
 * Money contract: commerce amounts from the backend (jobs, events, DB) are integer MINOR
 * units (paisa/cents) plus a `currency`. Format at the boundary before showing a customer
 * or an LLM. Mirrors backend `formatMoney`.
 */
export type Currency = 'NPR' | 'USD';

// Per-tenant currency arrives in a later task; until then default here.
export const DEFAULT_CURRENCY: Currency = 'NPR';

/** "NPR 1,234.56" / "$12.34" from minor units. */
export function formatMoney(minor: number, currency: Currency): string {
  const amount = (minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'USD' ? `$${amount}` : `${currency} ${amount}`;
}
