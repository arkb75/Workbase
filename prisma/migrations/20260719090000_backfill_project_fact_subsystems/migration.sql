-- Preserve legacy reviewed Project Facts in subsystem-aware retrieval and
-- editorial coverage. Future research writes classify this field before
-- persistence; this migration repairs facts created by earlier runtimes.
UPDATE "ProjectFact"
SET "subsystemKey" = CASE
  WHEN "statement" ~* '(durable workflow|workflow (entrypoint|orchestration)|approval hook|pause and resume|persisted run|retry-safe|idempoten)' THEN 'workflow_orchestration'
  WHEN "statement" ~* '(bedrock|converse|structured (generation|output)|tool (use|loop)|token budget|prompt cach|agent runtime)' THEN 'ai_runtime'
  WHEN "statement" ~* '(repository (knowledge|refresh|snapshot|coverage|synthesis)|semantic analys|stale knowledge|knowledge reconciliation)' THEN 'repository_knowledge_lifecycle'
  WHEN "statement" ~* '(project chat|multi-turn|conversation history|answer grounding|execution rout)' THEN 'project_chat_grounding'
  WHEN "statement" ~* '(hybrid retrieval|vector and lexical|citation tracking|provenance|re-ground)' THEN 'retrieval_provenance'
  WHEN "statement" ~* '(knowledge review|supersed|revalidat|retir|quarantin|downstream dependent)' THEN 'knowledge_review_lifecycle'
  WHEN "statement" ~* '(artifact generation|resume bullet|linkedin (entry|experience)|project summar|approved highlight)' THEN 'artifact_generation'
  WHEN "statement" ~* '(github (oauth|ingestion|import)|repository exploration|source ingestion)' THEN 'ingestion_integrations'
  WHEN "statement" ~* '(prisma|data model|database schema|postgres|normalized store)' THEN 'domain_data'
  WHEN "statement" ~* '(review (workspace|ui)|citation display|source management|project workspace)' THEN 'review_ui'
  WHEN "statement" ~* '(automated test|test coverage|vitest|integration test)' THEN 'tests_operations'
  WHEN "statement" ~* '(career content|work item|full-stack (application|platform)|product flow)' THEN 'product_surface'
  ELSE NULL
END
WHERE "subsystemKey" IS NULL;

-- Historical verifier/provider failures were previously persisted as generic
-- answer text. Mark them as legacy turns so the UI offers source-current
-- regeneration instead of presenting a misleading verification failure.
UPDATE "ChatMessage"
SET
  "content" = 'This historical run did not retain enough supported source metadata to reconstruct its answer safely. Regenerate it with current project sources.',
  "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
    'citationIntegrity', 'legacy_unverifiable',
    'citationContractVersion', 1,
    'regenerateRecommended', true,
    'repairedGenericFailure', true
  )
WHERE "role" = 'assistant'
  AND "status" = 'failed'
  AND LOWER(REGEXP_REPLACE(BTRIM("content"), '[.!?]+$', '')) IN (
    'the answer could not be verified against its sources',
    'grounding verifier returned no supported claims',
    'citation integrity failed'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "ChatCitation"
    WHERE "ChatCitation"."messageId" = "ChatMessage"."id"
  );
