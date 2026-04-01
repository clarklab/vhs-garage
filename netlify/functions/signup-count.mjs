import { getStore } from '@netlify/blobs';

export default async () => {
  const store = getStore('signup-stats');
  const current = await store.get('count', { type: 'text' });
  const count = parseInt(current, 10) || 3;
  return new Response(JSON.stringify({ count }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
