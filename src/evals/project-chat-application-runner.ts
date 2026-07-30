/**
 * Real application-scenario contracts.
 *
 * Unlike the provider-independent fixture matrix, these scenarios are meant to
 * be executed by a driver that creates actual Workbase threads and AgentRuns.
 * The CLI driver lives in `scripts/evaluate-project-chat-application.ts` so it
 * can use a configured database, GitHub connection, and either the mock or
 * live model runtime without making those dependencies part of ordinary tests.
 */

import {
  evaluateProjectChatAnswerQuality,
  type ProjectChatAnswerQualityContract,
  type ProjectChatAnswerCitationMetadata,
} from "@/src/evals/project-chat-answer-quality";

export type ProjectChatApplicationScenarioId =
  | "memory_answer"
  | "strongest_accomplishments"
  | "recruiter_top_three"
  | "concise_project_overview"
  | "repository_knowledge_data_flow"
  | "architecture_assessment"
  | "design_tradeoffs"
  | "compare_refresh_and_research"
  | "focused_citation_behavior"
  | "durable_runtime_deep_dive"
  | "security_posture"
  | "repository_auth_permissions"
  | "resilience_recovery"
  | "artifact_fallback_behavior"
  | "frontend_review_experience"
  | "data_model_lifecycle"
  | "testing_strategy"
  | "github_ingestion_flow"
  | "known_limitations"
  | "typo_repository_refresh"
  | "greeting"
  | "insufficient_context_follow_up"
  | "product_value_and_difficulty"
  | "team_value_gist"
  | "senior_backend_exact_four"
  | "mixed_workflow_missing_p95"
  | "conversation_follow_up"
  | "prior_turn_provenance"
  | "historical_source_baseline"
  | "prior_turn_source_scope"
  | "long_thread_rollover"
  | "missing_metric"
  | "unsupported_deployment_topology"
  | "self_reported_context"
  | "artifact_routing"
  | "artifact_from_approved_context"
  | "artifact_missing_impact"
  | "artifact_review_gate"
  | "targeted_repository_research"
  | "unattached_repository_security";

export type ProjectChatApplicationWorkspace =
  | "project_memory"
  | "empty_sandbox"
  | "attached_repository_sandbox";

export type ProjectChatApplicationOutcome =
  | "answered"
  | "awaiting_review"
  | "insufficient_context"
  | "artifact_requested"
  | "artifact_completed"
  | "failed";

export interface ProjectChatApplicationScenario {
  id: ProjectChatApplicationScenarioId;
  title: string;
  question: string;
  workspace: ProjectChatApplicationWorkspace;
  threadKey: string;
  allowResearch: boolean;
  captureUserContext: boolean;
  answerContract?: ProjectChatAnswerQualityContract;
  envelope: {
    maxLatencyMs: number;
    maxModelCalls: number;
    maxTotalTokens: number;
    maxEstimatedCostUsd: number;
    maxRepositoryTreeLookups: number;
    maxRepositorySearches: number;
    maxRepositoryFileReads: number;
    maxRepositoryVisibleBytes: number;
  };
}

export interface ProjectChatApplicationCandidateObservation {
  exists: boolean;
  status: string | null;
  kind: string | null;
  highlightLifecycleStatus: string | null;
  highlightReviewState: string | null;
  evidenceTypes: string[];
}

export interface ProjectChatApplicationArtifactObservation {
  exists: boolean;
  lifecycleStatus: string | null;
  publicSafetyStatus: string | null;
  usedHighlightCount: number;
  usedEvidenceCount: number;
}

export interface ProjectChatApplicationModelAttribution {
  providers: string[];
  configuredModelIds: string[];
  actualModelIds: string[];
  routedProviders: string[];
  requestIds: string[];
  failedModelIds: string[];
  providerAttempts: number;
  failedProviderAttempts: number;
  fallbackUsed: boolean;
  profiles: Record<string, {
    providers: string[];
    configuredModelIds: string[];
    expectedModelIds: string[];
    actualModelIds: string[];
    providerAttempts: number;
    failedProviderAttempts: number;
    totalTokens: number;
    estimatedCostUsd: number;
    usageComplete: boolean;
    fallbackUsed: boolean;
    configuredRoutingMatched: boolean;
  }>;
}

export interface ProjectChatApplicationMetrics {
  latencyMs: number;
  modelCalls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /** False means at least one provider attempt returned no usage metadata. */
  usageComplete: boolean;
  /** Secret-safe provider evidence used to reject wrong-model/fallback runs. */
  modelAttribution: ProjectChatApplicationModelAttribution;
  repositoryTreeLookups: number;
  repositorySearches: number;
  repositoryFileReads: number;
  repositoryVisibleBytes: number;
}

export interface ProjectChatApplicationObservation {
  scenarioId: ProjectChatApplicationScenarioId;
  runId: string;
  threadId: string;
  workItemId: string;
  executionMode?: "inline_agent" | "durable_workflow";
  outcome: ProjectChatApplicationOutcome;
  answer: string;
  citationCount: number;
  citationKinds: string[];
  citationOrdinals: number[];
  citationMetadata?: ProjectChatAnswerCitationMetadata[];
  tools: string[];
  /** A refresh attached to this turn, even when it reused a completed run. */
  knowledgeRefreshRunId?: string | null;
  historyMessageCount: number;
  historyCharacterCount: number;
  historyCitationManifestCount: number;
  rollingSummaryCharacterCount: number;
  rollingSummaryPreservedOpeningDecision: boolean;
  rollingSummaryPreservedCitationManifest: boolean;
  historyPreservedCurrentRuntimeContext: boolean;
  candidate: ProjectChatApplicationCandidateObservation | null;
  artifact: ProjectChatApplicationArtifactObservation | null;
  coverageGaps: string[];
  metrics: ProjectChatApplicationMetrics;
  error: string | null;
}

export interface ProjectChatApplicationScenarioCheck {
  name: string;
  passed: boolean;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

export interface ProjectChatApplicationScenarioResult {
  scenario: ProjectChatApplicationScenario;
  observation: ProjectChatApplicationObservation;
  passed: boolean;
  checks: ProjectChatApplicationScenarioCheck[];
}

export interface ProjectChatApplicationDriver {
  run(scenario: ProjectChatApplicationScenario): Promise<ProjectChatApplicationObservation>;
  cleanup(): Promise<void>;
}

const noRepositoryWork = {
  maxRepositoryTreeLookups: 0,
  maxRepositorySearches: 0,
  maxRepositoryFileReads: 0,
  maxRepositoryVisibleBytes: 0,
} as const;

export const projectChatApplicationScenarios = [
  {
    id: "memory_answer",
    title: "Architecture answer from current durable memory",
    question: "How does the main architecture work?",
    workspace: "project_memory",
    threadKey: "architecture_conversation",
    allowResearch: false,
    captureUserContext: true,
    envelope: {
      maxLatencyMs: 20_000,
      maxModelCalls: 2,
      maxTotalTokens: 25_000,
      maxEstimatedCostUsd: 0.2,
      ...noRepositoryWork,
    },
  },
  {
    id: "strongest_accomplishments",
    title: "Prioritized, current strongest-accomplishments synthesis",
    question: "Summarize my strongest accomplishments and make sure your information is up to date.",
    workspace: "project_memory",
    threadKey: "strongest_accomplishments",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
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
      requiredPatterns: [
        "career content|resume|artifact",
        "repository (?:knowledge|refresh|intelligence)|semantic analys",
        "project chat|retriev|ground",
        "workflow|openrouter|model runtime|structured generation",
      ],
      forbiddenPatterns: [
        "\\b(?:every|all) (?:file|subsystem|capability)\\b",
        "\\b512[- ]dimension(?:al)?\\b",
      ],
    },
    envelope: {
      maxLatencyMs: 30_000,
      maxModelCalls: 2,
      maxTotalTokens: 35_000,
      maxEstimatedCostUsd: 0.28,
      ...noRepositoryWork,
    },
  },
  {
    id: "recruiter_top_three",
    title: "Exactly three recruiter-facing accomplishments",
    question: "Give a recruiter exactly three strongest Workbase accomplishments. Prioritize product value and engineering difficulty, and avoid low-level schema details.",
    workspace: "project_memory",
    threadKey: "recruiter_top_three",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
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
      forbiddenPatterns: [
        "\\b(?:field|column|table) names?\\b",
        "\\b(?:analyzer|policy|staticAnalysis|semanticAnalysis)Version\\b",
      ],
    },
    envelope: {
      maxLatencyMs: 25_000,
      maxModelCalls: 2,
      maxTotalTokens: 28_000,
      maxEstimatedCostUsd: 0.22,
      ...noRepositoryWork,
    },
  },
  {
    id: "concise_project_overview",
    title: "Concise non-technical project overview",
    question: "Explain Workbase to a non-technical hiring manager in two concise paragraphs: what it does, why it is trustworthy, and what makes the engineering notable.",
    workspace: "project_memory",
    threadKey: "concise_project_overview",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 450,
      maxCharacters: 1_800,
      minReaderThemes: 3,
      minMechanismValueItems: 2,
      minCitedItems: 2,
      requirePrioritizedOpening: true,
      forbidInternalInventory: true,
      format: "paragraphs",
      requiredPatterns: ["trust|ground|review|verif|source"],
      forbiddenPatterns: ["\\.ts\\b|Prisma schema|implementation file"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "repository_knowledge_data_flow",
    title: "Current repository-to-knowledge data flow and safeguards",
    question: "Make sure your answer is current through the latest GitHub commit. Explain how Workbase turns repository code into trusted, reusable project knowledge. Focus on the agent's decisions, safeguards, and what happens when existing memory is insufficient.",
    workspace: "project_memory",
    threadKey: "repository_knowledge_data_flow",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 850,
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
      requiredPatterns: [
        "repository (?:code|file|snapshot|knowledge)|github",
        "project fact|highlight|reusable (?:memory|knowledge)",
        "insufficient|gap|research",
        "safeguard|bound|pin|redact|review|validat",
      ],
    },
    envelope: {
      maxLatencyMs: 30_000,
      maxModelCalls: 2,
      maxTotalTokens: 40_000,
      maxEstimatedCostUsd: 0.32,
      ...noRepositoryWork,
    },
  },
  {
    id: "architecture_assessment",
    title: "Balanced architecture strengths and risks",
    question: "Assess Workbase's architecture. Identify its most important strengths, the most meaningful risks or limitations, and why those tradeoffs matter.",
    workspace: "project_memory",
    threadKey: "architecture_assessment",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 850,
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
      requiredPatterns: ["strength", "risk|limitation|constraint", "trade-?off|matter"],
      forbiddenPatterns: ["perfect|guarantees? correctness|eliminates? all"],
    },
    envelope: {
      maxLatencyMs: 30_000,
      maxModelCalls: 2,
      maxTotalTokens: 38_000,
      maxEstimatedCostUsd: 0.3,
      ...noRepositoryWork,
    },
  },
  {
    id: "design_tradeoffs",
    title: "Decision-oriented design tradeoffs",
    question: "What are the three most important design tradeoffs in Workbase? For each, explain the decision, what it enables, and what it costs.",
    workspace: "project_memory",
    threadKey: "design_tradeoffs",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 700,
      maxCharacters: 3_500,
      minReaderThemes: 3,
      exactPrimaryItems: 3,
      minDevelopedItems: 3,
      minMechanismValueItems: 3,
      minCitedItems: 3,
      requirePrioritizedOpening: true,
      forbidInternalInventory: true,
      format: "markdown",
      requiredPatterns: ["enable|benefit", "cost|constraint|limit|trade-?off"],
    },
    envelope: {
      maxLatencyMs: 28_000,
      maxModelCalls: 2,
      maxTotalTokens: 32_000,
      maxEstimatedCostUsd: 0.25,
      ...noRepositoryWork,
    },
  },
  {
    id: "compare_refresh_and_research",
    title: "Comparison of broad refresh and targeted research",
    question: "Compare repository knowledge refresh with targeted repository research in a concise Markdown table. Explain when Workbase should use each and how their outputs become trusted memory.",
    workspace: "project_memory",
    threadKey: "compare_refresh_and_research",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 450,
      maxCharacters: 2_500,
      minReaderThemes: 2,
      minMechanismValueItems: 1,
      minCitedItems: 1,
      format: "table",
      requiredPatterns: ["refresh", "targeted (?:repository )?research", "project fact|highlight|memory", "when|best for|use"],
    },
    envelope: {
      maxLatencyMs: 24_000,
      maxModelCalls: 2,
      maxTotalTokens: 26_000,
      maxEstimatedCostUsd: 0.21,
      ...noRepositoryWork,
    },
  },
  {
    id: "focused_citation_behavior",
    title: "Focused explanation of citation pruning",
    question: "How does Workbase keep explored-but-unused repository files out of the sources shown for a chat answer?",
    workspace: "project_memory",
    threadKey: "focused_citation_behavior",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 400,
      maxCharacters: 2_500,
      minReaderThemes: 1,
      minMechanismValueItems: 1,
      minCitedItems: 1,
      requiredPatterns: ["explor|unused", "citation|source", "project fact|highlight|durable memory|provenance"],
      forbiddenPatterns: ["(?:attaches|shows|persists|returns) (?:all accumulated citations|every explored file)"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "durable_runtime_deep_dive",
    title: "Focused technical runtime explanation",
    question: "Explain how Workbase's provider-neutral model tool loop and durable workflow boundaries work together to control retries, limits, and recovery. Be technically specific without listing unrelated subsystems.",
    workspace: "project_memory",
    threadKey: "durable_runtime_deep_dive",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 650,
      maxCharacters: 3_500,
      minReaderThemes: 2,
      minPrimaryItems: 2,
      maxPrimaryItems: 5,
      minDevelopedItems: 2,
      minMechanismValueItems: 2,
      minCitedItems: 2,
      format: "markdown",
      requiredPatterns: ["openrouter|model (?:tool )?loop|tool (?:loop|use)", "durable workflow", "retr|limit|budget", "recover|resume|persist"],
      forbiddenPatterns: ["career content product|linkedin experience"],
    },
    envelope: {
      maxLatencyMs: 28_000,
      maxModelCalls: 2,
      maxTotalTokens: 32_000,
      maxEstimatedCostUsd: 0.25,
      ...noRepositoryWork,
    },
  },
  {
    id: "security_posture",
    title: "Paraphrased security-posture question",
    question: "Explain Workbase's security posture around model and repository access.",
    workspace: "project_memory",
    threadKey: "security_posture",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 250,
      maxCharacters: 2_500,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["credential|secret|redact", "bound|authori[sz]|attached repositor"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "repository_auth_permissions",
    title: "Paraphrased authorization and permissions question",
    question: "How are authentication and repository permissions enforced?",
    workspace: "project_memory",
    threadKey: "repository_auth_permissions",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 220,
      maxCharacters: 2_000,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["github oauth|oauth", "attached|authori[sz]|permission"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "resilience_recovery",
    title: "Paraphrased resiliency and recovery question",
    question: "Where does Workbase handle resiliency and recovery?",
    workspace: "project_memory",
    threadKey: "resilience_recovery",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 250,
      maxCharacters: 2_500,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["durable workflow|workflow", "persist|resume|recover|retry"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "artifact_fallback_behavior",
    title: "Project fallback behavior is not confused with prior-turn provenance",
    question: "How does artifact fallback generation work when approved Highlights are insufficient?",
    workspace: "project_memory",
    threadKey: "artifact_fallback_behavior",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 250,
      maxCharacters: 2_500,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["artifact", "approved (?:highlight|memory)|highlight", "research|evidence gap|insufficient"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "frontend_review_experience",
    title: "User-facing workspace and review experience",
    question: "What user-facing project workspace and review experience did Workbase build?",
    workspace: "project_memory",
    threadKey: "frontend_review_experience",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 220,
      maxCharacters: 2_500,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["workspace|review", "highlight|project fact|citation|artifact"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "data_model_lifecycle",
    title: "Project-knowledge persistence and versioning",
    question: "How is project knowledge stored, versioned, corrected, and retired?",
    workspace: "project_memory",
    threadKey: "data_model_lifecycle",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 350,
      maxCharacters: 3_000,
      minReaderThemes: 1,
      minPrimaryItems: 1,
      minCitedItems: 1,
      requiredPatterns: ["persist|data model|prisma", "version|supersed|stale|retir|lifecycle"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "testing_strategy",
    title: "Automated testing strategy",
    question: "What does Workbase's automated testing strategy cover, and why is it meaningful?",
    workspace: "project_memory",
    threadKey: "testing_strategy",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 220,
      maxCharacters: 2_500,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["test|vitest|evaluation", "chat|research|artifact|workflow|security"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "github_ingestion_flow",
    title: "GitHub integration and ingestion flow",
    question: "Explain how GitHub OAuth, repository ingestion, and bounded code exploration fit together.",
    workspace: "project_memory",
    threadKey: "github_ingestion_flow",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 300,
      maxCharacters: 2_800,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["github oauth|oauth", "ingest|import", "bound|budget|limit"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "known_limitations",
    title: "Evidence-backed limitations and risks",
    question: "What are the three most important current limitations or risks in Workbase, and why do they matter?",
    workspace: "project_memory",
    threadKey: "known_limitations",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 650,
      maxCharacters: 3_500,
      minReaderThemes: 3,
      exactPrimaryItems: 3,
      minDevelopedItems: 3,
      minMechanismValueItems: 3,
      minCitedItems: 3,
      requiredPatterns: ["risk|limitation|constraint|trade-?off", "matter|cost|depend"],
    },
    envelope: {
      maxLatencyMs: 28_000,
      maxModelCalls: 2,
      maxTotalTokens: 32_000,
      maxEstimatedCostUsd: 0.25,
      ...noRepositoryWork,
    },
  },
  {
    id: "typo_repository_refresh",
    title: "Misspelled repository-refresh paraphrase",
    question: "How duz the repo knowlege refresh wrk, and how duz it avoid stale facts?",
    workspace: "project_memory",
    threadKey: "typo_repository_refresh",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 250,
      maxCharacters: 2_500,
      minReaderThemes: 1,
      minCitedItems: 1,
      requiredPatterns: ["repository|repo", "refresh|reconcil", "stale"],
    },
    envelope: {
      maxLatencyMs: 22_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "product_value_and_difficulty",
    title: "Paraphrased end-to-end value and engineering-difficulty synthesis",
    question: "What were the hardest parts of Workbase to build that also created the most end-to-end user value? Give me the prioritized gist, not a subsystem inventory.",
    workspace: "project_memory",
    threadKey: "product_value_and_difficulty",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
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
      requiredPatterns: [
        "career content|artifact|resume",
        "repository (?:knowledge|refresh|intelligence)|semantic analys",
        "project chat|retriev|ground|workflow|openrouter|model runtime",
      ],
    },
    envelope: {
      maxLatencyMs: 28_000,
      maxModelCalls: 2,
      maxTotalTokens: 32_000,
      maxEstimatedCostUsd: 0.25,
      ...noRepositoryWork,
    },
  },
  {
    id: "team_value_gist",
    title: "Team-value gist under a concise constraint",
    question: "Give me the gist of why this project would matter to an engineering team. Use three concise bullets, ordered by value, and connect each capability to what it enables.",
    workspace: "project_memory",
    threadKey: "team_value_gist",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
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
    envelope: {
      maxLatencyMs: 24_000,
      maxModelCalls: 2,
      maxTotalTokens: 26_000,
      maxEstimatedCostUsd: 0.21,
      ...noRepositoryWork,
    },
  },
  {
    id: "senior_backend_exact_four",
    title: "Exactly four senior-backend bullets with explicit omissions",
    question: "Give me exactly four bullets for a senior backend engineer. Prioritize architecture, data integrity, AI/runtime control, and reliability. Omit UI, onboarding, local setup, and routine framework choices.",
    workspace: "project_memory",
    threadKey: "senior_backend_exact_four",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 650,
      maxCharacters: 3_400,
      minReaderThemes: 4,
      exactPrimaryItems: 4,
      minDevelopedItems: 4,
      minMechanismValueItems: 3,
      minCitedItems: 4,
      forbidInternalInventory: true,
      format: "markdown",
      requiredPatterns: [
        "architect|system design|pipeline|repository intelligence",
        "data|provenance|integrity",
        "openrouter|bedrock|agent|model runtime",
        "durable|reliab|recover|bound",
      ],
      forbiddenPatterns: ["\\bUI\\b|onboarding|local setup|npm (?:install|run)|Tailwind"],
    },
    envelope: {
      maxLatencyMs: 28_000,
      maxModelCalls: 2,
      maxTotalTokens: 32_000,
      maxEstimatedCostUsd: 0.25,
      ...noRepositoryWork,
    },
  },
  {
    id: "mixed_workflow_missing_p95",
    title: "Supported workflow explanation plus an explicit missing production metric",
    question: "Explain how Workbase's durable project-chat workflow preserves progress, and tell me its measured production p95 latency.",
    workspace: "project_memory",
    threadKey: "mixed_workflow_missing_p95",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 450,
      maxCharacters: 2_800,
      minReaderThemes: 1,
      minCitedItems: 1,
      format: "markdown",
      requiredPatterns: ["durable workflow|persist|progress|resume", "p95|production latency|evidence boundary|does not establish"],
    },
    envelope: {
      maxLatencyMs: 24_000,
      maxModelCalls: 2,
      maxTotalTokens: 26_000,
      maxEstimatedCostUsd: 0.21,
      ...noRepositoryWork,
    },
  },
  {
    id: "conversation_follow_up",
    title: "Referential follow-up using real persisted history",
    question: "What does that chat layer do when current supporting evidence is missing?",
    workspace: "project_memory",
    threadKey: "architecture_conversation",
    allowResearch: false,
    captureUserContext: true,
    envelope: {
      maxLatencyMs: 15_000,
      maxModelCalls: 2,
      maxTotalTokens: 20_000,
      maxEstimatedCostUsd: 0.16,
      ...noRepositoryWork,
    },
  },
  {
    id: "prior_turn_provenance",
    title: "Observable provenance for the immediately previous answer",
    question: "Did you inspect the repository for your previous answer?",
    workspace: "project_memory",
    threadKey: "architecture_conversation",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 3_000,
      maxModelCalls: 0,
      maxTotalTokens: 0,
      maxEstimatedCostUsd: 0,
      ...noRepositoryWork,
    },
  },
  {
    id: "historical_source_baseline",
    title: "Cited baseline for the exact source-scope follow-up",
    question: "Briefly explain the main Workbase architecture and cite the durable project memory you use.",
    workspace: "project_memory",
    threadKey: "historical_source_scope",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 20_000,
      maxModelCalls: 2,
      maxTotalTokens: 24_000,
      maxEstimatedCostUsd: 0.19,
      ...noRepositoryWork,
    },
  },
  {
    id: "prior_turn_source_scope",
    title: "Exact historical source-scope follow-up",
    question: "Did you use any information that was not already present?",
    workspace: "project_memory",
    threadKey: "historical_source_scope",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 3_000,
      maxModelCalls: 0,
      maxTotalTokens: 0,
      maxEstimatedCostUsd: 0,
      ...noRepositoryWork,
    },
  },
  {
    id: "long_thread_rollover",
    title: "Long real thread uses bounded history, rolling summary, and citation manifests",
    question: "Compare that earlier decision with the current runtime in a concise Markdown table.",
    workspace: "project_memory",
    threadKey: "long_thread_rollover",
    allowResearch: false,
    captureUserContext: false,
    answerContract: {
      minCharacters: 400,
      maxCharacters: 2_800,
      minReaderThemes: 2,
      minMechanismValueItems: 1,
      minCitedItems: 1,
      format: "table",
      requiredPatterns: [
        "earlier decision",
        "repository discover|reviewed durable|project fact|durable memory",
        "current runtime",
        "openrouter|model (?:tool )?loop|tool (?:loop|limit)|token limit",
      ],
    },
    envelope: {
      maxLatencyMs: 28_000,
      maxModelCalls: 2,
      maxTotalTokens: 32_000,
      maxEstimatedCostUsd: 0.25,
      ...noRepositoryWork,
    },
  },
  {
    id: "missing_metric",
    title: "Unsupported production metric remains unsupported",
    question: "What was the production request volume?",
    workspace: "empty_sandbox",
    threadKey: "missing_metric",
    allowResearch: false,
    captureUserContext: true,
    envelope: {
      maxLatencyMs: 15_000,
      maxModelCalls: 1,
      maxTotalTokens: 12_000,
      maxEstimatedCostUsd: 0.1,
      ...noRepositoryWork,
    },
  },
  {
    id: "unsupported_deployment_topology",
    title: "Unrelated approved memory cannot answer an unsupported focused question",
    question: "What CDN and production deployment topology does Workbase use?",
    workspace: "project_memory",
    threadKey: "unsupported_deployment_topology",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 12_000,
      maxModelCalls: 1,
      maxTotalTokens: 12_000,
      maxEstimatedCostUsd: 0.1,
      ...noRepositoryWork,
    },
  },
  {
    id: "insufficient_context_follow_up",
    title: "Follow-up explains the prior evidence boundary from history",
    question: "Why couldn't you answer that?",
    workspace: "project_memory",
    threadKey: "unsupported_deployment_topology",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 8_000,
      maxModelCalls: 0,
      maxTotalTokens: 0,
      maxEstimatedCostUsd: 0,
      ...noRepositoryWork,
    },
  },
  {
    id: "greeting",
    title: "Social turn does not trigger retrieval or research",
    question: "Hi!",
    workspace: "empty_sandbox",
    threadKey: "greeting",
    allowResearch: true,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 5_000,
      maxModelCalls: 0,
      maxTotalTokens: 0,
      maxEstimatedCostUsd: 0,
      ...noRepositoryWork,
    },
  },
  {
    id: "artifact_routing",
    title: "Supported freeform artifact request enters the artifact workflow",
    question: "Write two resume bullets about the backend architecture.",
    workspace: "empty_sandbox",
    threadKey: "artifact_routing",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 3_000,
      maxModelCalls: 0,
      maxTotalTokens: 0,
      maxEstimatedCostUsd: 0,
      ...noRepositoryWork,
    },
  },
  {
    id: "artifact_from_approved_context",
    title: "Artifact is generated and persisted from approved public-safe Highlights",
    question: "Write two resume bullets about the backend architecture.",
    workspace: "empty_sandbox",
    threadKey: "artifact_from_approved_context",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 25_000,
      maxModelCalls: 2,
      maxTotalTokens: 25_000,
      maxEstimatedCostUsd: 0.2,
      ...noRepositoryWork,
    },
  },
  {
    id: "artifact_missing_impact",
    title: "Quantified artifact fails closed without measured impact evidence",
    question: "Write a quantified resume bullet about the latency improvement.",
    workspace: "empty_sandbox",
    threadKey: "artifact_missing_impact",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 20_000,
      maxModelCalls: 1,
      maxTotalTokens: 15_000,
      maxEstimatedCostUsd: 0.12,
      ...noRepositoryWork,
    },
  },
  {
    id: "artifact_review_gate",
    title: "Quarantined artifact research candidate pauses for review",
    question: "Write a resume bullet about the backend architecture.",
    workspace: "empty_sandbox",
    threadKey: "artifact_review_gate",
    allowResearch: false,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 15_000,
      maxModelCalls: 1,
      maxTotalTokens: 15_000,
      maxEstimatedCostUsd: 0.12,
      ...noRepositoryWork,
    },
  },
  {
    id: "unattached_repository_security",
    title: "Repository research is unavailable without an attached source",
    question: "Inspect arkb75/PrivateOtherRepo and compare its architecture.",
    workspace: "empty_sandbox",
    threadKey: "unattached_repository_security",
    allowResearch: true,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 5_000,
      maxModelCalls: 0,
      maxTotalTokens: 0,
      maxEstimatedCostUsd: 0,
      ...noRepositoryWork,
    },
  },
  {
    id: "self_reported_context",
    title: "Reusable self-reported impact is auto-applied for later review",
    question: "I measured a 37% reduction in import latency after adding batching.",
    workspace: "empty_sandbox",
    threadKey: "self_reported_context",
    allowResearch: false,
    captureUserContext: true,
    envelope: {
      maxLatencyMs: 15_000,
      maxModelCalls: 1,
      maxTotalTokens: 15_000,
      maxEstimatedCostUsd: 0.12,
      ...noRepositoryWork,
    },
  },
  {
    id: "targeted_repository_research",
    title: "Bounded repository research for a code-level gap",
    question: "Inspect the attached repository: where are retry limits enforced, and what terminates the loop?",
    workspace: "attached_repository_sandbox",
    threadKey: "targeted_repository_research",
    allowResearch: true,
    captureUserContext: false,
    envelope: {
      maxLatencyMs: 90_000,
      maxModelCalls: 3,
      maxTotalTokens: 55_000,
      maxEstimatedCostUsd: 0.5,
      maxRepositoryTreeLookups: 1,
      maxRepositorySearches: 2,
      maxRepositoryFileReads: 5,
      maxRepositoryVisibleBytes: 64 * 1024,
    },
  },
] as const satisfies readonly ProjectChatApplicationScenario[];

function addCheck(
  checks: ProjectChatApplicationScenarioCheck[],
  name: string,
  passed: boolean,
  actual?: ProjectChatApplicationScenarioCheck["actual"],
  expected?: ProjectChatApplicationScenarioCheck["expected"],
) {
  checks.push({ name, passed, actual, expected });
}

const repositoryTools = new Set([
  "research_project",
  "list_repository_paths",
  "search_repository",
  "read_repository_file",
  "read_repository_files",
]);

function hasRepositoryTool(observation: ProjectChatApplicationObservation) {
  return observation.tools.some((tool) => repositoryTools.has(tool));
}

function canonicalCitationSetMatches(observation: ProjectChatApplicationObservation) {
  const used = Array.from(new Set(observation.citationOrdinals)).sort((left, right) => left - right);
  return used.length === observation.citationCount && used.every((ordinal, index) => ordinal === index + 1);
}

function architectureAreaCount(answer: string) {
  return [
    /career content|resume|linkedin|project summar/i,
    /repository (?:knowledge|refresh|snapshot)|semantic analys|stale/i,
    /project chat|multi[- ]turn|conversation history/i,
    /artifact|highlight|review/i,
    /workflow|durable|retry/i,
    /retriev|citation|provenance|ground/i,
    /prisma|database|data model|postgres/i,
  ].filter((pattern) => pattern.test(answer)).length;
}

function checkPerformance(
  checks: ProjectChatApplicationScenarioCheck[],
  scenario: ProjectChatApplicationScenario,
  observation: ProjectChatApplicationObservation,
) {
  const pairs = [
    ["latency", observation.metrics.latencyMs, scenario.envelope.maxLatencyMs],
    ["model calls", observation.metrics.modelCalls, scenario.envelope.maxModelCalls],
    ["tokens", observation.metrics.totalTokens, scenario.envelope.maxTotalTokens],
    ["estimated cost", observation.metrics.estimatedCostUsd, scenario.envelope.maxEstimatedCostUsd],
    ["tree lookups", observation.metrics.repositoryTreeLookups, scenario.envelope.maxRepositoryTreeLookups],
    ["repository searches", observation.metrics.repositorySearches, scenario.envelope.maxRepositorySearches],
    ["file reads", observation.metrics.repositoryFileReads, scenario.envelope.maxRepositoryFileReads],
    ["visible bytes", observation.metrics.repositoryVisibleBytes, scenario.envelope.maxRepositoryVisibleBytes],
  ] as const;
  for (const [label, actual, maximum] of pairs) {
    addCheck(checks, `${label} within budget`, Number.isFinite(actual) && actual >= 0 && actual <= maximum, actual, maximum);
  }
  addCheck(
    checks,
    "provider usage telemetry is complete",
    observation.metrics.usageComplete,
    observation.metrics.usageComplete,
    true,
  );
  addCheck(
    checks,
    "live model execution used no fallback",
    !observation.metrics.modelAttribution.fallbackUsed,
    observation.metrics.modelAttribution.fallbackUsed,
    false,
  );
  addCheck(
    checks,
    "failed provider attempts do not exceed total attempts",
    observation.metrics.modelAttribution.failedProviderAttempts <=
      observation.metrics.modelAttribution.providerAttempts,
    observation.metrics.modelAttribution.failedProviderAttempts,
    observation.metrics.modelAttribution.providerAttempts,
  );
  const misroutedProfiles = Object.entries(
    observation.metrics.modelAttribution.profiles,
  )
    .filter(([, profile]) =>
      profile.providerAttempts > 0 &&
      !profile.configuredRoutingMatched
    )
    .map(([profile]) => profile)
    .sort();
  addCheck(
    checks,
    "observed model profiles match configured routing",
    misroutedProfiles.length === 0,
    misroutedProfiles.join(", ") || "all matched",
    "all matched",
  );
  if (observation.metrics.modelCalls === 0) {
    addCheck(checks, "zero-call telemetry is internally consistent", observation.metrics.totalTokens === 0 && observation.metrics.estimatedCostUsd === 0,
      `${observation.metrics.totalTokens} tokens / $${observation.metrics.estimatedCostUsd}`, "0 tokens / $0");
  }
}

export function evaluateProjectChatApplicationObservation(
  scenario: ProjectChatApplicationScenario,
  observation: ProjectChatApplicationObservation,
): ProjectChatApplicationScenarioResult {
  const checks: ProjectChatApplicationScenarioCheck[] = [];
  addCheck(checks, "scenario identity", observation.scenarioId === scenario.id, observation.scenarioId, scenario.id);
  addCheck(checks, "run completed without an application failure", observation.outcome !== "failed", observation.outcome, "not failed");
  addCheck(checks, "run did not retain an internal exception", observation.error === null, observation.error ?? "none", "none");
  for (const qualityCheck of evaluateProjectChatAnswerQuality({
    answer: observation.answer,
    contract: scenario.answerContract ?? {},
    citationMetadata: observation.citationMetadata,
  })) {
    addCheck(
      checks,
      qualityCheck.name,
      qualityCheck.passed,
      qualityCheck.actual,
      qualityCheck.expected,
    );
  }
  if (observation.outcome === "answered" && observation.citationCount > 0) {
    addCheck(
      checks,
      "answer citation rows match canonical markers",
      canonicalCitationSetMatches(observation),
      observation.citationOrdinals.join(","),
      `1..${observation.citationCount}`,
    );
    addCheck(
      checks,
      "answer does not expose repository files as peer sources",
      !observation.citationKinds.includes("github_file"),
      observation.citationKinds.join(", "),
      "durable memory citations only",
    );
  }

  switch (scenario.id) {
    case "memory_answer":
      addCheck(checks, "memory answer completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "memory answer is cited", observation.citationCount > 0, observation.citationCount, 1);
      addCheck(checks, "memory citation rows match canonical markers", canonicalCitationSetMatches(observation), observation.citationOrdinals.join(","), `1..${observation.citationCount}`);
      addCheck(checks, "memory answer avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "memory answer avoids superseded blanket-review claims", !/mandatory (?:human )?review|tamper-evident|prevent[^.]{0,100}\bever\b/i.test(observation.answer), observation.answer, "no stale blanket-review or absolute provenance claim");
      addCheck(checks, "memory answer covers the high-level architecture rather than one isolated file", architectureAreaCount(observation.answer) >= 3, architectureAreaCount(observation.answer), 3);
      break;
    case "security_posture":
    case "repository_auth_permissions":
    case "resilience_recovery":
    case "artifact_fallback_behavior":
    case "frontend_review_experience":
    case "data_model_lifecycle":
    case "testing_strategy":
    case "github_ingestion_flow":
    case "typo_repository_refresh":
      addCheck(checks, "focused paraphrase completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "focused paraphrase is cited", observation.citationCount > 0, observation.citationCount, 1);
      addCheck(checks, "focused paraphrase avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "focused paraphrase did not invoke prior-turn provenance", !observation.tools.includes("inspect_prior_turn_provenance"), observation.tools.join(", "), "no provenance inspection");
      break;
    case "strongest_accomplishments":
    case "recruiter_top_three":
    case "concise_project_overview":
    case "repository_knowledge_data_flow":
    case "architecture_assessment":
    case "design_tradeoffs":
    case "known_limitations":
    case "compare_refresh_and_research":
    case "focused_citation_behavior":
    case "durable_runtime_deep_dive":
    case "product_value_and_difficulty":
    case "team_value_gist":
    case "senior_backend_exact_four":
    case "historical_source_baseline":
      addCheck(checks, "general project answer completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "general project answer is grounded", observation.citationCount > 0, observation.citationCount, 1);
      addCheck(checks, "current memory answer avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      break;
    case "insufficient_context_follow_up":
      addCheck(checks, "evidence-gap follow-up completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "evidence-gap follow-up received the prior turn", observation.historyMessageCount >= 2, observation.historyMessageCount, 2);
      addCheck(checks, "evidence-gap follow-up used conversation history", /\b(?:previous answer|evidence boundary|stopped|guessing)\b/i.test(observation.answer), observation.answer, "prior evidence boundary");
      addCheck(checks, "evidence-gap follow-up avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "evidence-gap follow-up has no fabricated citation", observation.citationCount === 0, observation.citationCount, 0);
      break;
    case "greeting":
      addCheck(checks, "greeting completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "greeting stayed citation free", observation.citationCount === 0, observation.citationCount, 0);
      addCheck(checks, "greeting avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "greeting offers project-relevant help", /\bproject\b/i.test(observation.answer), observation.answer, "project-relevant response");
      break;
    case "mixed_workflow_missing_p95":
      addCheck(checks, "supported portion remains useful", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "supported workflow explanation is grounded", observation.citationCount > 0, observation.citationCount, 1);
      addCheck(checks, "mixed request avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(
        checks,
        "missing p95 is stated as an evidence boundary",
        /\b(?:p95|production latency|latency percentile)\b/i.test(observation.answer) &&
          /\b(?:does not establish|not available|no measured|missing)\b/i.test(observation.answer),
        observation.answer,
        "specific missing production p95 evidence",
      );
      addCheck(
        checks,
        "production p95 was not fabricated",
        !/\bp95\b[^.\n]{0,50}\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?)\b/i.test(observation.answer),
        observation.answer,
        "no unsupported p95 number",
      );
      break;
    case "conversation_follow_up":
      addCheck(checks, "follow-up completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "follow-up received prior messages", observation.historyMessageCount >= 2, observation.historyMessageCount, 2);
      addCheck(checks, "follow-up avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "follow-up answers the referenced chat behavior", /\b(?:fail(?:s|ed)?[- ]closed|insufficient (?:context|evidence)|supporting evidence|does not (?:answer|guess)|refus(?:e|es))\b/i.test(observation.answer), observation.answer, "fail-closed behavior when evidence is missing");
      if (observation.citationCount > 0) {
        addCheck(checks, "follow-up citation rows match canonical markers", canonicalCitationSetMatches(observation), observation.citationOrdinals.join(","), `1..${observation.citationCount}`);
      }
      break;
    case "prior_turn_provenance":
      addCheck(checks, "provenance answer completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "provenance used its bounded inspector", observation.tools.includes("inspect_prior_turn_provenance"), observation.tools.join(", "), "inspect_prior_turn_provenance");
      addCheck(checks, "process metadata is not persisted as a factual citation", observation.citationCount === 0, observation.citationCount, 0);
      addCheck(
        checks,
        "provenance avoided new repository work",
        !hasRepositoryTool(observation) && !observation.knowledgeRefreshRunId,
        Boolean(hasRepositoryTool(observation) || observation.knowledgeRefreshRunId),
        false,
      );
      break;
    case "prior_turn_source_scope":
      addCheck(checks, "source-scope answer completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "source-scope follow-up received the cited prior turn", observation.historyMessageCount >= 2, observation.historyMessageCount, 2);
      addCheck(checks, "source-scope used only its bounded provenance inspector", observation.tools.includes("inspect_prior_turn_provenance"), observation.tools.join(", "), "inspect_prior_turn_provenance");
      addCheck(checks, "source-scope did not persist process metadata as a factual citation", observation.citationCount === 0, observation.citationCount, 0);
      addCheck(checks, "source-scope avoided new repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(
        checks,
        "source-scope identifies used sources rather than re-answering from README",
        /sources actually used|used sources|prior turn/i.test(observation.answer),
        observation.answer,
        "observable used-source metadata",
      );
      break;
    case "long_thread_rollover":
      addCheck(checks, "long-thread answer completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "long-thread answer is grounded", observation.citationCount > 0, observation.citationCount, 1);
      addCheck(checks, "long-thread comparison uses current durable citations", observation.citationCount >= 2, observation.citationCount, 2);
      addCheck(checks, "long-thread fixture exceeded twelve persisted messages", observation.historyMessageCount > 12, observation.historyMessageCount, 13);
      addCheck(checks, "long-thread fixture exceeded the raw 60K history budget", observation.historyCharacterCount > 60_000, observation.historyCharacterCount, 60_001);
      addCheck(checks, "long-thread retained prior citation manifests", observation.historyCitationManifestCount > 0, observation.historyCitationManifestCount, 1);
      addCheck(checks, "long-thread supplied a rolling summary", observation.rollingSummaryCharacterCount > 0, observation.rollingSummaryCharacterCount, 1);
      addCheck(checks, "rolling summary preserved the opening decision", observation.rollingSummaryPreservedOpeningDecision, observation.rollingSummaryPreservedOpeningDecision, true);
      addCheck(checks, "rolling summary preserved a used-source manifest", observation.rollingSummaryPreservedCitationManifest, observation.rollingSummaryPreservedCitationManifest, true);
      addCheck(checks, "bounded recent history preserved current runtime context", observation.historyPreservedCurrentRuntimeContext, observation.historyPreservedCurrentRuntimeContext, true);
      addCheck(checks, "long-thread comparison preserves the earlier decision", /repository discover|reviewed durable|project fact|durable memory/i.test(observation.answer), observation.answer, "earlier repository-memory decision");
      addCheck(checks, "long-thread comparison preserves current runtime context", /current runtime|openrouter|model (?:tool )?loop|tool (?:loop|limit)|token limit/i.test(observation.answer), observation.answer, "current bounded runtime");
      {
        const earlierIndex = observation.answer.search(/earlier decision/i);
        const currentIndex = observation.answer.search(/current runtime/i);
        addCheck(
          checks,
          "long-thread comparison preserves chronology",
          earlierIndex >= 0 && currentIndex > earlierIndex,
          `${earlierIndex}/${currentIndex}`,
          "earlier decision before current runtime",
        );
      }
      addCheck(checks, "long-thread avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      break;
    case "missing_metric":
      addCheck(checks, "missing metric is explicit", observation.outcome === "insufficient_context", observation.outcome, "insufficient_context");
      addCheck(checks, "missing metric did not trigger repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "missing metric includes a coverage gap", observation.coverageGaps.length > 0, observation.coverageGaps.length, 1);
      addCheck(checks, "request volume was not fabricated", !/\b\d[\d,.]*\s*(?:k|m|million|billion)?\s*(?:requests?|rps|rpm)\b/i.test(observation.answer), observation.answer, "no numeric request-volume claim");
      break;
    case "unsupported_deployment_topology":
      addCheck(checks, "unsupported topology is explicit", observation.outcome === "insufficient_context", observation.outcome, "insufficient_context");
      addCheck(checks, "unsupported topology has no citations", observation.citationCount === 0, observation.citationCount, 0);
      addCheck(checks, "unsupported topology did not trigger repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(
        checks,
        "unsupported topology returns a specific evidence gap",
        /\b(?:does not establish|not contain|no .*support|insufficient)\b/i.test(observation.answer),
        observation.answer,
        "specific missing deployment evidence",
      );
      addCheck(
        checks,
        "unsupported topology does not leak unrelated project summaries",
        !/\b(?:career content|resume bullet|linkedin|artifact pipeline)\b/i.test(observation.answer),
        observation.answer,
        "no unrelated product memory",
      );
      addCheck(
        checks,
        "unsupported topology avoids generic verifier errors",
        !/answer could not be verified against its sources/i.test(observation.answer),
        observation.answer,
        "specific evidence gap",
      );
      break;
    case "artifact_routing":
      addCheck(checks, "artifact route selected", observation.outcome === "artifact_requested", observation.outcome, "artifact_requested");
      addCheck(checks, "routing did not research", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      break;
    case "artifact_from_approved_context":
      addCheck(checks, "artifact completed", observation.outcome === "artifact_completed", observation.outcome, "artifact_completed");
      addCheck(checks, "artifact was persisted active and public-safe",
        observation.artifact?.exists === true && observation.artifact.lifecycleStatus === "active" && observation.artifact.publicSafetyStatus === "verified",
        `${observation.artifact?.exists ?? false}/${observation.artifact?.lifecycleStatus ?? "none"}/${observation.artifact?.publicSafetyStatus ?? "none"}`,
        "true/active/verified");
      addCheck(checks, "artifact retained approved Highlight provenance", (observation.artifact?.usedHighlightCount ?? 0) > 0,
        observation.artifact?.usedHighlightCount ?? 0, 1);
      addCheck(checks, "artifact answer is cited", observation.citationCount > 0 && observation.citationKinds.includes("highlight"),
        observation.citationKinds.join(", "), "highlight");
      addCheck(checks, "artifact exposes only approved Highlights as peer sources",
        observation.citationCount === (observation.artifact?.usedHighlightCount ?? 0) &&
          !observation.citationKinds.some((kind) => kind === "evidence" || kind === "github_file"),
        observation.citationCount,
        observation.artifact?.usedHighlightCount ?? 0);
      addCheck(checks, "artifact retained nested evidence provenance",
        (observation.artifact?.usedEvidenceCount ?? 0) > 0,
        observation.artifact?.usedEvidenceCount ?? 0,
        1);
      addCheck(checks, "artifact generation avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      break;
    case "artifact_missing_impact":
      addCheck(checks, "missing impact ends insufficient", observation.outcome === "insufficient_context", observation.outcome, "insufficient_context");
      addCheck(checks, "no unsupported artifact was persisted", observation.artifact?.exists !== true,
        observation.artifact?.exists ?? false, false);
      addCheck(checks, "missing impact is explained", /(?:measured|metric|measurement|impact)/i.test(observation.answer),
        observation.answer, "specific metric coverage gap");
      addCheck(checks, "quantified impact was not fabricated", !/\b\d+(?:\.\d+)?\s*(?:%|x)\s*(?:faster|reduction|improvement)/i.test(observation.answer),
        observation.answer, "no invented quantified improvement");
      addCheck(checks, "missing impact avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      break;
    case "artifact_review_gate":
      addCheck(checks, "artifact paused for review", observation.outcome === "awaiting_review", observation.outcome, "awaiting_review");
      addCheck(checks, "pending Highlight candidate is attached", observation.candidate?.exists === true && observation.candidate.kind === "new_highlight" && observation.candidate.status === "pending",
        `${observation.candidate?.kind ?? "none"}/${observation.candidate?.status ?? "none"}`, "new_highlight/pending");
      addCheck(checks, "quarantined candidate remains unavailable to generation",
        observation.candidate?.highlightLifecycleStatus === "quarantined" && observation.artifact?.exists !== true,
        `${observation.candidate?.highlightLifecycleStatus ?? "none"}/${observation.artifact?.exists ?? false}`,
        "quarantined/false");
      addCheck(checks, "review gate avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      break;
    case "unattached_repository_security":
      addCheck(checks, "unattached request is not answered from repository data", observation.outcome === "insufficient_context", observation.outcome, "insufficient_context");
      addCheck(checks, "unattached request performed no repository tool calls", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "unattached request has no citations", observation.citationCount === 0, observation.citationCount, 0);
      break;
    case "self_reported_context":
      addCheck(checks, "self-reported statement remained answerable", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "candidate was created", observation.candidate?.exists === true, observation.candidate?.exists ?? false, true);
      addCheck(checks, "safe candidate was auto-applied", observation.candidate?.status === "approved" && observation.candidate.highlightLifecycleStatus === "active",
        `${observation.candidate?.status ?? "none"}/${observation.candidate?.highlightLifecycleStatus ?? "none"}`, "approved/active");
      addCheck(checks, "candidate remains highlighted for later review", observation.candidate?.highlightReviewState === "pending_review", observation.candidate?.highlightReviewState ?? "none", "pending_review");
      addCheck(checks, "candidate retained self-reported evidence", observation.candidate?.evidenceTypes.includes("chat_user_statement") === true,
        observation.candidate?.evidenceTypes.join(", ") ?? "none", "chat_user_statement");
      break;
    case "targeted_repository_research":
      addCheck(checks, "targeted research produced a supported answer or review candidate", ["answered", "awaiting_review"].includes(observation.outcome), observation.outcome, "answered or awaiting_review");
      addCheck(checks, "targeted research listed an attached repository", observation.tools.includes("list_repository_paths"), observation.tools.join(", "), "list_repository_paths");
      addCheck(checks, "targeted research read pinned files", observation.tools.some((tool) => tool === "read_repository_file" || tool === "read_repository_files"), observation.tools.join(", "), "read_repository_file(s)");
      addCheck(checks, "targeted answer addresses retry behavior", /\b(?:retr(?:y|ied|ies)|backoff)\b/i.test(observation.answer), observation.answer, "retry/backoff behavior");
      addCheck(checks, "targeted answer addresses loop termination", /\b(?:loop|iteration|terminat|max(?:imum)?|limit|budget)\w*\b/i.test(observation.answer), observation.answer, "loop termination or bound");
      addCheck(checks, "targeted answer identifies the concrete iteration guard", /\bmaxIterations\b|\biterations?\s*(?:>=|<=|<|>)\b/i.test(observation.answer), observation.answer, "maxIterations or an explicit iteration condition");
      addCheck(checks, "targeted answer identifies a concrete exit path", /\bstopReason\b|conditional exit|`(?:break;|return|throw)`/i.test(observation.answer), observation.answer, "an exact stop reason or exit statement");
      addCheck(checks, "targeted answer is not a generic file-presence fallback", !/contains repository evidence relevant to the requested/i.test(observation.answer), observation.answer, "a request-specific supported fact");
      addCheck(checks, "targeted answer cites promoted durable memory", observation.citationCount > 0 && !observation.citationKinds.includes("github_file"), observation.citationKinds.join(", "), "Project Fact, Highlight, or Evidence citation");
      break;
  }

  checkPerformance(checks, scenario, observation);
  return { scenario, observation, passed: checks.every((check) => check.passed), checks };
}

function mergeProfileAttribution(
  left: ProjectChatApplicationModelAttribution["profiles"],
  right: ProjectChatApplicationModelAttribution["profiles"],
) {
  return Object.fromEntries(
    Array.from(new Set([
      ...Object.keys(left),
      ...Object.keys(right),
    ])).sort().map((profile) => {
      const entries = [left[profile], right[profile]].filter(
        (entry): entry is NonNullable<typeof entry> => entry != null,
      );
      const providerAttempts = entries.reduce(
        (total, entry) => total + entry.providerAttempts,
        0,
      );
      return [profile, {
        providers: Array.from(new Set(
          entries.flatMap((entry) => entry.providers),
        )).sort(),
        configuredModelIds: Array.from(new Set(
          entries.flatMap((entry) => entry.configuredModelIds),
        )).sort(),
        expectedModelIds: Array.from(new Set(
          entries.flatMap((entry) => entry.expectedModelIds),
        )).sort(),
        actualModelIds: Array.from(new Set(
          entries.flatMap((entry) => entry.actualModelIds),
        )).sort(),
        providerAttempts,
        failedProviderAttempts: Math.min(
          providerAttempts,
          entries.reduce(
            (total, entry) => total + entry.failedProviderAttempts,
            0,
          ),
        ),
        totalTokens: entries.reduce(
          (total, entry) => total + entry.totalTokens,
          0,
        ),
        estimatedCostUsd: Number(entries.reduce(
          (total, entry) => total + entry.estimatedCostUsd,
          0,
        ).toFixed(6)),
        usageComplete: entries.every((entry) => entry.usageComplete),
        fallbackUsed: entries.some((entry) => entry.fallbackUsed),
        configuredRoutingMatched: entries.every(
          (entry) => entry.configuredRoutingMatched,
        ),
      }];
    }),
  );
}

export async function runProjectChatApplicationScenarios(input: {
  driver: ProjectChatApplicationDriver;
  scenarioIds?: readonly ProjectChatApplicationScenarioId[];
}) {
  const requested = new Set(input.scenarioIds ?? []);
  // Referential scenarios must execute against the real preceding turns; a
  // standalone fabricated prior message would defeat the purpose of this
  // application-level suite.
  if (requested.has("conversation_follow_up")) requested.add("memory_answer");
  if (requested.has("prior_turn_provenance")) {
    requested.add("memory_answer");
    requested.add("conversation_follow_up");
  }
  if (requested.has("prior_turn_source_scope")) {
    requested.add("historical_source_baseline");
  }
  if (requested.has("insufficient_context_follow_up")) {
    requested.add("unsupported_deployment_topology");
  }
  const selected = requested.size
    ? projectChatApplicationScenarios.filter((scenario) => requested.has(scenario.id))
    : [...projectChatApplicationScenarios];
  const results: ProjectChatApplicationScenarioResult[] = [];
  try {
    for (const scenario of selected) {
      const observation = await input.driver.run(scenario);
      results.push(evaluateProjectChatApplicationObservation(scenario, observation));
    }
  } finally {
    await input.driver.cleanup();
  }
  return {
    passed: results.every((result) => result.passed),
    results,
    aggregate: results.reduce((total, result) => ({
      latencyMs: total.latencyMs + result.observation.metrics.latencyMs,
      modelCalls: total.modelCalls + result.observation.metrics.modelCalls,
      totalTokens: total.totalTokens + result.observation.metrics.totalTokens,
      estimatedCostUsd: Number((total.estimatedCostUsd + result.observation.metrics.estimatedCostUsd).toFixed(6)),
      usageComplete:
        total.usageComplete && result.observation.metrics.usageComplete,
      modelAttribution: {
        providers: Array.from(new Set([
          ...total.modelAttribution.providers,
          ...result.observation.metrics.modelAttribution.providers,
        ])).sort(),
        configuredModelIds: Array.from(new Set([
          ...total.modelAttribution.configuredModelIds,
          ...result.observation.metrics.modelAttribution.configuredModelIds,
        ])).sort(),
        actualModelIds: Array.from(new Set([
          ...total.modelAttribution.actualModelIds,
          ...result.observation.metrics.modelAttribution.actualModelIds,
        ])).sort(),
        routedProviders: Array.from(new Set([
          ...total.modelAttribution.routedProviders,
          ...result.observation.metrics.modelAttribution.routedProviders,
        ])).sort(),
        requestIds: Array.from(new Set([
          ...total.modelAttribution.requestIds,
          ...result.observation.metrics.modelAttribution.requestIds,
        ])).sort(),
        failedModelIds: Array.from(new Set([
          ...total.modelAttribution.failedModelIds,
          ...result.observation.metrics.modelAttribution.failedModelIds,
        ])).sort(),
        providerAttempts:
          total.modelAttribution.providerAttempts +
          result.observation.metrics.modelAttribution.providerAttempts,
        failedProviderAttempts:
          total.modelAttribution.failedProviderAttempts +
          result.observation.metrics.modelAttribution.failedProviderAttempts,
        fallbackUsed:
          total.modelAttribution.fallbackUsed ||
          result.observation.metrics.modelAttribution.fallbackUsed,
        profiles: mergeProfileAttribution(
          total.modelAttribution.profiles,
          result.observation.metrics.modelAttribution.profiles,
        ),
      },
    }), {
      latencyMs: 0,
      modelCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
      modelAttribution: {
        providers: [] as string[],
        configuredModelIds: [] as string[],
        actualModelIds: [] as string[],
        routedProviders: [] as string[],
        requestIds: [] as string[],
        failedModelIds: [] as string[],
        providerAttempts: 0,
        failedProviderAttempts: 0,
        fallbackUsed: false,
        profiles: {},
      },
    }),
  };
}
