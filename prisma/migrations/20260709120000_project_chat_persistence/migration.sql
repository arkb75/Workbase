-- AlterEnum
ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'chat_context';

-- AlterEnum
ALTER TYPE "EvidenceItemType" ADD VALUE IF NOT EXISTS 'chat_user_statement';
ALTER TYPE "EvidenceItemType" ADD VALUE IF NOT EXISTS 'github_file_excerpt';

-- CreateEnum
CREATE TYPE "ChatMessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "ChatMessageStatus" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ChatCitationKind" AS ENUM ('highlight', 'evidence', 'artifact', 'github_file');

-- CreateEnum
CREATE TYPE "AgentRunKind" AS ENUM ('chat_turn', 'project_research', 'artifact_workflow');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('queued', 'running', 'awaiting_review', 'completed', 'insufficient_context', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AgentRunEventType" AS ENUM ('progress', 'tool_call', 'tool_result', 'status_change', 'warning', 'error');

-- CreateEnum
CREATE TYPE "AgentRunCandidateKind" AS ENUM ('new_highlight', 'highlight_revision');

-- CreateEnum
CREATE TYPE "AgentRunCandidateStatus" AS ENUM ('pending', 'approved', 'edited_and_approved', 'denied');

-- AlterTable
ALTER TABLE "Artifact"
  ADD COLUMN "requestBrief" TEXT,
  ADD COLUMN "searchText" TEXT,
  ADD COLUMN "originatingAgentRunId" TEXT;

UPDATE "Artifact"
SET
  "requestBrief" = concat(
    'Legacy ',
    replace("type"::text, '_', ' '),
    ' request with ',
    replace("targetAngle"::text, '_', ' '),
    ' angle and ',
    replace("tone"::text, '_', ' '),
    ' tone.'
  ),
  "searchText" = trim(concat_ws(' ', "content", "type"::text, "targetAngle"::text, "tone"::text));

ALTER TABLE "Artifact"
  ALTER COLUMN "requestBrief" SET NOT NULL,
  ALTER COLUMN "searchText" SET NOT NULL;

-- CreateTable
CREATE TABLE "EvidenceEmbedding" (
  "id" TEXT NOT NULL,
  "evidenceItemId" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "inputHash" TEXT NOT NULL,
  "inputText" TEXT NOT NULL,
  "embedding" vector(512) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EvidenceEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactEmbedding" (
  "id" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL,
  "inputHash" TEXT NOT NULL,
  "inputText" TEXT NOT NULL,
  "embedding" vector(512) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ArtifactEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactHighlightProvenance" (
  "id" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "highlightId" TEXT,
  "highlightSnapshot" JSONB NOT NULL,
  "rank" INTEGER,
  "relevanceScore" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArtifactHighlightProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactEvidenceProvenance" (
  "id" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "evidenceItemId" TEXT,
  "evidenceSnapshot" JSONB NOT NULL,
  "rank" INTEGER,
  "relevanceScore" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ArtifactEvidenceProvenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatThread" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "rollingSummary" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workItemId" TEXT NOT NULL,
  "threadId" TEXT,
  "parentRunId" TEXT,
  "workflowId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "kind" "AgentRunKind" NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'queued',
  "request" JSONB NOT NULL,
  "attemptNumber" INTEGER NOT NULL DEFAULT 0,
  "result" JSONB,
  "error" JSONB,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
  "id" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "agentRunId" TEXT,
  "sequence" INTEGER NOT NULL,
  "role" "ChatMessageRole" NOT NULL,
  "status" "ChatMessageStatus" NOT NULL DEFAULT 'completed',
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatCitation" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "kind" "ChatCitationKind" NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "highlightId" TEXT,
  "evidenceItemId" TEXT,
  "artifactId" TEXT,
  "sourceId" TEXT,
  "label" TEXT NOT NULL,
  "excerpt" TEXT,
  "immutableUrl" TEXT,
  "repository" TEXT,
  "commitSha" TEXT,
  "blobSha" TEXT,
  "path" TEXT,
  "startLine" INTEGER,
  "endLine" INTEGER,
  "contentHash" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunEvent" (
  "id" TEXT NOT NULL,
  "agentRunId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "AgentRunEventType" NOT NULL,
  "message" TEXT,
  "toolName" TEXT,
  "payload" JSONB,
  "isUserVisible" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AgentRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunCandidate" (
  "id" TEXT NOT NULL,
  "agentRunId" TEXT NOT NULL,
  "highlightId" TEXT,
  "highlightSuggestionId" TEXT,
  "kind" "AgentRunCandidateKind" NOT NULL,
  "status" "AgentRunCandidateStatus" NOT NULL DEFAULT 'pending',
  "batchNumber" INTEGER NOT NULL DEFAULT 1,
  "ordinal" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "editedText" TEXT,
  "feedback" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AgentRunCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Artifact_workItemId_updatedAt_idx" ON "Artifact"("workItemId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_originatingAgentRunId_key" ON "Artifact"("originatingAgentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceEmbedding_evidenceItemId_key" ON "EvidenceEmbedding"("evidenceItemId");

-- CreateIndex
CREATE INDEX "EvidenceEmbedding_evidenceItemId_idx" ON "EvidenceEmbedding"("evidenceItemId");

-- CreateIndex
CREATE INDEX "EvidenceEmbedding_embedding_hnsw_idx" ON "EvidenceEmbedding" USING hnsw ("embedding" vector_cosine_ops);

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactEmbedding_artifactId_key" ON "ArtifactEmbedding"("artifactId");

-- CreateIndex
CREATE INDEX "ArtifactEmbedding_artifactId_idx" ON "ArtifactEmbedding"("artifactId");

-- CreateIndex
CREATE INDEX "ArtifactEmbedding_embedding_hnsw_idx" ON "ArtifactEmbedding" USING hnsw ("embedding" vector_cosine_ops);

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactHighlightProvenance_artifactId_highlightId_key" ON "ArtifactHighlightProvenance"("artifactId", "highlightId");

-- CreateIndex
CREATE INDEX "ArtifactHighlightProvenance_highlightId_idx" ON "ArtifactHighlightProvenance"("highlightId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactEvidenceProvenance_artifactId_evidenceItemId_key" ON "ArtifactEvidenceProvenance"("artifactId", "evidenceItemId");

-- CreateIndex
CREATE INDEX "ArtifactEvidenceProvenance_evidenceItemId_idx" ON "ArtifactEvidenceProvenance"("evidenceItemId");

-- CreateIndex
CREATE INDEX "ChatThread_userId_workItemId_archivedAt_updatedAt_idx" ON "ChatThread"("userId", "workItemId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_workflowId_key" ON "AgentRun"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_userId_idempotencyKey_key" ON "AgentRun"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentRun_workItemId_status_updatedAt_idx" ON "AgentRun"("workItemId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentRun_threadId_createdAt_idx" ON "AgentRun"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_threadId_sequence_key" ON "ChatMessage"("threadId", "sequence");

-- CreateIndex
CREATE INDEX "ChatMessage_agentRunId_idx" ON "ChatMessage"("agentRunId");

-- CreateIndex
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatCitation_messageId_ordinal_key" ON "ChatCitation"("messageId", "ordinal");

-- CreateIndex
CREATE INDEX "ChatCitation_highlightId_idx" ON "ChatCitation"("highlightId");

-- CreateIndex
CREATE INDEX "ChatCitation_evidenceItemId_idx" ON "ChatCitation"("evidenceItemId");

-- CreateIndex
CREATE INDEX "ChatCitation_artifactId_idx" ON "ChatCitation"("artifactId");

-- CreateIndex
CREATE INDEX "ChatCitation_sourceId_idx" ON "ChatCitation"("sourceId");

-- CreateIndex
CREATE INDEX "ChatCitation_repository_commitSha_path_idx" ON "ChatCitation"("repository", "commitSha", "path");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunEvent_agentRunId_sequence_key" ON "AgentRunEvent"("agentRunId", "sequence");

-- CreateIndex
CREATE INDEX "AgentRunEvent_agentRunId_createdAt_idx" ON "AgentRunEvent"("agentRunId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunCandidate_agentRunId_batchNumber_ordinal_key" ON "AgentRunCandidate"("agentRunId", "batchNumber", "ordinal");

-- CreateIndex
CREATE INDEX "AgentRunCandidate_agentRunId_status_batchNumber_idx" ON "AgentRunCandidate"("agentRunId", "status", "batchNumber");

-- CreateIndex
CREATE INDEX "AgentRunCandidate_highlightId_idx" ON "AgentRunCandidate"("highlightId");

-- CreateIndex
CREATE INDEX "AgentRunCandidate_highlightSuggestionId_idx" ON "AgentRunCandidate"("highlightSuggestionId");

-- AddForeignKey
ALTER TABLE "EvidenceEmbedding" ADD CONSTRAINT "EvidenceEmbedding_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactEmbedding" ADD CONSTRAINT "ArtifactEmbedding_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactHighlightProvenance" ADD CONSTRAINT "ArtifactHighlightProvenance_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactHighlightProvenance" ADD CONSTRAINT "ArtifactHighlightProvenance_highlightId_fkey" FOREIGN KEY ("highlightId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactEvidenceProvenance" ADD CONSTRAINT "ArtifactEvidenceProvenance_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactEvidenceProvenance" ADD CONSTRAINT "ArtifactEvidenceProvenance_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCitation" ADD CONSTRAINT "ChatCitation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCitation" ADD CONSTRAINT "ChatCitation_highlightId_fkey" FOREIGN KEY ("highlightId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCitation" ADD CONSTRAINT "ChatCitation_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCitation" ADD CONSTRAINT "ChatCitation_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCitation" ADD CONSTRAINT "ChatCitation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunEvent" ADD CONSTRAINT "AgentRunEvent_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunCandidate" ADD CONSTRAINT "AgentRunCandidate_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunCandidate" ADD CONSTRAINT "AgentRunCandidate_highlightId_fkey" FOREIGN KEY ("highlightId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunCandidate" ADD CONSTRAINT "AgentRunCandidate_highlightSuggestionId_fkey" FOREIGN KEY ("highlightSuggestionId") REFERENCES "HighlightSuggestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_originatingAgentRunId_fkey" FOREIGN KEY ("originatingAgentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
