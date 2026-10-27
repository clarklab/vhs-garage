// drop-webhook — Stripe tells us a drop checkout finished.
//
// Subscribe the endpoint (/.netlify/functions/drop-webhook) to:
//   checkout.session.completed
//   checkout.session.async_payment_succeeded
//   checkout.session.async_payment_failed
//   checkout.session.expired
//
// Everything routes through settle(), the same reconciliation the
// thank-you page and the stale-hold sweep use, so a late or replayed
// event is harmless.

import { DROP, getDatabase, json, releaseOrder, settle, stripeClient } from './lib/drops.mjs';

const EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

export default async (req) => {
  const stripe = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await req.text(),
      req.headers.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    console.warn('[drop-webhook] bad signature', e.message);
    return json({ error: 'bad-signature' }, 400);
  }

  const session = event.data.object;
  if (!EVENTS.has(event.type) || session.metadata?.drop_id !== DROP.id) return json({ ignored: true });

  try {
    const db = getDatabase();
    if (event.type === 'checkout.session.async_payment_failed') {
      await releaseOrder(db, DROP, Number(session.metadata.order_id));
    } else {
      await settle(db, stripe, DROP, session);
    }
    return json({ received: true });
  } catch (e) {
    // A 500 makes Stripe retry, which is what we want.
    console.error('[drop-webhook] settle failed', event.type, session.id, e);
    return json({ error: 'settle-failed' }, 500);
  }
};
