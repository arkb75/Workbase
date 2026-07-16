/**
 * Real application-scenario contracts.
 *
 * Unlike the provider-independent fixture matrix, these scenarios are meant to
 * be executed by a driver that creates actual Workbase threads and AgentRuns.
 * The CLI driver lives in `scripts/evaluate-project-chat-application.ts` so it
 * can use a configured database, GitHub connection, and either the mock or
 * Bedrock runtime without making those dependencies part of ordinary tests.
 */

export type ProjectChatApplicationScenarioId =
  | "memory_answer"
  | "conversation_follow_up"
  | "prior_turn_provenance"
  | "missing_metric"
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

export interface ProjectChatApplicationMetrics {
  latencyMs: number;
  modelCalls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /** False means at least one provider attempt returned no usage metadata. */
  usageComplete: boolean;
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
  outcome: ProjectChatApplicationOutcome;
  answer: string;
  citationCount: number;
  citationKinds: string[];
  citationOrdinals: number[];
  tools: string[];
  historyMessageCount: number;
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

  switch (scenario.id) {
    case "memory_answer":
      addCheck(checks, "memory answer completed", observation.outcome === "answered", observation.outcome, "answered");
      addCheck(checks, "memory answer is cited", observation.citationCount > 0, observation.citationCount, 1);
      addCheck(checks, "memory citation rows match canonical markers", canonicalCitationSetMatches(observation), observation.citationOrdinals.join(","), `1..${observation.citationCount}`);
      addCheck(checks, "memory answer avoided repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "memory answer avoids superseded blanket-review claims", !/mandatory (?:human )?review|tamper-evident|prevent[^.]{0,100}\bever\b/i.test(observation.answer), observation.answer, "no stale blanket-review or absolute provenance claim");
      addCheck(checks, "memory answer covers the high-level architecture rather than one isolated file", architectureAreaCount(observation.answer) >= 3, architectureAreaCount(observation.answer), 3);
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
      addCheck(checks, "provenance avoided new repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      break;
    case "missing_metric":
      addCheck(checks, "missing metric is explicit", observation.outcome === "insufficient_context", observation.outcome, "insufficient_context");
      addCheck(checks, "missing metric did not trigger repository work", !hasRepositoryTool(observation), hasRepositoryTool(observation), false);
      addCheck(checks, "missing metric includes a coverage gap", observation.coverageGaps.length > 0, observation.coverageGaps.length, 1);
      addCheck(checks, "request volume was not fabricated", !/\b\d[\d,.]*\s*(?:k|m|million|billion)?\s*(?:requests?|rps|rpm)\b/i.test(observation.answer), observation.answer, "no numeric request-volume claim");
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
    }), { latencyMs: 0, modelCalls: 0, totalTokens: 0, estimatedCostUsd: 0 }),
  };
}
