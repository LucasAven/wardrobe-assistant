-- The short name the assistant gave an outfit, in its own words. It says what
-- the outfit is for, not what is in it: the pieces are already on the card.
--
-- Nullable because an outfit saved before this column existed was never given
-- one, and the card leaves the line out rather than inventing a name for it.
ALTER TABLE outfit ADD COLUMN title TEXT;
