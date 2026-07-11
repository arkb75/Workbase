ALTER TABLE "KnowledgeRefreshRun" DROP COLUMN IF EXISTS "delta";
ALTER TABLE "RepositorySnapshot" ADD COLUMN IF NOT EXISTS "delta" JSONB;
