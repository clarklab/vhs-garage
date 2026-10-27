// drop-stock — is there a copy to buy right now?
//
// GET → { status: 'available' | 'all-held' | 'sold-out' }
//
// Deliberately returns no counts: the page never says how many exist.
// Sweeps expired holds first, so a copy someone walked away from comes
// back on the next page load.

import { DROP, getDatabase, json, readStatus, releaseStale, stripeClient } from './lib/drops.mjs';

export default async () => {
  try {
    const db = getDatabase();
    try {
      await releaseStale(db, stripeClient(), DROP);
    } catch (e) {
      console.error('[drop-stock] stale sweep failed', e);
    }
    return json({ status: await readStatus(db, DROP) });
  } catch (e) {
    console.error('[drop-stock] status failed', e);
    return json({ error: 'stock-unavailable' }, 500);
  }
};
