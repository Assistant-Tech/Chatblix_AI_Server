import type { BusinessProfileDto } from '../../types/business-profile.dto';

/**
 * Result of the order-grounding check. When `ok` is false the caller must NOT
 * ship the confirmation (it promises delivery of a product we can't ground).
 */
export type OrderGroundingResult = { ok: true } | { ok: false; product: string | null };

/**
 * Lenient product-name match mirroring main-backend's case-insensitive `contains`
 * resolution (see InternalToolsService.placeOrder): true when either name
 * contains the other. Keeps the ai-backend gate consistent with what placeOrder
 * can actually resolve, so we don't block orders main-backend would have placed.
 */
export function fuzzyProductMatch(catalogName: string | undefined | null, quoted: string): boolean {
  if (!catalogName) return false;
  const a = catalogName.trim().toLowerCase();
  const b = quoted.trim().toLowerCase();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/** Parses the `<metadata>{…}</metadata>` block of a shipped candidate, or null. */
export function extractMetadataObject(shipped: string): Record<string, any> | null {
  const m = /<metadata>([\s\S]*?)<\/metadata>/i.exec(shipped);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1].trim());
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic backstop against phantom-order confirmations.
 *
 * Returns `{ ok: false }` when the shipped metadata claims `order_confirmed: true`
 * for a product we cannot ground, where "grounded" means EITHER:
 *   - a `stock_check` tool ran this turn (the quote came from verified data), OR
 *   - the confirmed product fuzzy-matches an entry in the tenant's catalog.
 *
 * Turns that don't confirm an order always return `{ ok: true }`. Pure function —
 * no I/O — so it's cheap to run on every shipped reply and easy to unit-test.
 */
export function checkOrderGrounding(
  shipped: string,
  profile: Pick<BusinessProfileDto, 'product_catalog'>,
  toolsCalled: string[],
): OrderGroundingResult {
  const meta = extractMetadataObject(shipped);
  if (!meta || meta.order_confirmed !== true) return { ok: true };

  // A verified stock_check this turn means the quoted product/price came from real
  // data — trust the confirmation.
  if (toolsCalled.includes('stock_check')) return { ok: true };

  const extracted = (meta.extracted_data ?? {}) as Record<string, unknown>;
  const product =
    typeof extracted.product_interest === 'string' ? extracted.product_interest.trim() : null;

  const catalog = profile.product_catalog ?? [];
  if (product && catalog.length > 0 && catalog.some((p) => fuzzyProductMatch(p.name, product))) {
    return { ok: true };
  }

  return { ok: false, product };
}
