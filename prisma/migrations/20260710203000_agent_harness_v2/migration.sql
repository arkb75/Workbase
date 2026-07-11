ALTER TYPE "ChatMessageStatus" ADD VALUE IF NOT EXISTS 'awaiting_review';

ALTER TABLE "ChatThread"
ADD COLUMN "conversationState" JSONB;

ALTER TABLE "ChatMessage"
ADD COLUMN "finalizedAt" TIMESTAMP(3);

ALTER TABLE "AgentRun"
ADD COLUMN "harnessVersion" TEXT NOT NULL DEFAULT 'v2',
ADD COLUMN "environmentSnapshot" JSONB,
ADD COLUMN "researchState" JSONB,
ADD COLUMN "provisionalResult" JSONB;
