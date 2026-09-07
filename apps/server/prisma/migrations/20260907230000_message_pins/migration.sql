-- Pinned messages.
--
-- Two columns on Message rather than a join table: a message is pinned at most
-- once, and the pin has no life of its own. Unpinning is not an event anyone
-- wants a record of, and deleting the message has to take the pin with it --
-- which this way it does, with no cascade to write.
ALTER TABLE "Message" ADD COLUMN "pinnedAt" TIMESTAMP(3);
-- Who pinned it. A plain id, like "deletedById": an audit note for somebody
-- looking into it later, not something the app joins on.
ALTER TABLE "Message" ADD COLUMN "pinnedById" TEXT;

-- "The pins in this channel", asked every time the list is opened. Without it
-- that is a scan of every message the channel has ever held.
CREATE INDEX "Message_channelId_pinnedAt_idx" ON "Message"("channelId", "pinnedAt");
