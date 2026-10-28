// drop-agents — selling the current drop through AI shopping agents with
// Stripe's Agentic Commerce Suite.
//
// Stripe runs the agent's checkout. We hold the stock decision: Stripe's
// order-approval hook asks us right before it charges, and we claim a copy
// from the same drop_stock counter the website uses (lib/drops.mjs), so the
// run can't oversell across channels. The listing we send Stripe marks
// inventory as untracked and never carries a count — availability is only
// ever a status word.

import { claim, readStatus, saleKind } from './drops.mjs';

// ---- Pure helpers (tested) ----------------------------------------------

export function agentAvailability(status, now, opensAt) {
  if (status === 'sold-out') return 'out_of_stock';
  return saleKind(now, opensAt) === 'preorder' ? 'preorder' : 'in_stock';
}

// The drop is one copy per order of one product.
export function approvalDecision(lineItems, drop) {
  if (!lineItems?.length) return { ok: false, reason: 'No items in this order.' };
  if (lineItems.some((li) => li.sku_id !== drop.agent.sku)) return { ok: false, reason: 'Unknown product.' };
  const qty = lineItems.reduce((n, li) => n + (li.quantity ?? 0), 0);
  if (qty !== 1) return { ok: false, reason: 'One per order.' };
  return { ok: true };
}

const openDate = (drop) => drop.opensAt.slice(0, 10);
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One-row product feed for Stripe's catalog import. `inventory_not_tracked`
// is true so no inventory_quantity is ever sent.
export function catalogCsv(drop, availability) {
  const row = {
    id: drop.agent.sku,
    title: drop.agent.title,
    description: drop.agent.description,
    link: `${drop.url}/`,
    image_link: `${drop.url}${drop.agent.image}`,
    brand: 'VHS Garage',
    mpn: drop.agent.sku,
    condition: 'new',
    product_category: 'Media > DVDs & Videos',
    availability,
    availability_date: availability === 'preorder' ? openDate(drop) : '',
    inventory_not_tracked: 'true',
    price: `${drop.price.toFixed(2)} USD`,
    shipping: `US:ALL:Standard Shipping:5-10:${drop.shipping.toFixed(2)} USD`,
    stripe_product_tax_code: drop.agent.taxCode ?? '',
  };
  const keys = Object.keys(row);
  return `${keys.join(',')}\n${keys.map((k) => csvCell(row[k])).join(',')}\n`;
}

// Reply to Stripe's product price and availability hook.
export function priceAvailability(drop, merchantId, availability, asOf) {
  const reply = { sku_id: drop.agent.sku, merchant_id: merchantId, availability: { status: availability }, as_of: asOf };
  if (availability === 'preorder') reply.availability.availability_date = openDate(drop);
  if (availability !== 'out_of_stock') reply.price = { unit_amount: drop.price * 100, currency: 'usd' };
  return reply;
}

// ---- Stock -------------------------------------------------------------

// Claim a copy for an approval request. Agents retry, so the request id is
// the idempotency key: a retry gets the same order back, never a 2nd copy.
export async function claimForAgent(db, drop, requestId, now = new Date()) {
  const [existing] = await db.sql`
    SELECT id, kind, status FROM drop_orders WHERE agent_request_id = ${requestId}
  `;
  if (existing) return existing.status === 'released' ? null : existing;

  const kind = saleKind(now, drop.opensAt);
  const order = await claim(db, { ...drop, holdMinutes: drop.agent.holdMinutes }, kind, {
    channel: 'agent',
    agentRequestId: requestId,
  });
  return order ? { ...order, kind } : null;
}

export async function currentAvailability(db, drop, now = new Date()) {
  return agentAvailability(await readStatus(db, drop), now, drop.opensAt);
}
