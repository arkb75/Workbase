-- CreateEnum
CREATE TYPE "ProjectFactCategory" AS ENUM ('architecture', 'behavior', 'data_flow', 'code_location', 'dependency', 'configuration');

-- CreateEnum
CREATE TYPE "ProjectFactStatus" AS ENUM ('draft', 'approved', 'rejected', 'superseded');

-- AlterEnum
ALTER TYPE "ChatCitationKind" ADD VALUE 'project_fact';

-- AlterEnum
ALTER TYPE "AgentRunCandidateKind" ADD VALUE 'new_project_fact';
ALTER TYPE "AgentRunCandidateKind" ADD VALUE 'project_fact_revision';

-- AlterTable
ALTER TABLE "ChatCitation" ADD COLUMN "projectFactId" TEXT;

-- AlterTable
ALTER TABLE "AgentRunCandidate" ADD COLUMN "projectFactId" TEXT;

-- CreateTable
CREATE TABLE "ProjectFact" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "category" "ProjectFactCategory" NOT NULL,
    "confidence" "ClaimConfidence" NOT NULL,
    "status" "ProjectFactStatus" NOT NULL DEFAULT 'draft',
    "sensitivityFlag" BOOLEAN NOT NULL DEFAULT false,
    "reviewNotes" TEXT,
    "rejectionReason" TEXT,
    "searchText" TEXT NOT NULL,
    "supersedesProjectFactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectFactEvidence" (
    "id" TEXT NOT NULL,
    "projectFactId" TEXT NOT NULL,
    "evidenceItemId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectFactEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectFactEmbedding" (
    "id" TEXT NOT NULL,
    "projectFactId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "inputHash" TEXT NOT NULL,
    "inputText" TEXT NOT NULL,
    "embedding" vector(512) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectFactEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectFact_workItemId_status_updatedAt_idx" ON "ProjectFact"("workItemId", "status", "updatedAt");
CREATE INDEX "ProjectFact_supersedesProjectFactId_idx" ON "ProjectFact"("supersedesProjectFactId");
CREATE UNIQUE INDEX "ProjectFactEvidence_projectFactId_evidenceItemId_key" ON "ProjectFactEvidence"("projectFactId", "evidenceItemId");
CREATE INDEX "ProjectFactEvidence_evidenceItemId_idx" ON "ProjectFactEvidence"("evidenceItemId");
CREATE UNIQUE INDEX "ProjectFactEmbedding_projectFactId_key" ON "ProjectFactEmbedding"("projectFactId");
CREATE INDEX "ProjectFactEmbedding_projectFactId_idx" ON "ProjectFactEmbedding"("projectFactId");
CREATE INDEX "ChatCitation_projectFactId_idx" ON "ChatCitation"("projectFactId");
CREATE INDEX "AgentRunCandidate_projectFactId_idx" ON "AgentRunCandidate"("projectFactId");

-- AddForeignKey
ALTER TABLE "ProjectFact" ADD CONSTRAINT "ProjectFact_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectFact" ADD CONSTRAINT "ProjectFact_supersedesProjectFactId_fkey" FOREIGN KEY ("supersedesProjectFactId") REFERENCES "ProjectFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProjectFactEvidence" ADD CONSTRAINT "ProjectFactEvidence_projectFactId_fkey" FOREIGN KEY ("projectFactId") REFERENCES "ProjectFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectFactEvidence" ADD CONSTRAINT "ProjectFactEvidence_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectFactEmbedding" ADD CONSTRAINT "ProjectFactEmbedding_projectFactId_fkey" FOREIGN KEY ("projectFactId") REFERENCES "ProjectFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatCitation" ADD CONSTRAINT "ChatCitation_projectFactId_fkey" FOREIGN KEY ("projectFactId") REFERENCES "ProjectFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentRunCandidate" ADD CONSTRAINT "AgentRunCandidate_projectFactId_fkey" FOREIGN KEY ("projectFactId") REFERENCES "ProjectFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
