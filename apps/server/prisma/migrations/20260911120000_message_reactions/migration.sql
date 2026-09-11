-- One person reacting to one message with one emoji.
--
-- A row per person per emoji, and no count column: the count is COUNT(*) over
-- these rows, so a double-click or two open windows cannot leave a number that
-- disagrees with the people behind it.
CREATE TABLE "MessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- One canonical emoji character. Never a shortcode, never an id into a
    -- table of emoji -- there is no such table. See canonicalEmoji in the
    -- shared package for what canonical means and why `👍` and `👍️` must not
    -- both be able to land here.
    "emoji" TEXT NOT NULL,
    -- Orders the names in "Alice, Bob and Carol reacted with 👍".
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

-- Reacting twice with the same emoji is reacting once. This is also what makes
-- the add path safe to run concurrently: the second write loses to the
-- constraint rather than to a check-then-insert two requests can both pass.
CREATE UNIQUE INDEX "MessageReaction_messageId_userId_emoji_key"
    ON "MessageReaction"("messageId", "userId", "emoji");

-- "The reactions on these messages" -- asked for every message of every
-- history page.
CREATE INDEX "MessageReaction_messageId_idx" ON "MessageReaction"("messageId");

-- Nothing reads this; ON DELETE CASCADE does. Deleting an account has to find
-- its reactions, and Postgres does not index a foreign key column on its own.
CREATE INDEX "MessageReaction_userId_idx" ON "MessageReaction"("userId");

ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
