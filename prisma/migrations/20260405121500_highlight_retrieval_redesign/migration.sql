DO $$
BEGIN
  CREATE TYPE "TagDimension" AS ENUM ('domain', 'competency', 'emphasis', 'audience_fit');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'highlight_generation';
ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'highlight_verification';
ALTER TYPE "GenerationKind" ADD VALUE IF NOT EXISTS 'artifact_retrieval';

ALTER TABLE "EvidenceItem"
  ADD COLUMN IF NOT EXISTS "searchText" TEXT,
  ADD COLUMN IF NOT EXISTS "parentKind" TEXT,
  ADD COLUMN IF NOT EXISTS "parentKey" TEXT;

UPDATE "EvidenceItem"
SET
  "searchText" = COALESCE(
    "searchText",
    trim(
      concat_ws(
        ' ',
        "title",
        "content",
        CASE
          WHEN "metadata" IS NULL THEN NULL
          ELSE "metadata"::text
        END
      )
    )
  ),
  "parentKind" = COALESCE(
    "parentKind",
    CASE
      WHEN "type" = 'github_pull_request'::"EvidenceItemType" AND "metadata"->>'number' IS NOT NULL THEN 'pull_request'
      WHEN "type" = 'github_issue'::"EvidenceItemType" AND "metadata"->>'number' IS NOT NULL THEN 'issue'
      WHEN "type" = 'github_release'::"EvidenceItemType" AND "metadata"->>'tagName' IS NOT NULL THEN 'release'
      ELSE 'source'
    END
  ),
  "parentKey" = COALESCE(
    "parentKey",
    CASE
      WHEN "type" = 'github_pull_request'::"EvidenceItemType" AND "metadata"->>'number' IS NOT NULL THEN "sourceId" || ':pull:' || ("metadata"->>'number')
      WHEN "type" = 'github_issue'::"EvidenceItemType" AND "metadata"->>'number' IS NOT NULL THEN "sourceId" || ':issue:' || ("metadata"->>'number')
      WHEN "type" = 'github_release'::"EvidenceItemType" AND "metadata"->>'tagName' IS NOT NULL THEN "sourceId" || ':release:' || ("metadata"->>'tagName')
      ELSE "sourceId"
    END
  );

ALTER TABLE "EvidenceItem"
  ALTER COLUMN "searchText" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "EvidenceItem_workItemId_parentKind_parentKey_idx"
ON "EvidenceItem"("workItemId", "parentKind", "parentKey");

ALTER TABLE "Claim"
  ADD COLUMN IF NOT EXISTS "summary" TEXT,
  ADD COLUMN IF NOT EXISTS "searchText" TEXT,
  ADD COLUMN IF NOT EXISTS "verificationNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

UPDATE "Claim" AS "c"
SET
  "summary" = COALESCE("ec"."evidenceSummary", "c"."text"),
  "verificationNotes" = COALESCE("ec"."verificationNotes", "ec"."rationaleSummary"),
  "metadata" = COALESCE(
    "c"."metadata",
    NULLIF(
      jsonb_strip_nulls(
        jsonb_build_object(
          'legacyCategory', "c"."category",
          'legacyEvidenceCardId', "ec"."id",
          'legacyRationaleSummary', "ec"."rationaleSummary"
        )
      ),
      '{}'::jsonb
    )
  ),
  "searchText" = trim(
    concat_ws(
      ' ',
      "c"."text",
      COALESCE("ec"."evidenceSummary", "c"."text"),
      COALESCE("ec"."verificationNotes", "ec"."rationaleSummary")
    )
  )
FROM "EvidenceCard" AS "ec"
WHERE "ec"."claimId" = "c"."id";

UPDATE "Claim"
SET
  "summary" = COALESCE("summary", "text"),
  "searchText" = COALESCE(
    "searchText",
    trim(concat_ws(' ', "text", COALESCE("summary", "text"), COALESCE("verificationNotes", '')))
  )
WHERE "summary" IS NULL OR "searchText" IS NULL;

ALTER TABLE "Claim"
  ALTER COLUMN "summary" SET NOT NULL,
  ALTER COLUMN "searchText" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "HighlightEvidence" (
  "id" TEXT NOT NULL,
  "highlightId" TEXT NOT NULL,
  "evidenceItemId" TEXT NOT NULL,
  "relevanceScore" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HighlightEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "HighlightTag" (
  "id" TEXT NOT NULL,
  "highlightId" TEXT NOT NULL,
  "dimension" "TagDimension" NOT NULL,
  "tag" TEXT NOT NULL,
  "score" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HighlightTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvidenceTag" (
  "id" TEXT NOT NULL,
  "evidenceItemId" TEXT NOT NULL,
  "dimension" "TagDimension" NOT NULL,
  "tag" TEXT NOT NULL,
  "score" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EvidenceTag_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "HighlightEvidence"
    ADD CONSTRAINT "HighlightEvidence_highlightId_fkey"
    FOREIGN KEY ("highlightId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "HighlightEvidence"
    ADD CONSTRAINT "HighlightEvidence_evidenceItemId_fkey"
    FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "HighlightTag"
    ADD CONSTRAINT "HighlightTag_highlightId_fkey"
    FOREIGN KEY ("highlightId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "EvidenceTag"
    ADD CONSTRAINT "EvidenceTag_evidenceItemId_fkey"
    FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "HighlightEvidence_highlightId_evidenceItemId_key"
ON "HighlightEvidence"("highlightId", "evidenceItemId");

CREATE UNIQUE INDEX IF NOT EXISTS "HighlightTag_highlightId_dimension_tag_key"
ON "HighlightTag"("highlightId", "dimension", "tag");

CREATE INDEX IF NOT EXISTS "HighlightTag_dimension_tag_idx"
ON "HighlightTag"("dimension", "tag");

CREATE UNIQUE INDEX IF NOT EXISTS "EvidenceTag_evidenceItemId_dimension_tag_key"
ON "EvidenceTag"("evidenceItemId", "dimension", "tag");

CREATE INDEX IF NOT EXISTS "EvidenceTag_dimension_tag_idx"
ON "EvidenceTag"("dimension", "tag");

INSERT INTO "HighlightEvidence" ("id", "highlightId", "evidenceItemId", "relevanceScore")
SELECT
  'mhe:' || "c"."id" || ':' || ("ref"->>'evidenceItemId'),
  "c"."id",
  "ref"->>'evidenceItemId',
  NULL
FROM "Claim" AS "c"
JOIN "EvidenceCard" AS "ec"
  ON "ec"."claimId" = "c"."id"
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof("ec"."sourceRefs") = 'array' THEN "ec"."sourceRefs"
    ELSE '[]'::jsonb
  END
) AS "ref"
WHERE "ref" ? 'evidenceItemId'
  AND EXISTS (
    SELECT 1
    FROM "EvidenceItem" AS "ei"
    WHERE "ei"."id" = "ref"->>'evidenceItemId'
  )
ON CONFLICT ("highlightId", "evidenceItemId") DO NOTHING;

INSERT INTO "HighlightTag" ("id", "highlightId", "dimension", "tag", "score")
SELECT
  'mht:domain:' || "id" || ':' || "category",
  "id",
  'domain'::"TagDimension",
  "category",
  0.7
FROM "Claim"
WHERE "category" IN (
  'general',
  'ai_ml',
  'data_engineering',
  'backend',
  'full_stack',
  'frontend',
  'design',
  'product',
  'research',
  'operations'
)
ON CONFLICT ("highlightId", "dimension", "tag") DO NOTHING;

INSERT INTO "HighlightTag" ("id", "highlightId", "dimension", "tag", "score")
SELECT
  'mht:resume:' || "id",
  "id",
  'audience_fit'::"TagDimension",
  'resume_safe',
  0.5
FROM "Claim"
WHERE "visibility" IN (
  'resume_safe'::"VisibilityLevel",
  'linkedin_safe'::"VisibilityLevel",
  'public_safe'::"VisibilityLevel"
)
ON CONFLICT ("highlightId", "dimension", "tag") DO NOTHING;

INSERT INTO "HighlightTag" ("id", "highlightId", "dimension", "tag", "score")
SELECT
  'mht:linkedin:' || "id",
  "id",
  'audience_fit'::"TagDimension",
  'linkedin_safe',
  0.5
FROM "Claim"
WHERE "visibility" IN (
  'linkedin_safe'::"VisibilityLevel",
  'public_safe'::"VisibilityLevel"
)
ON CONFLICT ("highlightId", "dimension", "tag") DO NOTHING;

INSERT INTO "HighlightTag" ("id", "highlightId", "dimension", "tag", "score")
SELECT
  'mht:project:' || "id",
  "id",
  'audience_fit'::"TagDimension",
  'project_summary',
  0.5
FROM "Claim"
WHERE "visibility" = 'public_safe'::"VisibilityLevel"
ON CONFLICT ("highlightId", "dimension", "tag") DO NOTHING;

ALTER TABLE "Claim"
  DROP COLUMN IF EXISTS "category";

DROP TABLE IF EXISTS "EvidenceCard";
DROP TABLE IF EXISTS "EvidenceClusterItem";
DROP TABLE IF EXISTS "EvidenceCluster";
