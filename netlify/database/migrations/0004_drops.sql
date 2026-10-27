-- Stock and orders for VHS Garage Originals drops, written by the drop-*
-- functions through netlify/functions/lib/drops.mjs.
--
-- drop_stock holds one row per drop. `claimed` counts every copy that's
-- held in someone's checkout or paid for; claiming is a conditional
-- `UPDATE ... WHERE claimed < quantity`, which is what keeps two buyers
-- from both getting the last copy. `quantity` follows src/data/drop.js.

CREATE TABLE IF NOT EXISTS drop_stock (
  drop_id   TEXT PRIMARY KEY,
  quantity  INTEGER NOT NULL,
  claimed   INTEGER NOT NULL DEFAULT 0 CHECK (claimed >= 0)
);

-- One row per checkout. A row starts 'held' when its copy is claimed, then
-- becomes 'paid' once Stripe confirms payment, or 'released' once Stripe
-- confirms the session expired and the copy goes back on sale.
CREATE TABLE IF NOT EXISTS drop_orders (
  id            SERIAL PRIMARY KEY,
  drop_id       TEXT NOT NULL REFERENCES drop_stock (drop_id),
  session_id    TEXT UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('preorder', 'sale')),
  status        TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'paid', 'released')),
  held_until    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at       TIMESTAMPTZ,
  released_at   TIMESTAMPTZ,

  -- Filled in from the Stripe session when it's paid, for packing slips.
  email         TEXT,
  ship_to       TEXT,
  amount_total  INTEGER
);

-- The stale-hold sweep runs before every stock read.
CREATE INDEX IF NOT EXISTS drop_orders_held_idx
  ON drop_orders (drop_id, held_until) WHERE status = 'held';
