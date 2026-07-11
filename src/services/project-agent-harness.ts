import { createHash } from "node:crypto";
import type { ProjectKnowledgeHit } from "@/src/domain/project-chat";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { looksLikeArtifactRequest } from "@/src/services/artifact-brief-service";

export const PROJECT_AGENT_HARNESS_VERSION = "v3";
export const PROJECT_AGENT_PROMPT_VERSION = "project-agent-v3.0";
export const PROJECT_RESEARCH_CONTROLLER_VERSION = "project-research-fsm-v3.0";

export type ProjectTurnIntentKind =
  | "direct_answer"
  | "repository_research"
  | "artifact_request"
  | "candidate_review"
  | "prior_turn_provenance"
  | "clarification";

export interface ProjectTurnIntent {
  kind: ProjectTurnIntentKind;
  freshness: "required" | "preferred" | "none";
  coverage: "targeted" | "broad_synthesis" | "bounded_comprehensive";
  deliverable: string;
  references: string[];
  confidence: number;
  reason: string;
}

export interface AttachedRepositoryCapability {
  sourceId: string;
  name: string;
  importedAt: string;
  pinnedSha?: string | null;
  committedAt?: string | null;
  resolvedAt?: string | null;
}

export interface ProjectAgentTurnContext {
  objective: string;
  intent: ProjectTurnIntent;
  knowledge: {
    approvedHighlights: number;
    approvedProjectFacts: number;
    includedEvidence: number;
    priorArtifacts: number;
    latestDurableMemoryAt: string | null;
    latestSourceImportedAt: string | null;
    latestRepositoryCommitAt: string | null;
    latestRepositoryInspectedAt: string | null;
    latestFactApprovedAt: string | null;
  };
  capabilities: {
    repositoryResearch: {
      available: boolean;
      unavailableReason: string | null;
      repositories: AttachedRepositoryCapability[];
      readOnly: true;
      rawFilesAreProvenanceOnly: true;
      requiresProjectFactApproval: true;
      maxRepositories: 3;
    };
    artifactTypes: ["resume_bullets", "linkedin_experience", "project_summary"];
    pendingCandidateIds: string[];
  };
  run: {
    phase: "routing" | "answering" | "planning" | "searching" | "reading" | "extracting" | "awaiting_review" | "finalizing";
    pass: number;
    remaining: {
      treeLookups: number;
      searches: number;
      fileReads: number;
      visibleBytes: number;
      explorationTokens: number;
      finalizationTokens: number;
    };
    allowedActions: string[];
  };
  policy: {
    answerFromHistoryFirst: true;
    noUnsupportedClaims: true;
    publicArtifactsRequireApprovedHighlights: true;
  };
  runtime: {
    appRevision: string;
    modelId: string;
    provider: "bedrock" | "mock";
    harnessVersion: string;
    promptVersion: string;
    researchControllerVersion: string;
    capabilityManifestHash: string;
  };
}

const freshnessPattern = /\b(?:up[- ]to[- ]date|latest|recent|newest|current(?:ly)?)\b/i;
const repositoryPattern = /\b(?:repo|repository|github|source code|codebase)\b/i;
const inspectPattern = /\b(?:inspect|search|read|check|look at|access|pull|refresh|scan|explore)\b/i;
const comprehensivePattern = /\b(?:comprehensive|everything|entire|whole|thorough|all (?:the )?files|across (?:the )?repo)\b/i;
const broadSynthesisPattern = /\b(?:summarize|summary|overview|strongest|accomplishments?|achievements?|whole project|project-wide|across the project)\b/i;
const provenancePattern = /\b(?:did you (?:use|inspect|search|read|call|access)|what (?:sources?|tools?|information) did you|which sources?|what sources?|use anything new|inspect(?:ed)? the repo|repository tools?|tool calls?|fallback|partial (?:answer|run|result))\b/i;
const codePattern = /\b(?:code|file|function|class|component|route|api|schema|database|auth|architecture|implementation|data flow|dependency|config|bug)\b/i;
const reviewPattern = /\b(?:approve|deny|reject)\b/i;

function highAuthorityMemory(hits: readonly ProjectKnowledgeHit[]) {
  return hits.some((hit) =>
    hit.authority === "verified_highlight" ||
    hit.authority === "verified_project_fact" ||
    hit.authority === "included_evidence"
  );
}

export function routeProjectTurn(input: {
  question: string;
  memoryHits: readonly ProjectKnowledgeHit[];
  pendingCandidateIds?: readonly string[];
  allowResearch?: boolean;
}): ProjectTurnIntent {
  const question = input.question.trim();
  const freshness = freshnessPattern.test(question) ? "required" : "none";
  const coverage = comprehensivePattern.test(question)
    ? "bounded_comprehensive"
    : broadSynthesisPattern.test(question)
      ? "broad_synthesis"
      : "targeted";

  if (looksLikeArtifactRequest(question)) {
    return { kind: "artifact_request", freshness, coverage, deliverable: question, references: [], confidence: 1, reason: "Explicit supported artifact request." };
  }
  if (provenancePattern.test(question)) {
    return { kind: "prior_turn_provenance", freshness: "none", coverage: "targeted", deliverable: "Explain the prior turn's observable provenance.", references: [], confidence: 0.98, reason: "Explicit prior-turn process or source question." };
  }
  if (reviewPattern.test(question) && input.pendingCandidateIds?.length) {
    return { kind: "candidate_review", freshness: "none", coverage: "targeted", deliverable: "Resolve an explicitly identified candidate review.", references: [...input.pendingCandidateIds], confidence: 0.9, reason: "Review language was used while candidates are pending." };
  }

  const explicitRepositoryResearch = repositoryPattern.test(question) && (inspectPattern.test(question) || freshness === "required");
  const unsupportedCodeQuestion = codePattern.test(question) && !highAuthorityMemory(input.memoryHits);
  if (input.allowResearch !== false && (explicitRepositoryResearch || freshness === "required" || unsupportedCodeQuestion)) {
    return {
      kind: "repository_research",
      freshness,
      coverage,
      deliverable: question,
      references: [],
      confidence: explicitRepositoryResearch || freshness === "required" ? 0.99 : 0.82,
      reason: explicitRepositoryResearch
        ? "The user explicitly requested attached-repository inspection."
        : freshness === "required"
          ? "The user requires current information that durable memory cannot establish."
          : "A code-level question lacks adequate durable technical memory.",
    };
  }

  return {
    kind: "direct_answer",
    freshness,
    coverage,
    deliverable: question,
    references: [],
    confidence: highAuthorityMemory(input.memoryHits) ? 0.92 : 0.7,
    reason: input.allowResearch === false
      ? "This is a post-review finalization turn; only approved memory is eligible."
      : "Conversation history and retrieved durable memory are the primary answer sources.",
  };
}

export function buildProjectAgentTurnContext(input: {
  question: string;
  intent: ProjectTurnIntent;
  hits: readonly ProjectKnowledgeHit[];
  repositories: AttachedRepositoryCapability[];
  pendingCandidateIds?: string[];
  modelId?: string;
  appRevision?: string;
  phase?: ProjectAgentTurnContext["run"]["phase"];
  allowedActions?: string[];
  latestFactApprovedAt?: string | null;
}): ProjectAgentTurnContext {
  const latestSourceImportedAt = input.repositories
    .map((repository) => repository.importedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const latestRepositoryCommitAt = input.repositories
    .flatMap((repository) => repository.committedAt ? [repository.committedAt] : [])
    .sort()
    .at(-1) ?? null;
  const latestRepositoryInspectedAt = input.repositories
    .flatMap((repository) => repository.resolvedAt ? [repository.resolvedAt] : [])
    .sort()
    .at(-1) ?? null;
  // Retained for compatibility with older prompt consumers. It now reflects
  // the freshest authoritative snapshot rather than merely the import time.
  const latestMemoryAt = latestRepositoryInspectedAt ?? latestRepositoryCommitAt ?? latestSourceImportedAt;
  const manifestSeed = {
    intent: input.intent,
    repositories: input.repositories.map((repository) => ({ sourceId: repository.sourceId, name: repository.name })),
    pendingCandidateIds: input.pendingCandidateIds ?? [],
    versions: [PROJECT_AGENT_HARNESS_VERSION, PROJECT_AGENT_PROMPT_VERSION, PROJECT_RESEARCH_CONTROLLER_VERSION],
  };
  const provider = resolveWorkbaseLlmProvider();

  return {
    objective: input.question,
    intent: input.intent,
    knowledge: {
      approvedHighlights: input.hits.filter((hit) => hit.authority === "verified_highlight").length,
      approvedProjectFacts: input.hits.filter((hit) => hit.authority === "verified_project_fact").length,
      includedEvidence: input.hits.filter((hit) => hit.authority === "included_evidence").length,
      priorArtifacts: input.hits.filter((hit) => hit.authority === "prior_artifact").length,
      latestDurableMemoryAt: latestMemoryAt,
      latestSourceImportedAt,
      latestRepositoryCommitAt,
      latestRepositoryInspectedAt,
      latestFactApprovedAt: input.latestFactApprovedAt ?? null,
    },
    capabilities: {
      repositoryResearch: {
        available: input.repositories.length > 0,
        unavailableReason: input.repositories.length ? null : "No attached GitHub repository is available.",
        repositories: input.repositories.slice(0, 3),
        readOnly: true,
        rawFilesAreProvenanceOnly: true,
        requiresProjectFactApproval: true,
        maxRepositories: 3,
      },
      artifactTypes: ["resume_bullets", "linkedin_experience", "project_summary"],
      pendingCandidateIds: input.pendingCandidateIds ?? [],
    },
    run: {
      phase: input.phase ?? "routing",
      pass: 1,
      remaining: {
        treeLookups: Math.min(input.repositories.length, 3),
        searches: 2,
        fileReads: 8,
        visibleBytes: 64 * 1024,
        explorationTokens: 60_000,
        finalizationTokens: 20_000,
      },
      allowedActions: input.allowedActions ?? [input.intent.kind],
    },
    policy: {
      answerFromHistoryFirst: true,
      noUnsupportedClaims: true,
      publicArtifactsRequireApprovedHighlights: true,
    },
    runtime: {
      appRevision: input.appRevision ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "local",
      modelId: input.modelId ?? process.env.WORKBASE_BEDROCK_MODEL_ID ?? "mock",
      provider,
      harnessVersion: PROJECT_AGENT_HARNESS_VERSION,
      promptVersion: PROJECT_AGENT_PROMPT_VERSION,
      researchControllerVersion: PROJECT_RESEARCH_CONTROLLER_VERSION,
      capabilityManifestHash: createHash("sha256").update(JSON.stringify(manifestSeed)).digest("hex"),
    },
  };
}

export function toModelCapabilityManifest(context: ProjectAgentTurnContext) {
  return {
    objective: context.objective,
    intent: context.intent,
    knowledge: context.knowledge,
    capabilities: context.capabilities,
    run: context.run,
    policy: context.policy,
  };
}
