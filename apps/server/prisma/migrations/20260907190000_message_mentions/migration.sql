-- One person tagged in one message.
--
-- The `<@id>` markers are already in Message.content, so nothing here is new
-- information -- it is an index. "How many unread tags do I have in this
-- channel" is asked on every launch and after every read, and against the text
-- that is a full scan with a LIKE in it.
CREATE TABLE "MessageMention" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Copied down from the message so the per-channel query needs no join.
    -- Messages never move between channels, so it cannot go stale.
    "channelId" TEXT NOT NULL,

    CONSTRAINT "MessageMention_pkey" PRIMARY KEY ("id")
);

-- Tagging someone twice in one message is one tag. This is also what makes
-- re-resolving an edited message safe to run as a delete and a re-insert.
CREATE UNIQUE INDEX "MessageMention_messageId_userId_key"
    ON "MessageMention"("messageId", "userId");

-- Ids are UUIDv7, so "unread" is `messageId > lastReadMessageId` -- an index
-- range scan, with Message never touched.
CREATE INDEX "MessageMention_userId_channelId_messageId_idx"
    ON "MessageMention"("userId", "channelId", "messageId");

ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
