-- CreateEnum
CREATE TYPE "EvidenceItemType" AS ENUM ('manual_note_excerpt', 'github_readme', 'github_commit', 'github_pull_request', 'github_issue', 'github_release');

-- AlterEnum
ALTER TYPE "GenerationKind" ADD VALUE 'evidence_clustering';

-- AlterTable
ALTER TABLE "GenerationRun" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "externalId" TEXT;

-- CreateTable
CREATE TABLE "GitHubConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "type" "EvidenceItemType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceCluster" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "confidence" "ClaimConfidence" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceClusterItem" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "evidenceItemId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceClusterItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_userId_key" ON "GitHubConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_githubUserId_key" ON "GitHubConnection"("githubUserId");

-- CreateIndex
CREATE INDEX "EvidenceItem_workItemId_included_updatedAt_idx" ON "EvidenceItem"("workItemId", "included", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItem_sourceId_externalId_key" ON "EvidenceItem"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "EvidenceCluster_workItemId_updatedAt_idx" ON "EvidenceCluster"("workItemId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceClusterItem_clusterId_evidenceItemId_key" ON "EvidenceClusterItem"("clusterId", "evidenceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Source_workItemId_type_externalId_key" ON "Source"("workItemId", "type", "externalId");

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceCluster" ADD CONSTRAINT "EvidenceCluster_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceClusterItem" ADD CONSTRAINT "EvidenceClusterItem_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "EvidenceCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceClusterItem" ADD CONSTRAINT "EvidenceClusterItem_evidenceItemId_fkey" FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

