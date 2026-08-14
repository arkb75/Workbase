export type ProjectSubsystemKey =
  | "product_surface"
  | "domain_data"
  | "ai_runtime"
  | "ingestion_integrations"
  | "retrieval_provenance"
  | "workflow_orchestration"
  | "repository_knowledge_lifecycle"
  | "project_chat_grounding"
  | "artifact_generation"
  | "knowledge_review_lifecycle"
  | "review_ui"
  | "tests_operations";

/**
 * Classifies reviewed knowledge that was created without a subsystem tag.
 * A specific statement signal wins over its provenance path because a
 * synthesis service can legitimately describe another subsystem. Paths are a
 * fallback for generic code-location facts. Patterns are deliberately narrow:
 * returning null is safer than assigning an unrelated coverage bucket.
 */
export function inferProjectSubsystemKey(input: {
  text: string;
  paths?: readonly string[];
}): ProjectSubsystemKey | null {
  const textRules: Array<[ProjectSubsystemKey, RegExp]> = [
    ["workflow_orchestration", /\b(?:durable workflow|workflow (?:entrypoint|orchestration)|approval hook|pause and resume|persisted run|retry[- ]safe|idempoten)\w*/i],
    ["ai_runtime", /\b(?:bedrock|converse|structured (?:generation|output)|tool (?:use|loop)|token budget|prompt cach|agent runtime)\w*/i],
    ["repository_knowledge_lifecycle", /\b(?:repository (?:knowledge|refresh|snapshot|coverage|synthesis)|semantic analys|stale knowledge|knowledge reconciliation)\w*/i],
    ["project_chat_grounding", /\b(?:project chat|multi[- ]turn|conversation history|answer grounding|execution rout)\w*/i],
    ["retrieval_provenance", /\b(?:hybrid retrieval|vector and lexical|citation tracking|provenance|re-ground)\w*/i],
    ["knowledge_review_lifecycle", /\b(?:knowledge review|supersed|revalidat|retir|quarantin|downstream dependents?)\w*/i],
    ["artifact_generation", /\b(?:artifact generation|resume bullets?|linkedin (?:entry|experience)|project summar(?:y|ies)|approved highlights?)\b/i],
    ["ingestion_integrations", /\b(?:github (?:oauth|ingestion|import)|repository exploration|source ingestion)\b/i],
    ["domain_data", /\b(?:prisma|data model|database schema|postgres(?:ql)?|normalized store)\b/i],
    ["review_ui", /\b(?:review (?:workspace|ui)|citation display|source management|project workspace)\b/i],
    ["tests_operations", /\b(?:automated tests?|test coverage|vitest|integration tests?)\b/i],
    ["product_surface", /\b(?:career content|work items?|full-stack (?:application|platform)|product flow)\b/i],
  ];
  const textMatch = textRules.find(([, pattern]) => pattern.test(input.text));
  if (textMatch) return textMatch[0];

  const paths = (input.paths ?? []).join(" ");
  const pathRules: Array<[ProjectSubsystemKey, RegExp]> = [
    ["workflow_orchestration", /(?:^|\s)workflows?\/|(?:^|[/_-])workflow|orchestrat|agent-run-(?:workflow|start)|queue|job/i],
    ["repository_knowledge_lifecycle", /knowledge-refresh|repository-(?:coverage|knowledge|semantic)|knowledge-(?:reconciliation|staleness)/i],
    ["project_chat_grounding", /project-chat|project-execution-router|project-agent-harness|answer-grounding|prior-turn-provenance/i],
    ["artifact_generation", /artifact-(?:workflow|generation|persistence)|artifacts?\//i],
    ["knowledge_review_lifecycle", /knowledge-(?:review|update)|candidate-review|highlight-review/i],
    ["ai_runtime", /bedrock|structured-llm|model-usage|agent-runtime/i],
    ["retrieval_provenance", /retriev|citation|provenance|embedding|search/i],
    ["ingestion_integrations", /github|source|import|ingest|oauth|integration/i],
    ["domain_data", /prisma|schema|domain|types/i],
    ["review_ui", /components?\/|page\.tsx|workspace|review-ui/i],
    ["tests_operations", /test|spec|vitest|health|config|scripts?\//i],
    ["product_surface", /readme|package\.json|docs?\//i],
  ];
  return pathRules.find(([, pattern]) => pattern.test(paths))?.[0] ?? null;
}
