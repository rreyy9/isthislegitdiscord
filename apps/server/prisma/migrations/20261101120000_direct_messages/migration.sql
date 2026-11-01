-- Direct messages.
--
-- A DM is a TEXT channel with no guild. Making the column nullable is the
-- privacy boundary rather than a convenience: everything that lists or checks
-- a guild's channels does it through guildId, so a DM is invisible to all of
-- it by construction instead of by a filter somebody has to remember.
--
-- No new ChannelKind. A DM holds messages, files, reactions, pins and replies
-- exactly as a text channel does, and every check that asks "is this a text
-- channel" should keep answering yes.
ALTER TABLE "Channel" ALTER COLUMN "guildId" DROP NOT NULL;

-- "lowUserId:highUserId" for a one-to-one DM. The unique index is what makes
-- "open a DM with them" safe to race.
ALTER TABLE "Channel" ADD COLUMN "dmKey" TEXT;
CREATE UNIQUE INDEX "Channel_dmKey_key" ON "Channel"("dmKey");

-- Who is in each DM. Guild channels have no rows here.
CREATE TABLE "ChannelParticipant" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hiddenAt" TIMESTAMP(3),

    CONSTRAINT "ChannelParticipant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelParticipant_channelId_userId_key" ON "ChannelParticipant"("channelId", "userId");
CREATE INDEX "ChannelParticipant_userId_idx" ON "ChannelParticipant"("userId");

ALTER TABLE "ChannelParticipant" ADD CONSTRAINT "ChannelParticipant_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelParticipant" ADD CONSTRAINT "ChannelParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A DM message's end-to-end encrypted envelope. The server stores it and
-- cannot read it; `content` on these rows is empty.
ALTER TABLE "Message" ADD COLUMN "sealed" TEXT;

-- The public half of each device's end-to-end keys. The private half never
-- leaves the device.
CREATE TABLE "DeviceKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptionKey" TEXT NOT NULL,
    "signingKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceKey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeviceKey_userId_idx" ON "DeviceKey"("userId");

ALTER TABLE "DeviceKey" ADD CONSTRAINT "DeviceKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
