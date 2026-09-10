-- `cut/<id>.png` used to be written once and never again, so `GET /img/:kind/:id`
-- answers `immutable`. Erasing part of a cutout by hand rewrites that same key,
-- and a phone holding the old bytes would never ask for the new ones. The
-- counter goes in the URL, so an edited photo is a new URL instead of a cache
-- the app has to weaken for every garment.
ALTER TABLE garment ADD COLUMN photo_version INTEGER NOT NULL DEFAULT 0;
