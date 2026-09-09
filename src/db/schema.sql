CREATE TABLE IF NOT EXISTS garment (
  id              TEXT PRIMARY KEY,
  slot            TEXT NOT NULL CHECK (slot IN ('base','top','mid','outer','bottom','shoes','accessory')),
  subtype         TEXT NOT NULL,
  image_original  TEXT NOT NULL,
  image_cutout    TEXT,
  colors          TEXT NOT NULL DEFAULT '[]',
  color_role      TEXT NOT NULL DEFAULT 'neutral' CHECK (color_role IN ('neutral','accent')),
  pattern         TEXT NOT NULL DEFAULT 'solid',
  fabric          TEXT,
  warmth          INTEGER NOT NULL DEFAULT 2 CHECK (warmth BETWEEN 0 AND 5),
  formality       INTEGER NOT NULL DEFAULT 3 CHECK (formality BETWEEN 1 AND 5),
  fit             TEXT CHECK (fit IN ('tight','fitted','regular','relaxed','oversized')),
  structured      INTEGER NOT NULL DEFAULT 0,
  rise            TEXT CHECK (rise IN ('low','mid','high')),
  leg             TEXT CHECK (leg IN ('skinny','tapered','straight','relaxed','wide')),
  hem             TEXT CHECK (hem IN ('above_waist','at_waist','past_waist','hip','below_hip')),
  neckline        TEXT CHECK (neckline IN ('crew','v','open','high','none')),
  sleeves         TEXT CHECK (sleeves IN ('none','short','long')),
  shoulder_bulk   INTEGER NOT NULL DEFAULT 0,
  water_resistant INTEGER NOT NULL DEFAULT 0,
  seasons         TEXT NOT NULL DEFAULT '[]',
  notes           TEXT,
  -- The vision pass guesses warmth and formality. A wrong guess quietly poisons
  -- every recommendation, so a garment stays flagged until it is confirmed by hand.
  reviewed        INTEGER NOT NULL DEFAULT 0,
  uncertain       TEXT NOT NULL DEFAULT '[]',
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS garment_slot ON garment (slot) WHERE archived = 0;

CREATE TABLE IF NOT EXISTS profile (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL,
  -- Where the day's weather is read from when a caller sends none. Columns
  -- rather than fields inside `data`, so a profile write cannot drop them.
  home_lat   REAL,
  home_lon   REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS style_rules (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  source     TEXT,
  markdown   TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wear_log (
  id          TEXT PRIMARY KEY,
  worn_on     TEXT NOT NULL,
  garment_ids TEXT NOT NULL,
  event       TEXT,
  weather     TEXT,
  accepted    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS wear_log_date ON wear_log (worn_on DESC);

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
