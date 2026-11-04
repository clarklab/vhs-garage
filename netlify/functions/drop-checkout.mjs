// drop-checkout — open or end an on-page checkout for the current drop.
//
// POST { action: 'start', fulfillment?: 'ship' | 'pickup' }
//   → claims a copy, holds it for DROP.holdMinutes, and creates a Stripe
//     Checkout Session (ui_mode: elements) for the /drops checkout sheet:
//     { clientSecret, sessionId, heldUntil, kind, fulfillment, publishableKey }
//     'pickup' is free local pickup in Austin: no address, no shipping.
//   → 409 { status } when nothing's left to claim ('all-held' / 'sold-out').
//   Before opensAt it's a pre-order; after, a sale. The server decides.
//
// POST { action: 'switch', sessionId, fulfillment }
//   → swaps ship ↔ pickup for the same held copy: a new session, the same
//     hold and timer. 410 if the hold already ran out.
//
// POST { action: 'release', sessionId }
//   → ends that checkout (hold ran out, sheet closed) and gives the copy
//     back — unless it was just paid, in which case the payment is kept.
//     Sent with sendBeacon on page exit, so the body may arrive as text.

import {
  DROP,
  attachSession,
  checkoutParams,
  claim,
  expireAndSettle,
  getDatabase,
  json,
  readStatus,
  releaseOrder,
  releaseStale,
  saleKind,
  stripeClient,
} from './lib/drops.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  let body;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({ error: 'invalid-json' }, 400);
  }

  try {
    const db = getDatabase();
    const stripe = stripeClient();
    const fulfillment = body?.fulfillment === 'pickup' ? 'pickup' : 'ship';
    if (body?.action === 'start') return await start(req, db, stripe, fulfillment);
    if (body?.action === 'switch') return await switchFulfillment(req, db, stripe, body.sessionId, fulfillment);
    if (body?.action === 'release') return await release(db, stripe, body.sessionId);
    return json({ error: 'unknown-action' }, 400);
  } catch (e) {
    console.error('[drop-checkout] failed', e);
    return json({ error: 'checkout-unavailable' }, 500);
  }
};

async function start(req, db, stripe, fulfillment) {
  try {
    await releaseStale(db, stripe, DROP);
  } catch (e) {
    console.error('[drop-checkout] stale sweep failed', e);
  }

  const now = new Date();
  const kind = saleKind(now, DROP.opensAt);
  const order = await claim(db, DROP, kind);
  if (!order) return json({ status: await readStatus(db, DROP) }, 409);

  let session;
  try {
    session = await stripe.checkout.sessions.create(
      checkoutParams({ drop: DROP, kind, orderId: order.id, origin: new URL(req.url).origin, now, fulfillment }),
    );
    await attachSession(db, order.id, session.id);
  } catch (e) {
    console.error('[drop-checkout] session create failed; giving the copy back', e);
    await releaseOrder(db, DROP, order.id);
    return json({ error: 'checkout-failed' }, 502);
  }

  return json({
    clientSecret: session.client_secret,
    sessionId: session.id,
    heldUntil: order.held_until,
    kind,
    fulfillment,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  });
}

// Ship ↔ pickup changes the session's shape (address, shipping charge), so
// it takes a new session — for the same held copy, keeping its hold timer.
async function switchFulfillment(req, db, stripe, sessionId, fulfillment) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return json({ error: 'invalid-session' }, 400);
  }
  const [order] = await db.sql`
    SELECT id, kind, held_until FROM drop_orders
    WHERE session_id = ${sessionId} AND status = 'held' AND held_until > NOW()
  `;
  if (!order) return json({ error: 'hold-expired' }, 410);

  const session = await stripe.checkout.sessions.create(
    checkoutParams({ drop: DROP, kind: order.kind, orderId: order.id, origin: new URL(req.url).origin, now: new Date(), fulfillment }),
  );
  // Point the order at the new session before ending the old one, so the old
  // session's expiry can't give this copy back.
  const moved = await db.sql`
    UPDATE drop_orders SET session_id = ${session.id}
    WHERE id = ${order.id} AND session_id = ${sessionId} AND status = 'held'
    RETURNING id
  `;
  if (!moved.length) {
    await stripe.checkout.sessions.expire(session.id).catch((e) => console.warn('[drop-checkout] expire skipped', e.message));
    return json({ error: 'hold-changed' }, 409);
  }
  await stripe.checkout.sessions.expire(sessionId).catch((e) => console.warn('[drop-checkout] expire skipped', sessionId, e.message));

  return json({
    clientSecret: session.client_secret,
    sessionId: session.id,
    heldUntil: order.held_until,
    kind: order.kind,
    fulfillment,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  });
}

async function release(db, stripe, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    return json({ error: 'invalid-session' }, 400);
  }
  const { outcome } = await expireAndSettle(db, stripe, DROP, sessionId);
  return json({ outcome });
}
