import { getStore } from '@netlify/blobs';

export default async () => {
  const store = getStore('signup-stats');
  const current = await store.get('count', { type: 'text' });
  // Seed with 3 existing signups if store is empty
  const count = (parseInt(current, 10) || 3) + 1;
  await store.set('count', String(count));
  return new Response('OK');
};
