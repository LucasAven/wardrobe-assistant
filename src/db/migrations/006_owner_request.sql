-- What the owner asked for by name, and what admitting it turned off.
--
-- One nullable column rather than a table or three columns, because an outfit
-- with no request is the ordinary case and NULL says that in one place. The
-- shape is {"words":"...","disagreement":"..."|null,"honored":[{"id":"...",
-- "waived":["season"]}]}. Garments are ids here for the same reason they are
-- ids in `pieces`: the wardrobe is their one home.
ALTER TABLE outfit ADD COLUMN owner_request TEXT;
