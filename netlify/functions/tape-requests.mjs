// tape-requests — the public tape wishlist, backed by Netlify Database.
//
// Two verbs on one endpoint (/.netlify/functions/tape-requests):
//
//   GET   → returns the list of requests, newest-first, as
//           { requests: [{ id, text, createdAt }, ...] }.
//   POST  → inserts one request from the /requests form body
//           ({ text }) and returns the created row.
//
// Like log-upload.mjs this is a regular Node function (not an edge
// function) because @netlify/database is Node-only — Edge runs Deno and
// can't import it.
//
// Trust model: this is fully public, anonymous, free-form input. We
// don't verify who's asking. The only defenses are (1) a hard length
// cap so the table can't be flooded with a megabyte of text per row,
// and (2) trimming/empty-rejection so the list doesn't fill with blanks.
// The stored user_agent is best-effort context for spotting spam bursts
// later; it's never returned to the client.

import { getDatabase } from '@netlify/database';

// Keep this in sync with the maxlength on the <textarea> in
// src/pages/requests.astro. The client enforces it for UX; we enforce
// it here because the client can't be trusted.
const MAX_LEN = 500;

// How many requests the public list shows. The page is a casual
// "here's what folks want" list, not an archive — newest 200 is plenty
// and keeps the GET payload small.
const LIST_LIMIT = 200;

export default async (req) => {
  if (req.method === 'GET') {
    return await listRequests();
  }
  if (req.method === 'POST') {
    return await createRequest(req);
  }
  return json({ error: 'GET or POST required' }, 405);
};

async function listRequests() {
  try {
    const db = getDatabase();
    const rows = await db.sql`
      SELECT id, request_text, created_at
      FROM tape_requests
      ORDER BY created_at DESC
      LIMIT ${LIST_LIMIT}
    `;
    const requests = rows.map((r) => ({
      id: r.id,
      text: r.request_text,
      createdAt: r.created_at,
    }));
    return json({ requests });
  } catch (e) {
    console.warn('[tape-requests] list failed:', e.message);
    return json({ error: 'db-error', detail: e.message }, 500);
  }
}

async function createRequest(req) {
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'invalid-json' }, 400); }

  // Trim, collapse the empty case, and clamp length. We store at most
  // MAX_LEN chars regardless of what the client sent.
  const text = String(body?.text ?? '').trim().slice(0, MAX_LEN);
  if (!text) {
    return json({ error: 'empty-request' }, 400);
  }

  const userAgent = req.headers.get('user-agent') || null;

  try {
    const db = getDatabase();
    const [row] = await db.sql`
      INSERT INTO tape_requests (request_text, user_agent)
      VALUES (${text}, ${userAgent})
      RETURNING id, request_text, created_at
    `;
    return json({
      request: {
        id: row.id,
        text: row.request_text,
        createdAt: row.created_at,
      },
    }, 201);
  } catch (e) {
    console.warn('[tape-requests] insert failed:', e.message);
    return json({ error: 'db-error', detail: e.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
