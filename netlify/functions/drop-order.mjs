// drop-order — what the thank-you screen shows after Stripe sends a buyer
// back to /drops?session_id=….
//
// GET ?session_id=cs_… → { status, kind, orderNumber, email, shipTo, total }
//   status: 'paid' | 'pending' | 'released'
//
// Settles the order against Stripe on the way, so a paid order is recorded
// even if the webhook is slow or never arrives.

import { DROP, findOrder, getDatabase, json, orderNumber, settle, shipTo, stripeClient } from './lib/drops.mjs';

export default async (req) => {
  const sessionId = new URL(req.url).searchParams.get('session_id');
  if (!sessionId?.startsWith('cs_')) return json({ error: 'invalid-session' }, 400);

  try {
    const db = getDatabase();
    const { session, outcome } = await settle(db, stripeClient(), DROP, sessionId);
    const order = await findOrder(db, sessionId);
    if (!order) return json({ error: 'not-found' }, 404);
    return json({
      status: outcome,
      kind: order.kind,
      orderNumber: orderNumber(DROP.id, order.id),
      email: session.customer_details?.email ?? order.email,
      shipTo: shipTo(session) ?? order.ship_to,
      total: session.amount_total,
    });
  } catch (e) {
    console.error('[drop-order] lookup failed', sessionId, e);
    return json({ error: 'order-unavailable' }, 500);
  }
};
