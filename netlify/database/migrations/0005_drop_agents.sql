-- Orders placed by AI shopping agents through Stripe's Agentic Commerce
-- Suite, written by netlify/functions/drop-agent-hook.mjs.
--
-- Agent orders draw on the same drop_stock counter as the website, so the
-- run can't oversell across the two. `channel` says where an order came
-- from. `agent_request_id` is the id of Stripe's order-approval request:
-- agents retry those, and the unique key makes a retry return the same
-- decision instead of claiming a second copy.

ALTER TABLE drop_orders ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'site';
ALTER TABLE drop_orders ADD COLUMN IF NOT EXISTS agent_request_id TEXT UNIQUE;

-- What availability we last sent Stripe's agent catalog for each drop, so
-- the 15-minute sync only uploads when it changes.
CREATE TABLE IF NOT EXISTS drop_agent_catalog (
  drop_id       TEXT PRIMARY KEY REFERENCES drop_stock (drop_id),
  availability  TEXT NOT NULL,
  pushed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
