-- AlterTable
ALTER TABLE "GuildMember" ADD COLUMN     "mutedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "deletedById" TEXT;

-- CreateTable
CREATE TABLE "GuildBan" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bannedById" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildBan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuildBan_userId_idx" ON "GuildBan"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GuildBan_guildId_userId_key" ON "GuildBan"("guildId", "userId");

-- AddForeignKey
ALTER TABLE "GuildBan" ADD CONSTRAINT "GuildBan_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildBan" ADD CONSTRAINT "GuildBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuildBan" ADD CONSTRAINT "GuildBan_bannedById_fkey" FOREIGN KEY ("bannedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
