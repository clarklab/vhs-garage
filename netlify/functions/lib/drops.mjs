// drops — stock, holds and Stripe checkout for VHS Garage Originals drops.
//
// Stock lives in Netlify Database: one drop_stock row per drop whose
// `claimed` counter covers every copy that's held or paid, and one
// drop_orders row per checkout. Claiming a copy is a single conditional
// UPDATE (`claimed < quantity`), so two buyers racing for the last copy
// can't both win — Postgres serializes the row update and re-checks the
// condition for the loser.
//
// Stripe is the source of truth for whether a checkout was paid. A hold is
// only given back after Stripe confirms its session expired, so a copy is
// never freed while someone can still pay for it. settle() reconciles one
// order against its session; the webhook, the thank-you page and the stale
// sweep all funnel through it, so the system stays right even if a webhook
// never arrives.

import Stripe from 'stripe';
import { getDatabase } from '@netlify/database';
import { DROP } from '../../../src/data/drop.js';

export { DROP, getDatabase };

// Stripe refuses to expire a Checkout Session sooner than 30 minutes out;
// our own hold is shorter and we expire the session ourselves.
const STRIPE_MIN_EXPIRY_MINUTES = 31;

export function stockStatus({ quantity, claimed, paid }) {
  if (claimed < quantity) return 'available';
  return paid >= quantity ? 'sold-out' : 'all-held';
}

export function sessionOutcome(session) {
  if (session.status === 'expired') return 'released';
  if (session.status === 'complete' && session.payment_status !== 'unpaid') return 'paid';
  return 'pending';
}

export function saleKind(now, opensAt) {
  return now.getTime() < new Date(opensAt).getTime() ? 'preorder' : 'sale';
}

export function orderNumber(dropId, id) {
  return `VG-${dropId}-${String(id).padStart(4, '0')}`;
}

export function shipTo(session) {
  const address =
    session.collected_information?.shipping_details?.address ?? session.shipping_details?.address;
  if (!address?.city) return null;
  return [address.city, address.state].filter(Boolean).join(', ');
}

export function checkoutParams({ drop, kind, orderId, origin, now }) {
  return {
    ui_mode: 'elements',
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: drop.price * 100,
          product_data: {
            name: drop.name,
            description: kind === 'preorder' ? 'Pre-order. Ships when the drop opens.' : 'One run, no restocks.',
          },
        },
      },
    ],
    shipping_address_collection: { allowed_countries: ['US'] },
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: 'Shipping',
          fixed_amount: { amount: drop.shipping * 100, currency: 'usd' },
        },
      },
    ],
    expires_at: Math.floor(now.getTime() / 1000) + STRIPE_MIN_EXPIRY_MINUTES * 60,
    // On drops.vhsgarage.com the page is the site root; elsewhere (the main
    // domain, deploy previews) it's /drops/.
    return_url: `${origin}${new URL(origin).hostname.startsWith('drops.') ? '/' : '/drops/'}?session_id={CHECKOUT_SESSION_ID}`,
    metadata: { drop_id: drop.id, order_id: String(orderId), kind },
    payment_intent_data: { metadata: { drop_id: drop.id, order_id: String(orderId), kind } },
  };
}

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key);
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ---- Stock -------------------------------------------------------------

// The stock row follows the config: changing `quantity` in drop.js takes
// effect on the next request.
async function ensureStock(db, drop) {
  await db.sql`
    INSERT INTO drop_stock (drop_id, quantity)
    VALUES (${drop.id}, ${drop.quantity})
    ON CONFLICT (drop_id) DO UPDATE SET quantity = EXCLUDED.quantity
  `;
}

export async function readStatus(db, drop) {
  await ensureStock(db, drop);
  const [row] = await db.sql`
    SELECT s.quantity, s.claimed,
      (SELECT COUNT(*)::int FROM drop_orders o
        WHERE o.drop_id = s.drop_id AND o.status = 'paid') AS paid
    FROM drop_stock s
    WHERE s.drop_id = ${drop.id}
  `;
  return stockStatus(row);
}

// Claim one copy and open a held order for it. Returns null when there's
// nothing left to claim.
export async function claim(db, drop, kind) {
  await ensureStock(db, drop);
  const won = await db.sql`
    UPDATE drop_stock SET claimed = claimed + 1
    WHERE drop_id = ${drop.id} AND claimed < quantity
    RETURNING claimed
  `;
  if (!won.length) return null;
  try {
    const [order] = await db.sql`
      INSERT INTO drop_orders (drop_id, kind, held_until)
      VALUES (${drop.id}, ${kind}, NOW() + make_interval(mins => ${drop.holdMinutes}))
      RETURNING id, held_until
    `;
    return order;
  } catch (e) {
    await giveBack(db, drop);
    throw e;
  }
}

async function giveBack(db, drop) {
  await db.sql`
    UPDATE drop_stock SET claimed = claimed - 1
    WHERE drop_id = ${drop.id} AND claimed > 0
  `;
}

export async function attachSession(db, orderId, sessionId) {
  await db.sql`UPDATE drop_orders SET session_id = ${sessionId} WHERE id = ${orderId}`;
}

// Give a held order's copy back. A no-op for orders that are already paid
// or released, so every caller can retry freely.
export async function releaseOrder(db, drop, orderId) {
  const released = await db.sql`
    UPDATE drop_orders SET status = 'released', released_at = NOW()
    WHERE id = ${orderId} AND status = 'held'
    RETURNING id
  `;
  if (released.length) await giveBack(db, drop);
}

async function markPaid(db, drop, session) {
  const email = session.customer_details?.email ?? null;
  const paid = await db.sql`
    UPDATE drop_orders
    SET status = 'paid', paid_at = NOW(), email = ${email},
        ship_to = ${shipTo(session)}, amount_total = ${session.amount_total ?? null}
    WHERE session_id = ${session.id} AND status = 'held'
    RETURNING id
  `;
  if (paid.length) return;

  const [order] = await db.sql`SELECT id, status FROM drop_orders WHERE session_id = ${session.id}`;
  if (order?.status !== 'released') return; // already paid — nothing to do
  // Should be impossible (holds are only released once Stripe says the
  // session expired), but if it happens the buyer paid, so take a copy back.
  console.error('[drops] paid session whose hold was already released', session.id);
  const won = await db.sql`
    UPDATE drop_stock SET claimed = claimed + 1
    WHERE drop_id = ${drop.id} AND claimed < quantity
    RETURNING claimed
  `;
  if (!won.length) console.error('[drops] OVERSOLD: no copy left for paid session', session.id);
  await db.sql`
    UPDATE drop_orders SET status = 'paid', paid_at = NOW(), email = ${email}
    WHERE id = ${order.id}
  `;
}

// ---- Reconciling with Stripe ---------------------------------------------

export async function settle(db, stripe, drop, sessionOrId) {
  const session =
    typeof sessionOrId === 'string' ? await stripe.checkout.sessions.retrieve(sessionOrId) : sessionOrId;
  const outcome = sessionOutcome(session);
  if (outcome === 'paid') {
    await markPaid(db, drop, session);
  } else if (outcome === 'released') {
    const [order] = await db.sql`SELECT id FROM drop_orders WHERE session_id = ${session.id}`;
    if (order) await releaseOrder(db, drop, order.id);
  }
  return { session, outcome };
}

// End a checkout early (hold ran out, buyer closed the sheet) and settle it.
// Expiring a session that was just paid fails, and settle() then records
// the payment instead.
export async function expireAndSettle(db, stripe, drop, sessionId) {
  try {
    await stripe.checkout.sessions.expire(sessionId);
  } catch (e) {
    console.warn('[drops] expire skipped', sessionId, e.message);
  }
  return settle(db, stripe, drop, sessionId);
}

// Sweep holds that ran past their time. Runs before every stock read and
// claim, so a walked-away buyer's copy comes back on the next page load.
export async function releaseStale(db, stripe, drop) {
  const stale = await db.sql`
    SELECT id, session_id FROM drop_orders
    WHERE drop_id = ${drop.id} AND status = 'held' AND held_until < NOW()
    ORDER BY held_until
    LIMIT 10
  `;
  for (const order of stale) {
    try {
      if (order.session_id) await expireAndSettle(db, stripe, drop, order.session_id);
      else await releaseOrder(db, drop, order.id);
    } catch (e) {
      console.error('[drops] stale hold not released', order.id, e);
    }
  }
}

export async function findOrder(db, sessionId) {
  const [order] = await db.sql`
    SELECT id, kind, status, email, ship_to, amount_total
    FROM drop_orders WHERE session_id = ${sessionId}
  `;
  return order ?? null;
}
