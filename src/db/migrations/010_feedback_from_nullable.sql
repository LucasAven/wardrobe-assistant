-- `from_id` was NOT NULL because every correction took a garment out. A piece
-- added to a slot the outfit never had takes nothing out, and there is nothing
-- honest to write there. `to_id` has been nullable for the drop since 004, so
-- this is the same widening in the other direction.
--
-- SQLite cannot drop a NOT NULL with ALTER TABLE, so this is the first table
-- rebuild in this repo rather than a one-line change. Nothing in this schema
-- declares a foreign key, the same fact 009 records, so the rename retargets
-- nothing and the copy is the whole of the risk.
--
-- The CHECK is new to this table. It puts in storage the rule the route already
-- holds at its boundary: a row that names neither garment records no change at
-- all, and there is no reader that could make sense of one.
--
-- Apply this before the deploy. Widening is invisible to the worker running
-- now, because it never writes a null `from_id` and never reads one. The other
-- order has a real window where the new worker's first add fails the NOT NULL,
-- and D1 batches atomically, so the outfit write goes down with the reason.
--
-- scripts/migrate.sh runs a file as one `d1 execute` with no transaction and
-- records it only on success, so a failure between the DROP and the RENAME
-- leaves no table and no ledger row. That is sized against one stored row here,
-- which is an INSERT replayed by hand. At a few thousand rows, split create and
-- copy into one file and drop and rename into the next, so each ledger entry
-- covers one destructive step.
CREATE TABLE outfit_feedback_new (
  id         TEXT PRIMARY KEY,
  outfit_id  TEXT NOT NULL,
  slot       TEXT NOT NULL,
  -- Null when the owner added a piece the outfit never had.
  from_id    TEXT,
  -- Null when the owner dropped the layer instead of replacing it.
  to_id      TEXT,
  reason     TEXT NOT NULL,
  -- ISO, the same convention `insertOutfit` binds, so the first ten characters
  -- are the UTC day the wear log writes.
  created_at TEXT NOT NULL,
  CHECK (from_id IS NOT NULL OR to_id IS NOT NULL)
);

INSERT INTO outfit_feedback_new (id, outfit_id, slot, from_id, to_id, reason, created_at)
SELECT id, outfit_id, slot, from_id, to_id, reason, created_at FROM outfit_feedback;

DROP TABLE outfit_feedback;

ALTER TABLE outfit_feedback_new RENAME TO outfit_feedback;

-- Dropping the old table took both of these with it.
CREATE INDEX IF NOT EXISTS outfit_feedback_outfit ON outfit_feedback (outfit_id);
CREATE INDEX IF NOT EXISTS outfit_feedback_created ON outfit_feedback (created_at DESC);
