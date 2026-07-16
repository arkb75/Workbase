/**
 * Provider-independent acceptance fixtures for the project-chat product.
 *
 * These fixtures describe product contracts, not model responses. A live or
 * mocked runner can emit `ProjectChatScenarioObservation` records and use the
 * evaluator in `project-chat-evaluation.ts` to check route selection, source
 * authority, lifecycle behavior, and cost/latency budgets deterministically.
 */

export type ProjectChatScenarioId =
  | "accomplishments_same_sha"
  | "accomplishments_one_file_delta"
  | "architecture_from_memory"
  | "architecture_follow_up"
  | "prior_turn_provenance"
  | "targeted_code_question"
  | "missing_production_metric"
  | "artifact_from_adequate_context"
  | "artifact_missing_impact"
  | "self_reported_impact"
  | "stale_knowledge_mutation"
  | "unattached_repository_rejection"
  | "multi_repository_research"
  | "provider_limit_partial_result"
  | "long_thread_markdown";

export type ProjectChatEvaluationRoute =
  | "memory_only"
  | "targeted_repository_research"
  | "repository_refresh"
  | "prior_turn_provenance"
  | "artifact_immediate"
  | "artifact_research"
  | "context_candidate"
  | "knowledge_review"
  | "security_rejection"
  | "partial_finalization";

export type ProjectChatEvaluationLifecycle =
  | "answered"
  | "completed"
  | "awaiting_review"
  | "insufficient_context"
  | "partially_answered"
  | "mutation_applied"
  | "rejected";

export type ProjectChatEvaluationSourceKind =
  | "project_fact"
  | "highlight"
  | "evidence"
  | "artifact"
  | "github_file"
  | "prior_turn_provenance"
  | "chat_user_statement";

export type ProjectChatEvaluationAuthority =
  | "verified_project_fact"
  | "verified_highlight"
  | "included_evidence"
  | "prior_artifact"
  | "process_metadata"
  | "self_reported";

export interface ProjectChatPerformanceEnvelope {
  maxLatencyMs: number;
  maxModelCalls: number;
  maxTotalTokens: number;
  maxEstimatedCostUsd: number;
  maxRepositoryTreeLookups: number;
  maxRepositorySearches: number;
  maxRepositoryFileReads: number;
  maxRepositoryVisibleBytes: number;
  maxWorkerCount: number;
}

export interface ProjectChatEvaluationFixture {
  id: ProjectChatScenarioId;
  title: string;
  category:
    | "freshness"
    | "memory"
    | "conversation"
    | "provenance"
    | "research"
    | "missing_context"
    | "artifact"
    | "user_context"
    | "mutation"
    | "security"
    | "resilience"
    | "rendering";
  question: string;
  setup: {
    attachedRepositoryCount: number;
    repositoryHeadsCurrent: boolean;
    changedFileCount?: number;
    approvedMemoryAdequate: boolean;
    hasPriorAssistantTurn?: boolean;
    providerLimitAfterCalls?: number;
  };
  expected: {
    route: ProjectChatEvaluationRoute;
    lifecycle: readonly ProjectChatEvaluationLifecycle[];
    requiredTools: readonly string[];
    forbiddenTools: readonly string[];
    allowedSourceKinds: readonly ProjectChatEvaluationSourceKind[];
    requiredSourceKinds: readonly ProjectChatEvaluationSourceKind[];
    allowedAuthorities: readonly ProjectChatEvaluationAuthority[];
    minimumUsedSources: number;
    /**
     * For cross-repository answers, require primary support from distinct
     * attached repositories. A bounded partial answer may substitute only
     * when it carries an explicit coverage gap.
     */
    minimumRepositoryScopes?: number;
    requiresCoverageGap?: boolean;
    requiresPartialResult?: boolean;
    requiresCurrentRepositoryHeads?: boolean;
    requiresMarkdown?: boolean;
    requiredAnswerPatterns?: readonly string[];
    forbiddenAnswerPatterns?: readonly string[];
  };
  envelope: ProjectChatPerformanceEnvelope;
}

const noRepositoryWork = {
  maxRepositoryTreeLookups: 0,
  maxRepositorySearches: 0,
  maxRepositoryFileReads: 0,
  maxRepositoryVisibleBytes: 0,
  maxWorkerCount: 0,
} as const;

const durableMemorySources = ["project_fact", "highlight", "evidence", "artifact"] as const;
const durableMemoryAuthorities = [
  "verified_project_fact",
  "verified_highlight",
  "included_evidence",
  "prior_artifact",
] as const;

export const projectChatEvaluationFixtures = [
  {
    id: "accomplishments_same_sha",
    title: "Current accomplishments from an already verified repository head",
    category: "freshness",
    question: "Summarize my strongest accomplishments and make sure your information is up to date.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, changedFileCount: 0, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["research_project", "read_repository_file", "refresh_repository_knowledge"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact", "highlight"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 5,
      requiresCurrentRepositoryHeads: true,
      requiresMarkdown: true,
      requiredAnswerPatterns: ["accomplish", "architecture|platform", "test|quality"],
      forbiddenAnswerPatterns: ["mandatory human review", "tamper-evident", "always produces"],
    },
    envelope: { maxLatencyMs: 25_000, maxModelCalls: 1, maxTotalTokens: 25_000, maxEstimatedCostUsd: 0.2, ...noRepositoryWork },
  },
  {
    id: "accomplishments_one_file_delta",
    title: "Accomplishments after a one-file repository delta",
    category: "freshness",
    question: "Update my strongest accomplishments to include the latest repository change.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: false, changedFileCount: 1, approvedMemoryAdequate: false },
    expected: {
      route: "repository_refresh",
      lifecycle: ["answered", "partially_answered"],
      requiredTools: ["refresh_repository_knowledge"],
      forbiddenTools: ["research_project"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 3,
      requiresCurrentRepositoryHeads: true,
      requiresMarkdown: true,
      forbiddenAnswerPatterns: ["github.com/.+/blob/.+ as a primary source"],
    },
    envelope: {
      maxLatencyMs: 90_000,
      maxModelCalls: 3,
      maxTotalTokens: 45_000,
      maxEstimatedCostUsd: 0.4,
      maxRepositoryTreeLookups: 1,
      maxRepositorySearches: 2,
      maxRepositoryFileReads: 5,
      maxRepositoryVisibleBytes: 64 * 1024,
      maxWorkerCount: 1,
    },
  },
  {
    id: "architecture_from_memory",
    title: "Architecture answer from approved current memory",
    category: "memory",
    question: "How does the main architecture work?",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["research_project", "read_repository_file"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 2,
      requiresMarkdown: true,
    },
    envelope: { maxLatencyMs: 12_000, maxModelCalls: 1, maxTotalTokens: 20_000, maxEstimatedCostUsd: 0.15, ...noRepositoryWork },
  },
  {
    id: "architecture_follow_up",
    title: "Multi-turn architecture follow-up",
    category: "conversation",
    question: "What does that chat layer do when current supporting evidence is missing?",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true, hasPriorAssistantTurn: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["research_project", "inspect_prior_turn_provenance"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 1,
    },
    envelope: { maxLatencyMs: 8_000, maxModelCalls: 1, maxTotalTokens: 12_000, maxEstimatedCostUsd: 0.1, ...noRepositoryWork },
  },
  {
    id: "prior_turn_provenance",
    title: "Prior-turn process provenance",
    category: "provenance",
    question: "Did you inspect the repository for your previous answer?",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true, hasPriorAssistantTurn: true },
    expected: {
      route: "prior_turn_provenance",
      lifecycle: ["answered"],
      requiredTools: ["inspect_prior_turn_provenance"],
      forbiddenTools: ["research_project", "read_repository_file"],
      allowedSourceKinds: ["prior_turn_provenance"],
      requiredSourceKinds: ["prior_turn_provenance"],
      allowedAuthorities: ["process_metadata"],
      minimumUsedSources: 1,
    },
    envelope: { maxLatencyMs: 2_000, maxModelCalls: 0, maxTotalTokens: 0, maxEstimatedCostUsd: 0, ...noRepositoryWork },
  },
  {
    id: "targeted_code_question",
    title: "Targeted code question absent from memory",
    category: "research",
    question: "Where is retry backoff enforced, and what terminates the loop?",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: false },
    expected: {
      route: "targeted_repository_research",
      lifecycle: ["answered", "awaiting_review", "partially_answered"],
      requiredTools: ["research_project"],
      forbiddenTools: ["refresh_repository_knowledge"],
      allowedSourceKinds: ["project_fact", "highlight", "evidence"],
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: ["verified_project_fact", "verified_highlight", "included_evidence"],
      minimumUsedSources: 1,
    },
    envelope: {
      maxLatencyMs: 45_000,
      maxModelCalls: 3,
      maxTotalTokens: 50_000,
      maxEstimatedCostUsd: 0.45,
      maxRepositoryTreeLookups: 1,
      maxRepositorySearches: 2,
      maxRepositoryFileReads: 5,
      maxRepositoryVisibleBytes: 64 * 1024,
      maxWorkerCount: 1,
    },
  },
  {
    id: "missing_production_metric",
    title: "Unsupported production metric",
    category: "missing_context",
    question: "What was the production request volume?",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: false },
    expected: {
      route: "memory_only",
      lifecycle: ["insufficient_context"],
      requiredTools: [],
      forbiddenTools: ["research_project", "read_repository_file"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: [],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 0,
      requiresCoverageGap: true,
      forbiddenAnswerPatterns: ["requests per second", "million requests"],
    },
    envelope: { maxLatencyMs: 15_000, maxModelCalls: 1, maxTotalTokens: 20_000, maxEstimatedCostUsd: 0.15, ...noRepositoryWork },
  },
  {
    id: "artifact_from_adequate_context",
    title: "Artifact generated from adequate approved highlights",
    category: "artifact",
    question: "Write two resume bullets about the backend architecture.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "artifact_immediate",
      lifecycle: ["completed"],
      requiredTools: ["request_artifact"],
      forbiddenTools: ["research_project", "read_repository_file"],
      allowedSourceKinds: ["highlight"],
      requiredSourceKinds: ["highlight"],
      allowedAuthorities: ["verified_highlight"],
      minimumUsedSources: 1,
    },
    envelope: { maxLatencyMs: 25_000, maxModelCalls: 2, maxTotalTokens: 35_000, maxEstimatedCostUsd: 0.3, ...noRepositoryWork },
  },
  {
    id: "artifact_missing_impact",
    title: "Artifact request missing impact evidence",
    category: "artifact",
    question: "Write a quantified resume bullet about the latency improvement.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: false },
    expected: {
      route: "artifact_research",
      lifecycle: ["awaiting_review", "insufficient_context"],
      requiredTools: ["request_artifact"],
      forbiddenTools: [],
      allowedSourceKinds: ["highlight", "project_fact", "evidence"],
      requiredSourceKinds: [],
      allowedAuthorities: ["verified_highlight", "verified_project_fact", "included_evidence"],
      minimumUsedSources: 0,
      requiresCoverageGap: true,
      forbiddenAnswerPatterns: ["[0-9]+% faster", "[0-9]+x faster"],
    },
    envelope: {
      maxLatencyMs: 75_000,
      maxModelCalls: 3,
      maxTotalTokens: 55_000,
      maxEstimatedCostUsd: 0.5,
      maxRepositoryTreeLookups: 1,
      maxRepositorySearches: 2,
      maxRepositoryFileReads: 5,
      maxRepositoryVisibleBytes: 64 * 1024,
      maxWorkerCount: 1,
    },
  },
  {
    id: "self_reported_impact",
    title: "Reusable self-reported impact statement",
    category: "user_context",
    question: "I measured a 37% reduction in import latency after adding batching.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: false },
    expected: {
      route: "context_candidate",
      lifecycle: ["answered", "awaiting_review"],
      requiredTools: ["propose_highlight_from_context"],
      forbiddenTools: ["research_project"],
      allowedSourceKinds: ["chat_user_statement"],
      requiredSourceKinds: ["chat_user_statement"],
      allowedAuthorities: ["self_reported"],
      minimumUsedSources: 1,
      requiredAnswerPatterns: ["self-reported|user-provided"],
    },
    envelope: { maxLatencyMs: 15_000, maxModelCalls: 1, maxTotalTokens: 20_000, maxEstimatedCostUsd: 0.15, ...noRepositoryWork },
  },
  {
    id: "stale_knowledge_mutation",
    title: "Explicit stale-knowledge correction from the update inbox",
    category: "mutation",
    question: "In the project update inbox, edit the stale Project Fact to say the review gate is no longer mandatory, then keep the successor.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "knowledge_review",
      lifecycle: ["mutation_applied", "awaiting_review"],
      requiredTools: ["knowledge_review.resolve"],
      forbiddenTools: ["research_project"],
      allowedSourceKinds: ["project_fact", "chat_user_statement"],
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: ["verified_project_fact", "self_reported"],
      minimumUsedSources: 1,
    },
    envelope: { maxLatencyMs: 3_000, maxModelCalls: 0, maxTotalTokens: 0, maxEstimatedCostUsd: 0, ...noRepositoryWork },
  },
  {
    id: "unattached_repository_rejection",
    title: "Unattached repository access is rejected",
    category: "security",
    question: "Inspect arkb75/PrivateOtherRepo and compare its architecture.",
    setup: { attachedRepositoryCount: 0, repositoryHeadsCurrent: false, approvedMemoryAdequate: false },
    expected: {
      route: "security_rejection",
      lifecycle: ["rejected", "insufficient_context"],
      requiredTools: [],
      forbiddenTools: ["research_project", "read_repository_file", "list_repository_paths"],
      allowedSourceKinds: [],
      requiredSourceKinds: [],
      allowedAuthorities: [],
      minimumUsedSources: 0,
      requiresCoverageGap: true,
      requiredAnswerPatterns: ["attached|authorized"],
    },
    envelope: { maxLatencyMs: 2_000, maxModelCalls: 0, maxTotalTokens: 0, maxEstimatedCostUsd: 0, ...noRepositoryWork },
  },
  {
    id: "multi_repository_research",
    title: "Bounded research across multiple attached repositories",
    category: "research",
    question: "Compare the request flow across both attached repositories.",
    setup: { attachedRepositoryCount: 2, repositoryHeadsCurrent: true, approvedMemoryAdequate: false },
    expected: {
      route: "targeted_repository_research",
      lifecycle: ["answered", "awaiting_review", "partially_answered"],
      requiredTools: ["research_project"],
      forbiddenTools: [],
      allowedSourceKinds: ["project_fact", "highlight", "evidence"],
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: ["verified_project_fact", "verified_highlight", "included_evidence"],
      minimumUsedSources: 2,
      minimumRepositoryScopes: 2,
    },
    envelope: {
      maxLatencyMs: 90_000,
      maxModelCalls: 4,
      maxTotalTokens: 80_000,
      maxEstimatedCostUsd: 0.75,
      maxRepositoryTreeLookups: 2,
      maxRepositorySearches: 4,
      maxRepositoryFileReads: 8,
      maxRepositoryVisibleBytes: 128 * 1024,
      maxWorkerCount: 2,
    },
  },
  {
    id: "provider_limit_partial_result",
    title: "Provider limit preserves supported partial findings",
    category: "resilience",
    question: "Give me a comprehensive current architecture assessment.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: false, approvedMemoryAdequate: false, providerLimitAfterCalls: 2 },
    expected: {
      route: "partial_finalization",
      lifecycle: ["partially_answered", "awaiting_review", "insufficient_context"],
      requiredTools: ["refresh_repository_knowledge"],
      forbiddenTools: [],
      allowedSourceKinds: ["project_fact", "highlight", "evidence"],
      requiredSourceKinds: [],
      allowedAuthorities: ["verified_project_fact", "verified_highlight", "included_evidence"],
      minimumUsedSources: 0,
      requiresCoverageGap: true,
      requiresPartialResult: true,
      requiredAnswerPatterns: ["partial|coverage gap|could not inspect"],
    },
    envelope: {
      maxLatencyMs: 90_000,
      maxModelCalls: 3,
      maxTotalTokens: 60_000,
      maxEstimatedCostUsd: 0.5,
      maxRepositoryTreeLookups: 1,
      maxRepositorySearches: 2,
      maxRepositoryFileReads: 5,
      maxRepositoryVisibleBytes: 64 * 1024,
      maxWorkerCount: 1,
    },
  },
  {
    id: "long_thread_markdown",
    title: "Long multi-turn thread with Markdown rendering",
    category: "rendering",
    question: "Turn that into a concise comparison table and keep the citations.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true, hasPriorAssistantTurn: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["research_project"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 1,
      requiresMarkdown: true,
      requiredAnswerPatterns: ["\\|.+\\|"],
      forbiddenAnswerPatterns: ["<script", "javascript:"],
    },
    envelope: { maxLatencyMs: 20_000, maxModelCalls: 1, maxTotalTokens: 40_000, maxEstimatedCostUsd: 0.3, ...noRepositoryWork },
  },
] as const satisfies readonly ProjectChatEvaluationFixture[];

/** Backwards-compatible lookup for focused runners. */
export function getProjectChatEvaluationFixture(id: ProjectChatScenarioId): ProjectChatEvaluationFixture | undefined {
  return projectChatEvaluationFixtures.find((fixture) => fixture.id === id);
}
