-- One correction the owner made to an outfit Claude composed, in their own
-- words. Garments are ids here for the same reason they are ids in `outfit`:
-- the wardrobe is their one home, so a correction shows the garment's current
-- photo and name rather than a copy that drifts.
CREATE TABLE IF NOT EXISTS outfit_feedback (
  id         TEXT PRIMARY KEY,
  outfit_id  TEXT NOT NULL,
  slot       TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  -- Null when the owner dropped the layer instead of replacing it.
  to_id      TEXT,
  reason     TEXT NOT NULL,
  -- ISO, the same convention `insertOutfit` binds, so the first ten characters
  -- are the UTC day the wear log writes.
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS outfit_feedback_outfit ON outfit_feedback (outfit_id);
CREATE INDEX IF NOT EXISTS outfit_feedback_created ON outfit_feedback (created_at DESC);
