-- Preserve server-derived repository operation/state metadata on durable Facts.
-- Nullable keeps all existing and non-repository Project Facts compatible.
ALTER TABLE "ProjectFact" ADD COLUMN "metadata" JSONB;
