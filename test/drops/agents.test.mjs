import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentAvailability,
  approvalDecision,
  catalogCsv,
  priceAvailability,
} from '../../netlify/functions/lib/drop-agents.mjs';

const drop = {
  id: '001',
  number: '001',
  opensAt: '2026-11-20T12:00:00-06:00',
  price: 24,
  shipping: 6,
  url: 'https://drops.vhsgarage.com',
  agent: {
    sku: 'VG-DROP-001',
    title: 'VHS Garage Originals Drop #001, Mystery VHS Tape',
    description: 'Sold "sight unseen", one run.',
    image: '/images/drops/agent-product.png',
    holdMinutes: 15,
    taxCode: null,
  },
};
const before = new Date('2026-11-01T12:00:00Z');
const after = new Date('2026-11-21T12:00:00Z');

test('agentAvailability: pre-order before the drop, in stock after, out when sold out', () => {
  assert.equal(agentAvailability('available', before, drop.opensAt), 'preorder');
  assert.equal(agentAvailability('available', after, drop.opensAt), 'in_stock');
  assert.equal(agentAvailability('sold-out', before, drop.opensAt), 'out_of_stock');
  // Holds come back, so an all-held run still lists; approval declines meanwhile.
  assert.equal(agentAvailability('all-held', after, drop.opensAt), 'in_stock');
});

test('approvalDecision: one copy of our SKU only', () => {
  const one = [{ sku_id: 'VG-DROP-001', quantity: 1 }];
  assert.deepEqual(approvalDecision(one, drop), { ok: true });
  assert.equal(approvalDecision([{ sku_id: 'VG-DROP-001', quantity: 2 }], drop).ok, false);
  assert.equal(approvalDecision([{ sku_id: 'OTHER', quantity: 1 }], drop).ok, false);
  assert.equal(approvalDecision([], drop).ok, false);
});

test('catalogCsv never sends a copy count', () => {
  const csv = catalogCsv(drop, 'preorder');
  const [header, row] = csv.trim().split('\n');
  const cols = header.split(',');
  const cells = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ''));
  const get = (k) => cells[cols.indexOf(k)];

  assert.ok(!cols.includes('inventory_quantity'));
  assert.equal(get('inventory_not_tracked'), 'true');
  assert.equal(get('id'), 'VG-DROP-001');
  assert.equal(get('availability'), 'preorder');
  assert.equal(get('availability_date'), '2026-11-20');
  assert.equal(get('price'), '24.00 USD');
  assert.equal(get('shipping'), 'US:ALL:Standard Shipping:5-10:6.00 USD');
  assert.equal(get('link'), 'https://drops.vhsgarage.com/');
  assert.equal(get('image_link'), 'https://drops.vhsgarage.com/images/drops/agent-product.png');
  // Quotes in text fields are CSV-escaped.
  assert.equal(get('description'), '"Sold ""sight unseen"", one run."');
});

test('catalogCsv drops the availability date once it is in stock', () => {
  const csv = catalogCsv(drop, 'in_stock');
  const [header, row] = csv.trim().split('\n');
  assert.ok(header.includes('availability_date'));
  assert.ok(!row.includes('2026-11-20'));
});

test('priceAvailability answers with status and price, never quantity', () => {
  const r = priceAvailability(drop, 'acct_1', 'preorder', 1700000000);
  assert.equal(r.sku_id, 'VG-DROP-001');
  assert.equal(r.merchant_id, 'acct_1');
  assert.deepEqual(r.availability, { status: 'preorder', availability_date: '2026-11-20' });
  assert.deepEqual(r.price, { unit_amount: 2400, currency: 'usd' });
  assert.ok(!('quantity' in r.availability));

  const out = priceAvailability(drop, 'acct_1', 'out_of_stock', 1700000000);
  assert.deepEqual(out.availability, { status: 'out_of_stock' });
  assert.ok(!('price' in out));
});
