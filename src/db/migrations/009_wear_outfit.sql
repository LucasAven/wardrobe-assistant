-- Which outfit a wear was. The log held the day and the garments and nothing
-- else, so three outfits worn on one day read as one, and undoing the afternoon
-- one meant guessing which row it was.
--
-- Nullable because a wear can name no outfit and that is not a gap: every row
-- written before this column existed names none, and log_wear accepts a call
-- that names none. Those rows are still read as worn through the day and the
-- garments, which is what the app did with every row until now.
--
-- No foreign key, the same as `outfit_feedback.outfit_id` and for the same
-- reason: nothing in this schema declares one, and removing an outfit deletes
-- the wear rows naming it itself.
ALTER TABLE wear_log ADD COLUMN outfit_id TEXT;

CREATE INDEX IF NOT EXISTS wear_log_outfit ON wear_log (outfit_id);
