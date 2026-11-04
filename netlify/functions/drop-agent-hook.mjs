// drop-agent-hook — Stripe's Agentic Commerce hooks for the current drop.
//
// Set this URL (/.netlify/functions/drop-agent-hook) in Dashboard →
// Settings → Agentic Commerce for both:
//   • Order approvals  (v1.delegated_checkout.finalize_checkout)
//     Stripe asks right before it charges an agent's buyer. We claim a copy
//     from the shared stock and approve, or decline. Stripe gives us four
//     seconds and declines the payment itself if we're late, so this path
//     does nothing but the claim.
//   • Product price and availability  (delegated_commerce.product_price_availability)
//     Status and price only — never a quantity.
//
// Requests are signed with the "Agentic Commerce Extension" event
// destination's secret (STRIPE_AGENT_HOOK_SECRET).

import { DROP, getDatabase, json, stripeClient } from './lib/drops.mjs';
import { approvalDecision, claimForAgent, currentAvailability, priceAvailability } from './lib/drop-agents.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  const payload = await req.text();
  try {
    stripeClient().webhooks.signature.verifyHeader(
      payload,
      req.headers.get('stripe-signature'),
      process.env.STRIPE_AGENT_HOOK_SECRET,
    );
  } catch (e) {
    console.warn('[drop-agent-hook] bad signature', e.message);
    return json({ error: 'bad-signature' }, 400);
  }

  const hook = JSON.parse(payload);
  try {
    if (hook.type === 'v1.delegated_checkout.finalize_checkout') return await approve(hook);
    if (hook.type === 'delegated_commerce.product_price_availability') return await availability(hook);
    console.warn('[drop-agent-hook] unhandled hook', hook.type);
    return json({ error: 'unhandled-hook' }, 400);
  } catch (e) {
    console.error('[drop-agent-hook] failed', hook.type, hook.id, e);
    return json({ error: 'hook-failed' }, 500);
  }
};

const decline = (reason) => json({ manual_approval_details: { type: 'declined', declined: { reason } } });

async function approve(hook) {
  const decision = approvalDecision(hook.data?.line_item_details, DROP);
  if (!decision.ok) return decline(decision.reason);

  const order = await claimForAgent(getDatabase(), DROP, hook.id);
  if (!order) return decline("Sold out. When they're gone, they're gone.");

  console.log('[drop-agent-hook] approved', hook.id, 'order', order.id);
  return json({
    manual_approval_details: { type: 'approved' },
    // Copied onto the Checkout Session, so drop-webhook can find the order.
    metadata: { drop_id: DROP.id, order_id: String(order.id), kind: order.kind, channel: 'agent' },
  });
}

async function availability(hook) {
  if (hook.data?.sku_id !== DROP.agent.sku) {
    return json({ sku_id: hook.data?.sku_id, merchant_id: hook.context, deleted: true });
  }
  const status = await currentAvailability(getDatabase(), DROP);
  return json(priceAvailability(DROP, hook.context, status, Math.floor(Date.now() / 1000)));
}
