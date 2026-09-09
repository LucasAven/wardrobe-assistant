-- Where the day's weather is read from when a caller sends none. Columns
-- rather than fields inside `data`, so a profile write cannot drop them.
ALTER TABLE profile ADD COLUMN home_lat REAL;
ALTER TABLE profile ADD COLUMN home_lon REAL;

-- One outfit composed in the Claude app and certified against the plan it came
-- from. Rules are stored as ids: the book's own sentence lives in
-- `src/domain/bookRules.ts` and is read back from there, so it is never copied.
CREATE TABLE IF NOT EXISTS outfit (
  id                TEXT PRIMARY KEY,
  plan_id           TEXT NOT NULL,
  event             TEXT,
  -- JSON [{"slot":"base","id":"..."}], base to shoes then accessories.
  pieces            TEXT NOT NULL,
  rationale         TEXT NOT NULL,
  cited_rules       TEXT NOT NULL DEFAULT '[]',
  missed_rules      TEXT NOT NULL DEFAULT '[]',
  warmth_core       INTEGER NOT NULL,
  warmth_with_outer INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS outfit_created ON outfit (created_at DESC);
