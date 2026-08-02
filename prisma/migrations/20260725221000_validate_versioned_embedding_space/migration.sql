-- Safety follow-up for environments that briefly applied the first versioned
-- index migration before its legacy-space validation was added.
DO $$
DECLARE
  identity_count INTEGER;
  invalid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO identity_count
  FROM (
    SELECT "modelId", "dimensions" FROM "HighlightEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
    UNION
    SELECT "modelId", "dimensions" FROM "ProjectFactEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
    UNION
    SELECT "modelId", "dimensions" FROM "EvidenceEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
    UNION
    SELECT "modelId", "dimensions" FROM "ArtifactEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
  ) AS identities;

  SELECT COUNT(*) INTO invalid_count
  FROM (
    SELECT "modelId", "dimensions" FROM "HighlightEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
    UNION ALL
    SELECT "modelId", "dimensions" FROM "ProjectFactEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
    UNION ALL
    SELECT "modelId", "dimensions" FROM "EvidenceEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
    UNION ALL
    SELECT "modelId", "dimensions" FROM "ArtifactEmbedding"
      WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'
  ) AS embeddings
  WHERE "modelId" <> 'amazon.titan-embed-text-v2:0'
    OR "dimensions" <> 512;

  IF identity_count > 1 OR invalid_count > 0 THEN
    RAISE EXCEPTION 'Versioned legacy embeddings are not one Amazon Titan v2 512-dimensional vector space.';
  END IF;
END $$;

DROP INDEX IF EXISTS "HighlightEmbedding_embedding_hnsw_idx";
DROP INDEX IF EXISTS "ProjectFactEmbedding_embedding_hnsw_idx";
DROP INDEX IF EXISTS "EvidenceEmbedding_embedding_hnsw_idx";
DROP INDEX IF EXISTS "ArtifactEmbedding_embedding_hnsw_idx";
