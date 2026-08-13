/**
 * Provider-independent acceptance fixtures for the project-chat product.
 *
 * These fixtures describe product contracts, not model responses. A live or
 * mocked runner can emit `ProjectChatScenarioObservation` records and use the
 * evaluator in `project-chat-evaluation.ts` to check route selection, source
 * authority, lifecycle behavior, and cost/latency budgets deterministically.
 */

import type { ProjectChatAnswerQualityContract } from "@/src/evals/project-chat-answer-quality";

export type ProjectChatScenarioId =
  | "accomplishments_same_sha"
  | "accomplishments_one_file_delta"
  | "architecture_from_memory"
  | "accomplishment_recruiter_top_three"
  | "product_value_and_difficulty"
  | "team_value_gist"
  | "senior_backend_exact_four"
  | "overview_two_paragraph"
  | "repository_knowledge_explanation"
  | "architecture_risk_assessment"
  | "refresh_research_comparison"
  | "runtime_focused_deep_dive"
  | "architecture_follow_up"
  | "prior_turn_provenance"
  | "prior_turn_source_scope"
  | "targeted_code_question"
  | "missing_production_metric"
  | "mixed_workflow_missing_p95"
  | "unsupported_deployment_topology"
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
    | "quality"
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
    answerQuality?: ProjectChatAnswerQualityContract;
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
      forbiddenTools: ["search_project_sources", "read_project_source", "refresh_project_sources"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact", "highlight"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 5,
      requiresCurrentRepositoryHeads: true,
      requiresMarkdown: true,
      requiredAnswerPatterns: ["accomplish", "architecture|platform", "test|quality"],
      forbiddenAnswerPatterns: ["mandatory human review", "tamper-evident", "always produces"],
      answerQuality: {
        minCharacters: 900,
        maxCharacters: 5_500,
        minReaderThemes: 5,
        minPrimaryItems: 4,
        maxPrimaryItems: 6,
        minDevelopedItems: 4,
        minMechanismValueItems: 3,
        minCitedItems: 4,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
        format: "markdown",
      },
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
      requiredTools: ["refresh_project_sources"],
      forbiddenTools: ["search_project_sources"],
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
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 2,
      requiresMarkdown: true,
    },
    envelope: { maxLatencyMs: 12_000, maxModelCalls: 1, maxTotalTokens: 20_000, maxEstimatedCostUsd: 0.15, ...noRepositoryWork },
  },
  {
    id: "accomplishment_recruiter_top_three",
    title: "Exactly three recruiter-facing accomplishments",
    category: "quality",
    question: "Give a recruiter exactly three strongest Workbase accomplishments. Prioritize product value and engineering difficulty.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact", "highlight"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 3,
      answerQuality: {
        minCharacters: 550,
        maxCharacters: 2_800,
        minReaderThemes: 3,
        exactPrimaryItems: 3,
        minDevelopedItems: 3,
        minMechanismValueItems: 2,
        minCitedItems: 3,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
        format: "markdown",
      },
    },
    envelope: { maxLatencyMs: 20_000, maxModelCalls: 1, maxTotalTokens: 22_000, maxEstimatedCostUsd: 0.18, ...noRepositoryWork },
  },
  {
    id: "product_value_and_difficulty",
    title: "Paraphrased end-to-end value and engineering-difficulty synthesis",
    category: "quality",
    question: "What were the hardest parts of Workbase to build that also created the most end-to-end user value? Give me the prioritized gist, not a subsystem inventory.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact", "highlight"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 3,
      answerQuality: {
        minCharacters: 700,
        maxCharacters: 4_000,
        minReaderThemes: 4,
        minPrimaryItems: 3,
        maxPrimaryItems: 5,
        minDevelopedItems: 3,
        minMechanismValueItems: 3,
        minCitedItems: 3,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
        format: "markdown",
      },
    },
    envelope: { maxLatencyMs: 22_000, maxModelCalls: 1, maxTotalTokens: 26_000, maxEstimatedCostUsd: 0.21, ...noRepositoryWork },
  },
  {
    id: "team_value_gist",
    title: "Concise team-value gist",
    category: "quality",
    question: "Give me the gist of why this project would matter to an engineering team. Use three concise bullets, ordered by value, and connect each capability to what it enables.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact", "highlight"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 3,
      answerQuality: {
        minCharacters: 450,
        maxCharacters: 2_500,
        minReaderThemes: 3,
        exactPrimaryItems: 3,
        minDevelopedItems: 3,
        minMechanismValueItems: 3,
        minCitedItems: 3,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
        format: "markdown",
      },
    },
    envelope: { maxLatencyMs: 20_000, maxModelCalls: 1, maxTotalTokens: 22_000, maxEstimatedCostUsd: 0.18, ...noRepositoryWork },
  },
  {
    id: "senior_backend_exact_four",
    title: "Exactly four senior-backend bullets with explicit omissions",
    category: "quality",
    question: "Give me exactly four bullets for a senior backend engineer. Prioritize architecture, data integrity, AI/runtime control, and reliability. Omit UI, onboarding, local setup, and routine framework choices.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 4,
      answerQuality: {
        minCharacters: 650,
        maxCharacters: 3_400,
        minReaderThemes: 4,
        exactPrimaryItems: 4,
        minDevelopedItems: 4,
        minMechanismValueItems: 3,
        minCitedItems: 4,
        forbidInternalInventory: true,
        format: "markdown",
        forbiddenPatterns: ["\\bUI\\b|onboarding|local setup|npm (?:install|run)|Tailwind"],
      },
    },
    envelope: { maxLatencyMs: 22_000, maxModelCalls: 1, maxTotalTokens: 26_000, maxEstimatedCostUsd: 0.21, ...noRepositoryWork },
  },
  {
    id: "overview_two_paragraph",
    title: "Two-paragraph non-technical overview",
    category: "quality",
    question: "Explain Workbase to a non-technical hiring manager in two concise paragraphs: what it does, why it is trustworthy, and what makes the engineering notable.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact", "highlight"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 2,
      answerQuality: {
        minCharacters: 450,
        maxCharacters: 1_800,
        minReaderThemes: 3,
        minMechanismValueItems: 2,
        minCitedItems: 2,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
        format: "paragraphs",
        forbiddenPatterns: ["\\.ts\\b|Prisma schema|implementation file"],
      },
    },
    envelope: { maxLatencyMs: 18_000, maxModelCalls: 1, maxTotalTokens: 20_000, maxEstimatedCostUsd: 0.16, ...noRepositoryWork },
  },
  {
    id: "repository_knowledge_explanation",
    title: "Repository-to-knowledge decisions and safeguards",
    category: "quality",
    question: "Explain how Workbase turns repository code into trusted, reusable project knowledge. Focus on agent decisions, safeguards, and what happens when existing memory is insufficient.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 3,
      requiredAnswerPatterns: ["repository", "project fact|highlight|memory", "insufficient|gap|research", "safeguard|bound|pin|review|validat"],
      answerQuality: {
        minCharacters: 800,
        maxCharacters: 5_000,
        minReaderThemes: 3,
        minPrimaryItems: 3,
        maxPrimaryItems: 6,
        minDevelopedItems: 3,
        minMechanismValueItems: 2,
        minCitedItems: 3,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
        format: "markdown",
      },
    },
    envelope: { maxLatencyMs: 22_000, maxModelCalls: 1, maxTotalTokens: 26_000, maxEstimatedCostUsd: 0.21, ...noRepositoryWork },
  },
  {
    id: "architecture_risk_assessment",
    title: "Balanced architecture strengths and risks",
    category: "quality",
    question: "Assess Workbase's architecture. Identify its most important strengths, meaningful risks or limitations, and why those tradeoffs matter.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 3,
      requiredAnswerPatterns: ["strength", "risk|limitation|constraint", "trade-?off|matter"],
      answerQuality: {
        minCharacters: 800,
        maxCharacters: 4_500,
        minReaderThemes: 4,
        minPrimaryItems: 3,
        maxPrimaryItems: 6,
        minDevelopedItems: 3,
        minMechanismValueItems: 2,
        minCitedItems: 3,
        requirePrioritizedOpening: true,
        forbidInternalInventory: true,
        format: "markdown",
        forbiddenPatterns: ["perfect|guarantees? correctness|eliminates? all"],
      },
    },
    envelope: { maxLatencyMs: 22_000, maxModelCalls: 1, maxTotalTokens: 26_000, maxEstimatedCostUsd: 0.21, ...noRepositoryWork },
  },
  {
    id: "refresh_research_comparison",
    title: "Refresh and targeted-research comparison table",
    category: "quality",
    question: "Compare repository knowledge refresh with targeted repository research in a concise Markdown table. Explain when to use each and how their outputs become trusted memory.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 2,
      requiredAnswerPatterns: ["refresh", "targeted (?:repository )?research", "project fact|highlight|memory"],
      answerQuality: {
        minCharacters: 400,
        maxCharacters: 2_500,
        minReaderThemes: 2,
        minMechanismValueItems: 1,
        minCitedItems: 1,
        format: "table",
      },
    },
    envelope: { maxLatencyMs: 18_000, maxModelCalls: 1, maxTotalTokens: 20_000, maxEstimatedCostUsd: 0.16, ...noRepositoryWork },
  },
  {
    id: "runtime_focused_deep_dive",
    title: "Focused model runtime and durable-workflow explanation",
    category: "quality",
    question: "Explain how the provider-neutral model tool loop and durable workflow boundaries work together to control retries, limits, and recovery. Do not list unrelated subsystems.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 2,
      requiredAnswerPatterns: ["openrouter|model (?:tool )?loop|tool (?:loop|use)", "durable workflow", "retr|limit|budget", "recover|resume|persist"],
      answerQuality: {
        minCharacters: 600,
        maxCharacters: 3_500,
        minReaderThemes: 2,
        minPrimaryItems: 2,
        maxPrimaryItems: 5,
        minDevelopedItems: 2,
        minMechanismValueItems: 2,
        minCitedItems: 2,
        format: "markdown",
        forbiddenPatterns: ["career content product|linkedin experience"],
      },
    },
    envelope: { maxLatencyMs: 20_000, maxModelCalls: 1, maxTotalTokens: 22_000, maxEstimatedCostUsd: 0.18, ...noRepositoryWork },
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
      forbiddenTools: ["search_project_sources", "inspect_prior_turn"],
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
      requiredTools: ["inspect_prior_turn"],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: ["prior_turn_provenance"],
      requiredSourceKinds: ["prior_turn_provenance"],
      allowedAuthorities: ["process_metadata"],
      minimumUsedSources: 1,
    },
    envelope: { maxLatencyMs: 2_000, maxModelCalls: 0, maxTotalTokens: 0, maxEstimatedCostUsd: 0, ...noRepositoryWork },
  },
  {
    id: "prior_turn_source_scope",
    title: "Exact historical used-information follow-up",
    category: "provenance",
    question: "Did you use any information that was not already present?",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true, hasPriorAssistantTurn: true },
    expected: {
      route: "prior_turn_provenance",
      lifecycle: ["answered"],
      requiredTools: ["inspect_prior_turn"],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: ["prior_turn_provenance"],
      requiredSourceKinds: ["prior_turn_provenance"],
      allowedAuthorities: ["process_metadata"],
      minimumUsedSources: 1,
      requiredAnswerPatterns: ["prior turn|sources actually used|used sources"],
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
      requiredTools: ["search_project_sources", "read_project_source"],
      forbiddenTools: ["refresh_project_sources"],
      allowedSourceKinds: ["project_fact", "highlight", "evidence", "github_file"],
      requiredSourceKinds: ["github_file"],
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
      forbiddenTools: ["search_project_sources", "read_project_source"],
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
    id: "mixed_workflow_missing_p95",
    title: "Supported workflow explanation with an unsupported production metric",
    category: "missing_context",
    question: "Explain how Workbase's durable project-chat workflow preserves progress, and tell me its measured production p95 latency.",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: true },
    expected: {
      route: "memory_only",
      lifecycle: ["answered"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: ["project_fact"],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 1,
      requiredAnswerPatterns: [
        "durable workflow|persist|progress|resume",
        "p95|production latency|latency percentile",
        "does not establish|not available|no measured|missing",
      ],
      forbiddenAnswerPatterns: ["p95[^.\\n]{0,50}[0-9]+(?:\\.[0-9]+)?\\s*(?:ms|s|seconds?)"],
      answerQuality: {
        minCharacters: 400,
        maxCharacters: 2_800,
        minReaderThemes: 1,
        minCitedItems: 1,
        format: "markdown",
      },
    },
    envelope: { maxLatencyMs: 20_000, maxModelCalls: 1, maxTotalTokens: 22_000, maxEstimatedCostUsd: 0.18, ...noRepositoryWork },
  },
  {
    id: "unsupported_deployment_topology",
    title: "Unsupported focused question cannot borrow unrelated memory",
    category: "missing_context",
    question: "What CDN and production deployment topology does Workbase use?",
    setup: { attachedRepositoryCount: 1, repositoryHeadsCurrent: true, approvedMemoryAdequate: false },
    expected: {
      route: "memory_only",
      lifecycle: ["insufficient_context"],
      requiredTools: [],
      forbiddenTools: ["search_project_sources", "read_project_source"],
      allowedSourceKinds: durableMemorySources,
      requiredSourceKinds: [],
      allowedAuthorities: durableMemoryAuthorities,
      minimumUsedSources: 0,
      requiresCoverageGap: true,
      forbiddenAnswerPatterns: [
        "answer could not be verified against its sources",
        "career content",
        "resume bullet",
        "linkedin",
      ],
    },
    envelope: { maxLatencyMs: 12_000, maxModelCalls: 1, maxTotalTokens: 12_000, maxEstimatedCostUsd: 0.1, ...noRepositoryWork },
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
      forbiddenTools: ["search_project_sources", "read_project_source"],
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
      forbiddenTools: ["search_project_sources"],
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
      forbiddenTools: ["search_project_sources"],
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
      forbiddenTools: ["search_project_sources", "read_project_source"],
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
      requiredTools: ["search_project_sources", "read_project_source"],
      forbiddenTools: [],
      allowedSourceKinds: ["project_fact", "highlight", "evidence", "github_file"],
      requiredSourceKinds: ["github_file"],
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
      requiredTools: ["refresh_project_sources"],
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
      forbiddenTools: ["search_project_sources"],
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
