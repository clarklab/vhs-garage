import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stockStatus,
  sessionOutcome,
  saleKind,
  orderNumber,
  shipTo,
  checkoutParams,
} from '../../netlify/functions/lib/drops.mjs';

const drop = {
  id: '001',
  opensAt: '2026-11-20T12:00:00-06:00',
  quantity: 20,
  price: 24,
  shipping: 6,
  holdMinutes: 10,
  name: 'VHS Garage Originals — Drop 001',
};

test('stockStatus: free copies left means available', () => {
  assert.equal(stockStatus({ quantity: 20, claimed: 19, paid: 12 }), 'available');
});

test('stockStatus: every copy claimed but some only held means all-held', () => {
  assert.equal(stockStatus({ quantity: 20, claimed: 20, paid: 18 }), 'all-held');
});

test('stockStatus: every copy paid means sold-out', () => {
  assert.equal(stockStatus({ quantity: 20, claimed: 20, paid: 20 }), 'sold-out');
});

test('sessionOutcome: complete and paid is paid', () => {
  assert.equal(sessionOutcome({ status: 'complete', payment_status: 'paid' }), 'paid');
});

test('sessionOutcome: expired session releases the copy', () => {
  assert.equal(sessionOutcome({ status: 'expired', payment_status: 'unpaid' }), 'released');
});

test('sessionOutcome: open, or complete but still processing, keeps the hold', () => {
  assert.equal(sessionOutcome({ status: 'open', payment_status: 'unpaid' }), 'pending');
  assert.equal(sessionOutcome({ status: 'complete', payment_status: 'unpaid' }), 'pending');
});

test('saleKind: before opensAt is a pre-order, after is a sale', () => {
  assert.equal(saleKind(new Date('2026-11-20T17:59:59Z'), drop.opensAt), 'preorder');
  assert.equal(saleKind(new Date('2026-11-20T18:00:00Z'), drop.opensAt), 'sale');
});

test('orderNumber pads the row id under the drop number', () => {
  assert.equal(orderNumber('001', 7), 'VG-001-0007');
});

test('shipTo reads city and state from either session shape', () => {
  const address = { city: 'Austin', state: 'TX' };
  assert.equal(shipTo({ collected_information: { shipping_details: { address } } }), 'Austin, TX');
  assert.equal(shipTo({ shipping_details: { address } }), 'Austin, TX');
  assert.equal(shipTo({}), null);
});

test('checkoutParams builds an on-page session with the hold baked in', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const p = checkoutParams({ drop, kind: 'preorder', orderId: 42, origin: 'https://vhsgarage.com', now });

  assert.equal(p.ui_mode, 'elements');
  assert.equal(p.mode, 'payment');
  assert.equal(p.line_items[0].price_data.unit_amount, 2400);
  assert.equal(p.line_items[0].quantity, 1);
  assert.match(p.line_items[0].price_data.product_data.description, /ships when the drop opens/i);
  assert.equal(p.shipping_options[0].shipping_rate_data.fixed_amount.amount, 600);
  assert.deepEqual(p.shipping_address_collection.allowed_countries, ['US']);
  assert.equal(p.return_url, 'https://vhsgarage.com/drops?session_id={CHECKOUT_SESSION_ID}');
  assert.deepEqual(p.metadata, { drop_id: '001', order_id: '42', kind: 'preorder' });
  // Stripe won't expire a session sooner than 30 minutes out.
  assert.ok(p.expires_at >= now.getTime() / 1000 + 30 * 60);
});
