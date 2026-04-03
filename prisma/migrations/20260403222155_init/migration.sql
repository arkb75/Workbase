-- CreateEnum
CREATE TYPE "CareerStage" AS ENUM ('student', 'intern', 'new_grad', 'early_career_engineer');

-- CreateEnum
CREATE TYPE "FocusPreference" AS ENUM ('projects', 'work_experience', 'both');

-- CreateEnum
CREATE TYPE "WorkItemType" AS ENUM ('project', 'experience');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('manual_note', 'github_repo');

-- CreateEnum
CREATE TYPE "ClaimConfidence" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "OwnershipClarity" AS ENUM ('unclear', 'partial', 'clear');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('draft', 'approved', 'flagged', 'rejected');

-- CreateEnum
CREATE TYPE "VisibilityLevel" AS ENUM ('private', 'resume_safe', 'linkedin_safe', 'public_safe');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('resume_bullets', 'linkedin_experience', 'project_summary');

-- CreateEnum
CREATE TYPE "TargetAngle" AS ENUM ('general', 'ai_ml', 'data_engineering', 'backend', 'full_stack');

-- CreateEnum
CREATE TYPE "ArtifactTone" AS ENUM ('concise', 'technical', 'recruiter_friendly');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "careerStage" "CareerStage",
    "currentGoal" TEXT,
    "focusPreference" "FocusPreference",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "WorkItemType" NOT NULL,
    "description" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "label" TEXT NOT NULL,
    "rawContent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT,
    "confidence" "ClaimConfidence" NOT NULL,
    "ownershipClarity" "OwnershipClarity" NOT NULL,
    "sensitivityFlag" BOOLEAN NOT NULL DEFAULT false,
    "verificationStatus" "VerificationStatus" NOT NULL,
    "visibility" "VisibilityLevel" NOT NULL,
    "risksSummary" TEXT,
    "missingInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceCard" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "evidenceSummary" TEXT NOT NULL,
    "rationaleSummary" TEXT NOT NULL,
    "sourceRefs" JSONB NOT NULL,
    "verificationNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workItemId" TEXT,
    "type" "ArtifactType" NOT NULL,
    "targetAngle" "TargetAngle" NOT NULL,
    "tone" "ArtifactTone" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceCard_claimId_key" ON "EvidenceCard"("claimId");

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceCard" ADD CONSTRAINT "EvidenceCard_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
