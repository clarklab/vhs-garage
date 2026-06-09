-- Public wishlist of tapes people want us to record. Inserted by
-- netlify/functions/tape-requests.mjs on POST from the /requests page,
-- and read back (most-recent-first) on GET to render the public list.
--
-- This is intentionally low-stakes, fully public, free-form data: anyone
-- can drop a request, anyone can see the list. There's no account, no
-- verified identity — so we keep exactly one required column (the
-- request text) and treat everything else as best-effort context.
--
-- request_text is plain TEXT because it's a single free-form textarea
-- ("the entire Disney Sing-Along Songs run", "my uncle's wedding from
-- '94", "any Goosebumps"). We cap length in the function rather than the
-- schema so the limit can move without a migration.

CREATE TABLE IF NOT EXISTS tape_requests (
  id            SERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The ask itself — the only required field.
  request_text  TEXT NOT NULL,

  -- Best-effort client context, useful only for spotting abuse /
  -- spam bursts. Never shown on the public list.
  user_agent    TEXT
);

-- The public list reads newest-first; the homepage of the feature is
-- "what has everyone asked for lately", so created_at DESC is the one
-- access pattern we optimize for.
CREATE INDEX IF NOT EXISTS tape_requests_created_at_idx
  ON tape_requests (created_at DESC);
