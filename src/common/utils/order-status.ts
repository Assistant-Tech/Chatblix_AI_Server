// Backend enums (chatblix backend prisma/schema/orders.prisma).
export const PAYMENT_STATUSES = [
  'NOT_PAID', 'AWAITING', 'AUTHORIZED', 'PARTIALLY_CAPTURED', 'CAPTURED',
  'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED', 'REQUIRES_ACTION',
] as const;
export const FULFILLMENT_STATUSES = [
  'NOT_FULFILLED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'PARTIALLY_SHIPPED',
  'SHIPPED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED',
] as const;

// Same words as chatblix_chat_agent OrderRow.label, so both bots describe an order alike.
const ORDER_WORDS: Record<string, string> = {
  DRAFT: 'Draft', PENDING: 'Pending', CONFIRMED: 'Confirmed', COMPLETED: 'Completed',
  CANCELLED: 'Cancelled', ARCHIVED: 'Archived',
};
const FULFILLMENT_WORDS: Record<string, string> = {
  PARTIALLY_FULFILLED: 'Partially packed', FULFILLED: 'Packed', PARTIALLY_SHIPPED: 'Partially shipped',
  SHIPPED: 'Shipped', PARTIALLY_DELIVERED: 'Partially delivered', DELIVERED: 'Delivered',
};
const PAYMENT_WORDS: Record<string, string> = {
  AUTHORIZED: 'Payment authorized', PARTIALLY_CAPTURED: 'Partially paid', CAPTURED: 'Paid',
  PARTIALLY_REFUNDED: 'Partially refunded', REFUNDED: 'Refunded', REQUIRES_ACTION: 'Payment needs action',
};

const titleWords = (s: string) =>
  s.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Customer-facing status from order + fulfillment + payment status, e.g. "Confirmed, Shipped, Paid". */
export function orderStatusLabel(status: string, paymentStatus?: string, fulfillmentStatus?: string): string {
  const parts = [
    ORDER_WORDS[status] ?? titleWords(status),
    fulfillmentStatus ? FULFILLMENT_WORDS[fulfillmentStatus] : undefined,
    paymentStatus ? PAYMENT_WORDS[paymentStatus] : undefined,
  ];
  return parts.filter(Boolean).join(', ');
}
