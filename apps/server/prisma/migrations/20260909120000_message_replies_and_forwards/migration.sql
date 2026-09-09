-- Replies and forwards.
--
-- Two nullable self-references on Message, for the same reason the pin is two
-- nullable columns: a message answers at most one message and carries at most
-- one forward, and neither pointer has a life of its own worth a table.
ALTER TABLE "Message" ADD COLUMN "replyToId" TEXT;
ALTER TABLE "Message" ADD COLUMN "forwardedFromId" TEXT;

-- ON DELETE SET NULL on both, and it is the important half of this migration.
-- Deleting an account cascades every message that account ever sent; a reply
-- somebody else wrote must survive the message it was answering, losing its
-- quote rather than itself. CASCADE here would delete other people's messages
-- as a side effect of removing one person.
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_replyToId_fkey"
  FOREIGN KEY ("replyToId") REFERENCES "Message"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_forwardedFromId_fkey"
  FOREIGN KEY ("forwardedFromId") REFERENCES "Message"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Nothing in the application reads these; the two constraints above do.
-- Postgres does not index a foreign key column by itself, and without an index
-- every parent row deleted is a full scan of this table to find the children
-- to null out -- so a cascade that removes ten thousand messages becomes ten
-- thousand scans of every message ever sent.
CREATE INDEX "Message_replyToId_idx" ON "Message"("replyToId");
CREATE INDEX "Message_forwardedFromId_idx" ON "Message"("forwardedFromId");
