-- Search, and files that expire.
--
-- Two unrelated features in one migration because they ship together and a
-- half-applied pair is worse than either.

-- ---------------------------------------------------------------- search
--
-- A stored generated column, not an expression index and not a trigger.
-- Postgres recomputes it on every insert and every edit, so it cannot drift
-- from the text; nothing in the application writes it, and nothing has to
-- remember to.
--
-- 'simple' rather than 'english' on purpose. English stemming would make
-- "running" find "ran", which reads well in a demo and badly here: what people
-- actually search a chat server for is a username, a filename, a link, a
-- version number -- strings that stemming mangles and that must match exactly.
ALTER TABLE "Message"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED;

CREATE INDEX "Message_searchVector_idx" ON "Message" USING GIN ("searchVector");

-- --------------------------------------------------------- ephemeral files
--
-- Both nullable with no default and no back-fill: every row that already
-- exists is a picture or predates the feature, and null means kept. An upgrade
-- therefore changes nothing about what is stored, which is the only safe way
-- to add a column whose job is to delete things.
ALTER TABLE "Attachment" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "Attachment" ADD COLUMN "expiredAt" TIMESTAMP(3);

-- The sweeper asks "what is due" every hour. Without this that is a scan of
-- every attachment ever uploaded, forever.
CREATE INDEX "Attachment_expiresAt_idx" ON "Attachment"("expiresAt");
