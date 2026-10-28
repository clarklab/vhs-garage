// drop-agent-catalog — keeps the current drop's listing in Stripe's agent
// catalog (Agentic Commerce Suite) in step with our stock.
//
// Every 15 minutes: work out availability (preorder → in_stock at opensAt
// → out_of_stock when sold out) and upload the one-row product feed when it
// changed, or once a day regardless. The listing never carries a count —
// see catalogCsv().
//
// Off until STRIPE_AGENT_CATALOG=on, so it stays quiet before onboarding.
// Needs the restricted key to have Product Catalog Imports: Write.

import { DROP, getDatabase, stripeClient } from './lib/drops.mjs';
import { catalogCsv, currentAvailability } from './lib/drop-agents.mjs';

export const config = { schedule: '*/15 * * * *' };

const DAY_MS = 24 * 60 * 60 * 1000;

export default async () => {
  if (process.env.STRIPE_AGENT_CATALOG !== 'on') return new Response('agent catalog off');

  try {
    const db = getDatabase();
    const availability = await currentAvailability(db, DROP);
    const [last] = await db.sql`SELECT availability, pushed_at FROM drop_agent_catalog WHERE drop_id = ${DROP.id}`;
    const stale = !last || Date.now() - new Date(last.pushed_at).getTime() > DAY_MS;
    if (last?.availability === availability && !stale) return new Response(`unchanged: ${availability}`);

    await upload(stripeClient(), catalogCsv(DROP, availability), availability);
    await db.sql`
      INSERT INTO drop_agent_catalog (drop_id, availability, pushed_at)
      VALUES (${DROP.id}, ${availability}, NOW())
      ON CONFLICT (drop_id) DO UPDATE SET availability = EXCLUDED.availability, pushed_at = NOW()
    `;
    console.log('[drop-agent-catalog] pushed', DROP.agent.sku, availability);
    return new Response(`pushed: ${availability}`);
  } catch (e) {
    console.error('[drop-agent-catalog] sync failed', e);
    return new Response('sync failed', { status: 500 });
  }
};

async function upload(stripe, csv, availability) {
  const imp = await stripe.v2.commerce.productCatalog.imports.create(
    { feed_type: 'product', mode: 'upsert', metadata: { file_name: `drop-${DROP.id}-${availability}.csv` } },
    { apiVersion: '2026-09-30.preview' },
  );
  const url = imp.status_details?.awaiting_upload?.upload_url?.url;
  if (!url) throw new Error(`catalog import ${imp.id} has no upload URL (status ${imp.status})`);
  const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csv });
  if (!put.ok) throw new Error(`catalog upload failed: HTTP ${put.status}`);
}
