import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import {
  analyzeRepositoryFile,
  analyzeRepositoryFileBatch,
  analyzeRepositoryFiles,
  BASE_COVERAGE_TARGETS,
  buildCoverageMatrix,
  createRepositorySemanticBudget,
  isRepositoryImplementationPathForCapability,
  selectRequiredSemanticCoverageAreas,
  snapshotRepositorySemanticBudget,
  type RepositoryFileAnalysis,
  type RepositorySemanticBudgetUsage,
} from "@/src/services/repository-coverage-service";
import {
  REPOSITORY_SEMANTIC_ANALYZER_VERSION,
  repositoryKnowledgeSyncService,
  type RepositoryTargetHead,
} from "@/src/services/repository-knowledge-sync-service";
import { appendAgentRunEvent } from "@/src/services/project-chat-store";

export const REPOSITORY_ORCHESTRATION_POLICY_VERSION = "repository-adaptive-coverage-v2";
export const REPOSITORY_ORCHESTRATION_MAX_WORKERS = 5;
export const REPOSITORY_ORCHESTRATION_MAX_TOTAL_TOKENS = 80_000;
const MAX_FILES_PER_WORKER = 8;
const SEMANTIC_MICRO_BATCH_SIZE = 4;
const MAX_SELECTED_SEMANTIC_FILES = 32;

const SEMANTIC_SIGNAL_RULES = [
  ["product_surface.user_entrypoint", "product_surface", /(?:^README(?:\.[^.]+)?$|(?:^|\/)(?:page|screen|view|component|template)[^/]*\.)/i],
  ["domain_data.schema_boundary", "domain_data", /(?:schema|model|entity|migration|\.prisma$)/i],
  ["application_logic.service_boundary", "application_logic", /(?:service|use-?case|handler|processor|engine)/i],
  ["interfaces_integrations.request_boundary", "interfaces_integrations", /(?:api|route|controller|client|adapter|connector|webhook)/i],
  ["automation_workflows.execution_boundary", "automation_workflows", /(?:workflow|job|queue|worker|pipeline|scheduler|cron)/i],
  ["intelligence_search.query_boundary", "intelligence_search", /(?:agent|llm|inference|embedding|retriev|search|rank|recommend)/i],
  ["security_reliability.control_boundary", "security_reliability", /(?:auth|security|permission|guard|validat|retry|error|health|telemetry)/i],
  ["tests_operations.executable_contract", "tests_operations", /(?:__tests__|tests?|specs?|\.test\.|\.spec\.|scripts?|deploy|docker|terraform)/i],
] as const;

export function semanticSignalKeysForFile(input: {
  path: string;
  capabilityKeys: string[];
}) {
  const capabilities = new Set(input.capabilityKeys);
  return Array.from(new Set([
    ...SEMANTIC_SIGNAL_RULES.flatMap(([signalKey, capabilityKey, pathPattern]) =>
    capabilities.has(capabilityKey) && pathPattern.test(input.path) ? [signalKey] : []
    ),
    ...input.capabilityKeys
      .filter((key) => key.startsWith("project_domain:"))
      .map((key) => `${key}.implementation`),
  ]));
}

export interface SemanticWorkPackage {
  id: string;
  objective: string;
  capabilityKeys: string[];
  fileSnapshotIds: string[];
  questions: string[];
  expectedOutputs: string[];
  budget: {
    maxWorkers: number;
    maxModelCalls: number;
    maxInputBytes: number;
    maxOutputTokens: number;
    maxTotalTokens: number;
    maxRepairPasses: 0 | 1;
  };
}

type CapabilityManifestArea = {
  key: string;
  label: string;
  /** Distinguishes the same capability in separate immutable repository snapshots. */
  scopeKey?: string;
  requiredSemanticPathCount?: number;
  files: Array<{ id: string; path: string; score: number }>;
};

export interface CapabilityCandidate {
  key: string;
  statement: string;
  kind: "behavior" | "data_flow" | "invariant" | "integration" | "user_capability";
  evidence: Array<{ fileSnapshotId: string; lineStart: number; lineEnd: number }>;
  confidence: "low" | "medium" | "high";
  supportedQualifiers: string[];
  unresolved: string[];
}

export interface CapabilityReport {
  packageId: string;
  inspectedFileSnapshotIds: string[];
  candidates: CapabilityCandidate[];
  contradictions: string[];
  gaps: string[];
  tokenUsage: unknown[];
  usage: RepositorySemanticBudgetUsage;
  partial: boolean;
  diagnosticNotes?: string[];
  cacheHits?: Array<{
    fileSnapshotId: string;
    cachedFileSnapshotId: string;
    blobSha: string;
  }>;
}

/**
 * Divide the fixed global semantic budget by planned provider work instead of
 * worker count. Equal worker slices strand capacity whenever one package needs
 * two micro-batches and another needs only one.
 */
export function allocateSemanticWorkerTokenBudgets(input: {
  totalTokens: number;
  modelCallCounts: number[];
}) {
  if (!Number.isInteger(input.totalTokens) || input.totalTokens < 0) {
    throw new Error("totalTokens must be a non-negative integer.");
  }
  if (input.modelCallCounts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new Error("Every semantic worker must reserve at least one model call.");
  }
  const totalCalls = input.modelCallCounts.reduce((total, count) => total + count, 0);
  if (!totalCalls) return [];
  const allocations = input.modelCallCounts.map((count) =>
    Math.floor((input.totalTokens * count) / totalCalls)
  );
  let remainder = input.totalTokens - allocations.reduce((total, value) => total + value, 0);
  for (const index of input.modelCallCounts
    .map((count, index) => ({ count, index }))
    .sort((left, right) => right.count - left.count || left.index - right.index)
    .map((entry) => entry.index)) {
    if (remainder <= 0) break;
    allocations[index]! += 1;
    remainder -= 1;
  }
  return allocations;
}

export function semanticPlannerTokenReserve(usage: {
  totalTokens: number;
  unknownUsageCalls: number;
}) {
  // The adaptive planner is a pure transform and consumes no model budget.
  void usage;
  return 0;
}

export function packSemanticBundleIndexes(input: {
  bundles: Array<{
    size: number;
    capabilityKeys: string[];
    orderKey: string;
  }>;
  plannerClaims: string[][];
  maxWorkers?: number;
  maxFilesPerWorker?: number;
  microBatchSize?: number;
}) {
  const maxWorkers = input.maxWorkers ?? REPOSITORY_ORCHESTRATION_MAX_WORKERS;
  const maxFilesPerWorker = input.maxFilesPerWorker ?? MAX_FILES_PER_WORKER;
  const microBatchSize = input.microBatchSize ?? SEMANTIC_MICRO_BATCH_SIZE;
  type State = {
    loads: number[];
    assignments: number[][];
    plannerOverlap: number;
    signature: string;
  };
  let states = new Map<string, State>([[
    Array.from({ length: maxWorkers }, () => 0).join(","),
    {
      loads: Array.from({ length: maxWorkers }, () => 0),
      assignments: Array.from({ length: maxWorkers }, () => [] as number[]),
      plannerOverlap: 0,
      signature: "",
    },
  ]]);
  for (const [bundleIndex, bundle] of input.bundles.entries()) {
    if (bundle.size < 1 || bundle.size > maxFilesPerWorker) return null;
    const next = new Map<string, State>();
    for (const state of states.values()) {
      for (let workerIndex = 0; workerIndex < maxWorkers; workerIndex += 1) {
        if (state.loads[workerIndex]! + bundle.size > maxFilesPerWorker) continue;
        const loads = [...state.loads];
        loads[workerIndex]! += bundle.size;
        const assignments = state.assignments.map((entries) => [...entries]);
        assignments[workerIndex]!.push(bundleIndex);
        const plannerClaimSet = new Set(input.plannerClaims[workerIndex] ?? []);
        const plannerOverlap = state.plannerOverlap +
          bundle.capabilityKeys.filter((key) => plannerClaimSet.has(key)).length;
        const signature = assignments
          .map((entries) => entries.map((index) => input.bundles[index]!.orderKey).join("+"))
          .join("|");
        const key = loads.join(",");
        const prior = next.get(key);
        if (
          !prior ||
          plannerOverlap > prior.plannerOverlap ||
          (plannerOverlap === prior.plannerOverlap && signature < prior.signature)
        ) {
          next.set(key, { loads, assignments, plannerOverlap, signature });
        }
      }
    }
    states = next;
    if (!states.size) return null;
  }
  return Array.from(states.values()).sort((left, right) => {
    const leftCalls = left.loads.reduce(
      (total, load) => total + (load ? Math.ceil(load / microBatchSize) : 0),
      0,
    );
    const rightCalls = right.loads.reduce(
      (total, load) => total + (load ? Math.ceil(load / microBatchSize) : 0),
      0,
    );
    const leftMaxTier = Math.max(...left.loads.map((load) =>
      load ? Math.ceil(load / microBatchSize) : 0
    ));
    const rightMaxTier = Math.max(...right.loads.map((load) =>
      load ? Math.ceil(load / microBatchSize) : 0
    ));
    return leftCalls - rightCalls ||
      leftMaxTier - rightMaxTier ||
      right.plannerOverlap - left.plannerOverlap ||
      left.signature.localeCompare(right.signature);
  })[0]?.assignments ?? null;
}

export function semanticFileReportSignals(input: {
  path: string;
  semanticStatus: RepositoryFileAnalysis["semanticStatus"];
  unresolvedQuestions: string[];
}) {
  return {
    gaps: input.semanticStatus === "succeeded"
      ? []
      : [`${input.path}: Semantic analysis ${input.semanticStatus ?? "degraded"}.`],
    diagnosticNotes: input.unresolvedQuestions.map((question) => `${input.path}: ${question}`),
  };
}

export function missingCapabilityCandidateGaps(input: {
  capabilityKeys: string[];
  candidates: Array<Pick<CapabilityCandidate, "key">>;
}) {
  const coveredKeys = new Set(input.candidates.map((candidate) => candidate.key));
  return Array.from(new Set(input.capabilityKeys))
    .filter((key) => !coveredKeys.has(key))
    .map((key) => `No supported semantic finding was produced for required capability ${key}.`);
}

export function missingAssignedFileCandidateGaps(input: {
  files: Array<{
    id: string;
    path: string;
    staticSubsystemKeys: string[];
  }>;
  workPackageCapabilityKeys: string[];
  candidates: Array<Pick<CapabilityCandidate, "key" | "evidence">>;
}) {
  return input.files.flatMap((file) => {
    const assignedKeys = fileRelevantCapabilityKeys({
      workPackageCapabilityKeys: input.workPackageCapabilityKeys,
      staticSubsystemKeys: file.staticSubsystemKeys,
      path: file.path,
    });
    return assignedKeys.flatMap((key) => input.candidates.some((candidate) =>
      candidate.key === key && candidate.evidence.some((evidence) => evidence.fileSnapshotId === file.id)
    )
      ? []
      : [`${file.path}: No supported semantic finding was produced for assigned capability ${key}.`]);
  });
}

export function partitionCapabilityReports(reports: Array<Pick<CapabilityReport, "packageId" | "partial">>) {
  return {
    completePackages: reports.filter((report) => !report.partial).map((report) => report.packageId),
    incompletePackages: reports.filter((report) => report.partial).map((report) => report.packageId),
  };
}

const emptyUsage = (): RepositorySemanticBudgetUsage => ({
  inputBytes: 0,
  modelCalls: 0,
  repairPasses: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  unknownUsageCalls: 0,
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown semantic worker failure.";
}

export function preserveSettledCapabilityReports(
  packages: SemanticWorkPackage[],
  settled: PromiseSettledResult<CapabilityReport>[],
) {
  return settled.map((result, index): CapabilityReport => result.status === "fulfilled"
    ? result.value
    : {
        packageId: packages[index]!.id,
        inspectedFileSnapshotIds: [],
        candidates: [],
        contradictions: [],
        gaps: [`Semantic worker ${packages[index]!.id} failed: ${errorMessage(result.reason)}`],
        tokenUsage: [],
        usage: { ...emptyUsage(), unknownUsageCalls: 1 },
        partial: true,
      });
}

function aggregateWorkerUsage(reports: CapabilityReport[]): RepositorySemanticBudgetUsage {
  return reports.reduce((total, report) => ({
    inputBytes: total.inputBytes + report.usage.inputBytes,
    modelCalls: total.modelCalls + report.usage.modelCalls,
    repairPasses: total.repairPasses + report.usage.repairPasses,
    inputTokens: total.inputTokens + report.usage.inputTokens,
    outputTokens: total.outputTokens + report.usage.outputTokens,
    totalTokens: total.totalTokens + report.usage.totalTokens,
    unknownUsageCalls: total.unknownUsageCalls + report.usage.unknownUsageCalls,
  }), emptyUsage());
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseAnalysis(value: unknown): RepositoryFileAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value as RepositoryFileAnalysis;
  return Array.isArray(analysis.facts) && Array.isArray(analysis.subsystemKeys) ? analysis : null;
}

function isImmutableSemanticCacheHitDiagnostic(value: unknown) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { status?: unknown }).status === "immutable_blob_semantic_cache_hit",
  );
}

export function reusableSemanticAnalysis(input: {
  value: unknown;
  path: string;
  capabilityKeys: string[];
}) {
  const analysis = parseAnalysis(input.value);
  const capabilityKeys = Array.from(new Set(input.capabilityKeys));
  if (
    !analysis ||
    analysis.semanticStatus !== "succeeded" ||
    !analysis.facts.length ||
    !capabilityKeys.length
  ) return null;
  const allowedKeys = new Set(capabilityKeys);
  // Cache reuse follows the same file-local capability boundary as fresh
  // extraction. A previous analysis may contain facts for another package,
  // but those facts must not be copied into the current snapshot or promoted
  // under a capability that the current static map does not assign to the
  // file.
  const facts = analysis.facts.flatMap((fact) => {
    const subsystemKeys = Array.from(new Set(fact.subsystemKeys ?? []))
      .filter((key) => allowedKeys.has(key));
    return subsystemKeys.length
      ? [{ ...fact, subsystemKeys, path: input.path }]
      : [];
  });
  const coveredKeys = new Set(facts.flatMap((fact) => fact.subsystemKeys ?? []));
  if (capabilityKeys.some((key) => !coveredKeys.has(key))) return null;
  return {
    ...analysis,
    path: input.path,
    subsystemKeys: capabilityKeys,
    facts,
  } satisfies RepositoryFileAnalysis;
}

/**
 * A source/commit pair owns one immutable RepositorySnapshot row. When a
 * policy-only refresh reuses that snapshot, the successful semantic result is
 * already on the current file row; looking only for a different historical
 * row needlessly repeats the model call. Keep the version and capability
 * checks identical to cross-snapshot cache reuse before accepting it.
 */
export function reusableCurrentSnapshotSemanticAnalysis(input: {
  semanticStatus: string | null;
  semanticAnalyzerVersion: string | null;
  semanticAnalysis: unknown;
  path: string;
  capabilityKeys: string[];
}) {
  if (
    input.semanticStatus !== "succeeded" ||
    input.semanticAnalyzerVersion !== REPOSITORY_SEMANTIC_ANALYZER_VERSION
  ) return null;
  return reusableSemanticAnalysis({
    value: input.semanticAnalysis,
    path: input.path,
    capabilityKeys: input.capabilityKeys,
  });
}

export function fileRelevantCapabilityKeys(input: {
  workPackageCapabilityKeys: string[];
  staticSubsystemKeys: string[];
  path?: string;
}) {
  const staticKeys = new Set(input.staticSubsystemKeys);
  return Array.from(new Set(input.workPackageCapabilityKeys))
    .filter((key) => staticKeys.has(key));
}

export function buildFileSemanticTask(input: {
  path: string;
  workPackageCapabilityKeys: string[];
  staticSubsystemKeys: string[];
}) {
  const capabilityKeys = fileRelevantCapabilityKeys(input);
  if (!capabilityKeys.length) return null;
  const semanticSignalKeys = semanticSignalKeysForFile({
    path: input.path,
    capabilityKeys,
  });
  return {
    objective: `Establish evidence-backed semantic coverage only for these file-relevant capabilities: ${capabilityKeys.join(", ")}.`,
    capabilityKeys,
    semanticSignalKeys,
    questions: capabilityKeys.map((key) =>
      `What implemented behavior in this file directly supports ${key.replace(/^project_domain:/, "the project domain ").replace(/_/g, " ")}?`
    ),
    expectedOutputs: [
      "Evidence-backed findings only for the listed file-relevant capabilities.",
      "Exact supporting line ranges for every finding.",
      "Treat roadmap, future, planned, TODO, example, fixture, and generated content as context rather than proof of implemented behavior.",
      "Attach every supplied semantic signal that the cited lines directly establish; omit unsupported signals.",
    ],
  };
}

export function capabilityCandidatesFromAnalysis(input: {
  fileSnapshotId: string;
  analysis: Pick<RepositoryFileAnalysis, "facts">;
  relevantCapabilityKeys: string[];
}): CapabilityCandidate[] {
  const relevantKeys = new Set(input.relevantCapabilityKeys);
  return input.analysis.facts.flatMap((fact) => {
    const supportedKeys = Array.from(new Set(fact.subsystemKeys ?? []))
      .filter((key) => relevantKeys.has(key));
    return supportedKeys.map((key) => ({
      key,
      statement: fact.statement,
      kind: fact.category === "data_flow"
        ? "data_flow" as const
        : fact.category === "dependency"
          ? "integration" as const
          : "behavior" as const,
      evidence: [{ fileSnapshotId: input.fileSnapshotId, lineStart: fact.lineStart, lineEnd: fact.lineEnd }],
      confidence: fact.confidence,
      supportedQualifiers: [],
      unresolved: [],
    }));
  });
}

export function immutableSemanticCacheWhere(input: {
  fileSnapshotId: string;
  sourceId: string;
  path: string;
  blobSha: string;
}): Prisma.RepositoryFileSnapshotWhereInput {
  return {
    id: { not: input.fileSnapshotId },
    path: input.path,
    blobSha: input.blobSha,
    disposition: "analyzed",
    semanticStatus: "succeeded",
    semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
    semanticAnalysis: { not: Prisma.DbNull },
    snapshot: { sourceId: input.sourceId },
  };
}

function stablePackageId(refreshRunId: string, capabilityKeys: string[], fileSnapshotIds: string[]) {
  return createHash("sha256")
    .update([refreshRunId, REPOSITORY_ORCHESTRATION_POLICY_VERSION, ...[...capabilityKeys].sort(), ...[...fileSnapshotIds].sort()].join("|"))
    .digest("hex")
    .slice(0, 24);
}

export function selectDiverseCapabilityRepresentatives(
  area: CapabilityManifestArea,
) {
  const implementationFiles = area.files.filter((file) =>
    isRepositoryImplementationPathForCapability(file.path, area.key)
  );
  const targetCount = Math.min(
    implementationFiles.length,
    area.requiredSemanticPathCount ?? Math.min(3, Math.max(1, Math.ceil(Math.sqrt(implementationFiles.length) / 2))),
  );
  const remaining = [...implementationFiles];
  const selected: typeof area.files = [];
  const selectedFamilies = new Set<string>();
  const pathFamily = (path: string) => {
    const segments = path.toLowerCase().split("/").filter(Boolean);
    return segments.slice(0, Math.max(1, segments.length - 1)).slice(-2).join("/");
  };
  while (selected.length < targetCount && remaining.length) {
    remaining.sort((left, right) => {
      const leftFamilyBonus = selectedFamilies.has(pathFamily(left.path)) ? 0 : 40;
      const rightFamilyBonus = selectedFamilies.has(pathFamily(right.path)) ? 0 : 40;
      const leftImplementationBonus = /(?:route|controller|service|handler|worker|pipeline|model|schema|page|screen)/i.test(left.path) ? 12 : 0;
      const rightImplementationBonus = /(?:route|controller|service|handler|worker|pipeline|model|schema|page|screen)/i.test(right.path) ? 12 : 0;
      return (right.score + rightFamilyBonus + rightImplementationBonus) -
        (left.score + leftFamilyBonus + leftImplementationBonus) ||
        left.path.localeCompare(right.path);
    });
    const next = remaining.shift();
    if (!next) break;
    selected.push(next);
    selectedFamilies.add(pathFamily(next.path));
  }
  return selected;
}

/**
 * Build a bounded semantic plan directly from the repository-derived manifest.
 * This is a deterministic transform: planner prose can never change coverage,
 * and repository identity can never change ranking.
 */
export function enforceMandatoryCoverage(input: {
  packages: Array<Omit<SemanticWorkPackage, "id" | "budget">>;
  manifest: CapabilityManifestArea[];
}) {
  const baseOrder = new Map<string, number>(
    BASE_COVERAGE_TARGETS.map((target, index) => [target.key, index]),
  );
  const orderedManifest = input.manifest
    .filter((area) => area.files.length)
    .sort((left, right) =>
      (baseOrder.get(left.key) ?? BASE_COVERAGE_TARGETS.length) -
        (baseOrder.get(right.key) ?? BASE_COVERAGE_TARGETS.length) ||
      left.key.localeCompare(right.key) ||
      (left.scopeKey ?? "").localeCompare(right.scopeKey ?? ""),
    );
  const candidatesByArea = orderedManifest.map((area) => ({
    area,
    files: selectDiverseCapabilityRepresentatives(area),
  }));
  const selectedByFile = new Map<string, {
    file: CapabilityManifestArea["files"][number];
    capabilityKeys: Set<string>;
    order: number;
  }>();
  // First give every applicable area one representative, then add the second
  // and third representatives in waves. This degrades fairly under the hard
  // file ceiling instead of allowing one large capability to consume it.
  const maxDepth = Math.max(0, ...candidatesByArea.map((entry) => entry.files.length));
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const [areaIndex, entry] of candidatesByArea.entries()) {
      const file = entry.files[depth];
      if (!file) continue;
      const existing = selectedByFile.get(file.id);
      if (!existing && selectedByFile.size >= MAX_SELECTED_SEMANTIC_FILES) continue;
      const selected = existing ?? {
        file,
        capabilityKeys: new Set<string>(),
        order: areaIndex,
      };
      selected.capabilityKeys.add(entry.area.key);
      selected.order = Math.min(selected.order, areaIndex);
      selectedByFile.set(file.id, selected);
    }
  }

  const selected = Array.from(selectedByFile.values()).sort((left, right) =>
    left.order - right.order ||
    right.file.score - left.file.score ||
    left.file.path.localeCompare(right.file.path)
  );
  const workerCount = Math.max(
    1,
    Math.min(REPOSITORY_ORCHESTRATION_MAX_WORKERS, Math.ceil(selected.length / MAX_FILES_PER_WORKER)),
  );
  const shells = Array.from({ length: workerCount }, (_, index) => input.packages[index] ?? {
    objective: "Inspect representative repository implementation evidence.",
    capabilityKeys: [],
    fileSnapshotIds: [],
    questions: [],
    expectedOutputs: [],
  });
  const plannerClaims = shells.map((entry) => entry.capabilityKeys);
  const assignments = packSemanticBundleIndexes({
    bundles: selected.map((entry) => ({
      size: 1,
      capabilityKeys: Array.from(entry.capabilityKeys),
      orderKey: `${String(entry.order).padStart(6, "0")}:${entry.file.id}`,
    })),
    plannerClaims,
    maxWorkers: workerCount,
    maxFilesPerWorker: MAX_FILES_PER_WORKER,
    microBatchSize: SEMANTIC_MICRO_BATCH_SIZE,
  });
  if (!assignments) {
    throw new Error("Adaptive semantic representatives exceeded bounded worker capacity.");
  }
  return assignments.map((bundleIndexes, workerIndex) => {
    const files = bundleIndexes.map((index) => selected[index]!);
    const capabilityKeys = Array.from(new Set(files.flatMap((entry) =>
      Array.from(entry.capabilityKeys)
    ))).sort();
    const labels = capabilityKeys.map((key) =>
      orderedManifest.find((area) => area.key === key)?.label ?? key.replace(/_/g, " ")
    );
    return {
      ...shells[workerIndex]!,
      objective: `Establish repository-derived semantic coverage for ${labels.join(", ")}.`,
      capabilityKeys,
      fileSnapshotIds: files.map((entry) => entry.file.id),
      questions: capabilityKeys.map((key) =>
        `What implemented behavior is directly supported for ${key.replace(/^project_domain:/, "the project domain ").replace(/_/g, " ")}?`
      ),
      expectedOutputs: [
        "Implemented behavior with exact file and line evidence",
        "No planned, generated, example, fixture, or test-only behavior presented as shipped product capability",
        "Explicit contradictions and unresolved gaps",
      ],
    };
  }).filter((entry) => entry.fileSnapshotIds.length);
}
export function semanticCoverageAssignmentGaps(input: {
  manifest: CapabilityManifestArea[];
  packages: Array<Pick<SemanticWorkPackage, "capabilityKeys" | "fileSnapshotIds">>;
  expectedScopeKeys?: string[];
}) {
  const manifestScopes = new Set(input.manifest.flatMap((area) => area.scopeKey ? [area.scopeKey] : []));
  const missingRepositoryScopes = (input.expectedScopeKeys ?? []).flatMap((scopeKey) =>
    manifestScopes.has(scopeKey)
      ? []
      : [`No mandatory semantic capability could be classified for attached repository ${scopeKey}; coverage cannot be verified.`]
  );
  const assignmentGaps = input.manifest.flatMap((area) => {
    const areaFileIds = new Set(area.files.map((file) => file.id));
    const assignedFileIds = new Set(input.packages.flatMap((workPackage) =>
      workPackage.capabilityKeys.includes(area.key)
        ? workPackage.fileSnapshotIds.filter((fileId) => areaFileIds.has(fileId))
        : []
    ));
    const requiredCount = area.requiredSemanticPathCount ?? Math.min(3, Math.max(1, area.files.length));
    return assignedFileIds.size >= requiredCount
      ? []
      : [`Semantic coverage assigned ${assignedFileIds.size} of ${requiredCount} required representative files for ${area.key} in ${area.scopeKey ?? "an attached repository"}.`];
  });
  return Array.from(new Set([...missingRepositoryScopes, ...assignmentGaps]));
}

function defaultPackages(input: {
  refreshRunId: string;
  manifest: CapabilityManifestArea[];
}) {
  const selectedByKey = input.manifest.flatMap((area) => {
    const file = [...area.files].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))[0];
    return file ? [{ key: area.key, label: area.label, file }] : [];
  });
  const workerCount = Math.max(1, Math.min(REPOSITORY_ORCHESTRATION_MAX_WORKERS, selectedByKey.length));
  const groups = Array.from({ length: workerCount }, () => [] as typeof selectedByKey);
  selectedByKey.forEach((entry, index) => groups[index % workerCount]!.push(entry));
  return groups.filter((group) => group.length).map((group) => ({
    objective: `Establish semantic coverage for ${group.map((entry) => entry.label).join(", ")}.`,
    capabilityKeys: group.map((entry) => entry.key),
    fileSnapshotIds: Array.from(new Set(group.map((entry) => entry.file.id))).slice(0, MAX_FILES_PER_WORKER),
    questions: group.map((entry) => `What important implemented behavior is supported for ${entry.label}?`),
    expectedOutputs: ["Evidence-backed capabilities", "Exact line ranges", "Contradictions and unresolved gaps"],
  }));
}

export function scoreAdaptiveRepresentative(input: {
  capabilityKey: string;
  path: string;
  analysis: RepositoryFileAnalysis;
  changeType?: string | null;
  incomingReferences?: number;
}) {
  const isTest = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|\.)|\.(?:test|spec)\.[^.]+$/i.test(input.path);
  const isContext = /(?:^|\/)(?:docs?|examples?)(?:\/|$)|^README(?:\.[^.]+)?$/i.test(input.path);
  const facts = input.analysis.facts.filter((fact) =>
    fact.subsystemKeys?.includes(input.capabilityKey) &&
    !/ is present in the complete immutable repository snapshot\.$/i.test(fact.statement)
  );
  const evidenceScore = facts.reduce((total, fact) =>
    total + fact.productImportance + fact.implementationBreadth + fact.technicalDifficulty,
  0);
  const roleBonus = /(?:route|controller|service|use-?case|handler|worker|pipeline|schema|model|page|screen)/i.test(input.path)
    ? 10
    : 0;
  const testAdjustment = isTest
    ? input.capabilityKey === "tests_operations" ? 8 : -30
    : 0;
  const contextAdjustment = isContext
    ? input.capabilityKey === "product_surface" ? 2 : -18
    : 0;
  return evidenceScore +
    input.analysis.architectureSignals.length * 4 +
    input.analysis.userFacingCapabilities.length * 5 +
    Math.min(20, input.analysis.symbols.length * 2) +
    Math.min(24, (input.incomingReferences ?? 0) * 6) +
    roleBonus + testAdjustment + contextAdjustment +
    (input.changeType === "unchanged" ? 0 : 8);
}

export function repositoryIncomingReferenceCounts(
  files: Array<{ path: string; analysis: Pick<RepositoryFileAnalysis, "dependencies"> }>,
) {
  const stripExtension = (value: string) => value.replace(/\.(?:[cm]?[jt]sx?|py|java|kt|go|rs|rb|php)$/i, "");
  const canonical = new Map<string, string>();
  for (const file of files) {
    const path = stripExtension(file.path.replace(/\\/g, "/"));
    canonical.set(path, file.path);
    if (path.endsWith("/index")) canonical.set(path.slice(0, -6), file.path);
  }
  const normalizeRelative = (from: string, dependency: string) => {
    const parts = from.replace(/\\/g, "/").split("/").slice(0, -1);
    for (const part of dependency.split("/")) {
      if (part === "." || !part) continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return stripExtension(parts.join("/"));
  };
  const counts = new Map(files.map((file) => [file.path, 0]));
  for (const file of files) {
    for (const dependency of file.analysis.dependencies) {
      const normalized = dependency.startsWith(".")
        ? normalizeRelative(file.path, dependency)
        : stripExtension(dependency.replace(/^@[^/]+\//, "").replace(/\./g, "/"));
      const suffixes = normalized.split("/")
        .map((_segment, index, segments) => segments.slice(index).join("/"))
        .filter((value) => value.split("/").length >= 2);
      const suffixTarget = Array.from(canonical.entries()).flatMap(([key, path]) => {
        const matchingSuffix = suffixes
          .filter((suffix) => key.endsWith(`/${suffix}`) || key.endsWith(`/${suffix}/index`))
          .sort((left, right) => right.length - left.length)[0];
        return matchingSuffix ? [{ path, matchLength: matchingSuffix.length }] : [];
      }).sort((left, right) => right.matchLength - left.matchLength || left.path.localeCompare(right.path))[0]?.path;
      const target = canonical.get(normalized) ?? canonical.get(`${normalized}/index`) ??
        suffixTarget;
      if (target && target !== file.path) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

async function ensureRefreshAgentRun(input: { refreshRunId: string; userId: string; workItemId: string }) {
  return prisma.agentRun.upsert({
    where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: `repository-refresh:${input.refreshRunId}` } },
    create: {
      userId: input.userId,
      workItemId: input.workItemId,
      knowledgeRefreshRunId: input.refreshRunId,
      idempotencyKey: `repository-refresh:${input.refreshRunId}`,
      kind: "repository_refresh",
      status: "running",
      request: inputJson({ refreshRunId: input.refreshRunId, policyVersion: REPOSITORY_ORCHESTRATION_POLICY_VERSION }),
      startedAt: new Date(),
      harnessVersion: "v5",
    },
    update: {
      knowledgeRefreshRunId: input.refreshRunId,
      status: "running",
      startedAt: new Date(),
      harnessVersion: "v5",
    },
  });
}

async function planWorkPackages(input: {
  refreshRunId: string;
  workItemId: string;
  projectTitle: string;
  manifest: CapabilityManifestArea[];
}) {
  // Planning is intentionally a pure manifest transform. Semantic models still
  // interpret selected code, but they cannot choose which repository areas are
  // visible or bias coverage toward familiar product vocabulary.
  return {
    packages: defaultPackages({
      refreshRunId: input.refreshRunId,
      manifest: input.manifest,
    }),
    generationRunId: null,
    fallbackUsed: false,
    usage: emptyUsage(),
  };
}
async function runWorkPackage(input: {
  rootRunId: string;
  refreshRunId: string;
  userId: string;
  workItemId: string;
  targets: Map<string, RepositoryTargetHead>;
  workPackage: SemanticWorkPackage;
  forceRetry?: boolean;
}) {
  const existing = await prisma.agentRun.findUnique({
    where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: `semantic-worker:${input.workPackage.id}` } },
  });
  if (!input.forceRetry && existing?.status === "completed" && existing.result) {
    return existing.result as unknown as CapabilityReport;
  }
  const child = await prisma.agentRun.upsert({
    where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: `semantic-worker:${input.workPackage.id}` } },
    create: {
      userId: input.userId,
      workItemId: input.workItemId,
      parentRunId: input.rootRunId,
      knowledgeRefreshRunId: input.refreshRunId,
      idempotencyKey: `semantic-worker:${input.workPackage.id}`,
      kind: "semantic_worker",
      status: "running",
      request: inputJson(input.workPackage),
      startedAt: new Date(),
      harnessVersion: "v5",
    },
    update: { status: "running", startedAt: new Date(), attemptNumber: { increment: 1 } },
  });
  await appendAgentRunEvent({
    runId: child.id,
    type: "progress",
    message: `Researching ${input.workPackage.capabilityKeys.length} capability area${input.workPackage.capabilityKeys.length === 1 ? "" : "s"}.`,
    payload: { schemaVersion: 1, eventName: "semantic_worker_started", refreshRunId: input.refreshRunId, workPackageId: input.workPackage.id, capabilityKeys: input.workPackage.capabilityKeys },
    isUserVisible: false,
  });
  const files = await prisma.repositoryFileSnapshot.findMany({
    where: { id: { in: input.workPackage.fileSnapshotIds }, snapshot: { workItemId: input.workItemId, refreshRunId: input.refreshRunId } },
    include: { snapshot: true },
  });
  const inspected: string[] = [];
  const candidates: CapabilityCandidate[] = [];
  const gaps: string[] = [];
  const tokenUsage: unknown[] = [];
  const diagnosticNotes: string[] = [];
  const cacheHits: NonNullable<CapabilityReport["cacheHits"]> = [];
  const returnedFileIds = new Set(files.map((file) => file.id));
  for (const fileSnapshotId of input.workPackage.fileSnapshotIds) {
    if (!returnedFileIds.has(fileSnapshotId)) {
      gaps.push(`Assigned semantic file ${fileSnapshotId} was unavailable in the current repository refresh.`);
    }
  }
  let relevantFileCount = 0;
  const budget = createRepositorySemanticBudget({
    maxInputBytes: input.workPackage.budget.maxInputBytes,
    maxModelCalls: input.workPackage.budget.maxModelCalls,
    maxRepairPasses: input.workPackage.budget.maxRepairPasses,
    maxOutputTokens: input.workPackage.budget.maxOutputTokens,
    maxTotalTokens: input.workPackage.budget.maxTotalTokens,
  });
  const pending = [] as Array<{
    file: (typeof files)[number];
    target: RepositoryTargetHead;
    staticAnalysis: RepositoryFileAnalysis;
    freshStaticAnalysis: RepositoryFileAnalysis | undefined;
    read: Awaited<ReturnType<typeof repositoryKnowledgeSyncService.readFile>>;
    fileTask: NonNullable<ReturnType<typeof buildFileSemanticTask>>;
  }>;
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    try {
      const target = input.targets.get(file.snapshot.sourceId);
      const staticAnalysis = parseAnalysis(file.analysis);
      if (!target || !file.blobSha || !staticAnalysis) {
        gaps.push(`${file.path} could not be authorized or loaded from the static map.`);
        continue;
      }
      const fileTask = buildFileSemanticTask({
        path: file.path,
        workPackageCapabilityKeys: input.workPackage.capabilityKeys,
        staticSubsystemKeys: staticAnalysis.subsystemKeys,
      });
      // Planner packages are bounded and may contain an extra file that is not
      // statically mapped to any capability owned by this worker. Do not ask
      // the model to invent a relationship merely to make that file fit.
      if (!fileTask) continue;
      relevantFileCount += 1;
      const currentSemantic = reusableCurrentSnapshotSemanticAnalysis({
        semanticStatus: file.semanticStatus,
        semanticAnalyzerVersion: file.semanticAnalyzerVersion,
        semanticAnalysis: file.semanticAnalysis,
        path: file.path,
        capabilityKeys: fileTask.capabilityKeys,
      });
      const cachedFile = currentSemantic
        ? { id: file.id, semanticAnalysis: file.semanticAnalysis, semanticDiagnostics: file.semanticDiagnostics }
        : await prisma.repositoryFileSnapshot.findFirst({
            where: immutableSemanticCacheWhere({
              fileSnapshotId: file.id,
              sourceId: file.snapshot.sourceId,
              path: file.path,
              blobSha: file.blobSha,
            }),
            select: {
              id: true,
              semanticAnalysis: true,
              semanticDiagnostics: true,
            },
            orderBy: { semanticAnalyzedAt: "desc" },
          });
      const cachedSemantic = currentSemantic ?? (cachedFile
        ? reusableSemanticAnalysis({
            value: cachedFile.semanticAnalysis,
            path: file.path,
            capabilityKeys: fileTask.capabilityKeys,
          })
        : null);
      if (cachedFile && cachedSemantic) {
        const semanticDiagnostics = [
          ...(Array.isArray(cachedSemantic.semanticDiagnostics)
            ? cachedSemantic.semanticDiagnostics.filter((entry) => !isImmutableSemanticCacheHitDiagnostic(entry))
            : []),
          {
            status: "immutable_blob_semantic_cache_hit",
            cachedFileSnapshotId: cachedFile.id,
            blobSha: file.blobSha,
            analyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
            cacheScope: cachedFile.id === file.id ? "current_snapshot" : "prior_snapshot",
          },
        ];
        const reused = {
          ...cachedSemantic,
          // Current-run telemetry records a cache hit, not the provider usage
          // incurred when the immutable blob was first analyzed.
          tokenUsage: [],
          semanticBudgetUsage: undefined,
          semanticDiagnostics,
        };
        await prisma.repositoryFileSnapshot.update({
          where: { id: file.id },
          data: {
            semanticStatus: "succeeded",
            semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
            semanticRefreshRunId: input.refreshRunId,
            semanticAnalysis: inputJson(reused),
            semanticDiagnostics: inputJson(semanticDiagnostics),
            semanticAnalyzedAt: new Date(),
          },
        });
        inspected.push(file.id);
        cacheHits.push({
          fileSnapshotId: file.id,
          cachedFileSnapshotId: cachedFile.id,
          blobSha: file.blobSha,
        });
        candidates.push(...capabilityCandidatesFromAnalysis({
          fileSnapshotId: file.id,
          analysis: reused,
          relevantCapabilityKeys: fileTask.capabilityKeys,
        }));
        diagnosticNotes.push(...cachedSemantic.unresolvedQuestions.map((question) => `${file.path}: ${question}`));
        continue;
      }
      const read = await repositoryKnowledgeSyncService.readFile({
        userId: input.userId,
        workItemId: input.workItemId,
        target,
        entry: { path: file.path, blobSha: file.blobSha, sizeBytes: file.sizeBytes, mode: "100644", objectType: "blob", disposition: "eligible", exclusionReason: null },
      });
      const [freshStaticAnalysis] = await analyzeRepositoryFiles([{
        repository: target.repository,
        commitSha: target.commitSha,
        path: file.path,
        content: read.content,
      }]);
      await prisma.repositoryFileSnapshot.update({ where: { id: file.id }, data: { semanticStatus: "pending" } });
      pending.push({ file, target, staticAnalysis, freshStaticAnalysis, read, fileTask });
    } catch (error) {
      const message = errorMessage(error);
      gaps.push(`${file.path}: Semantic worker provider or persistence failure: ${message}`);
      await prisma.repositoryFileSnapshot.update({
        where: { id: file.id },
        data: {
          semanticStatus: "failed",
          semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
          semanticRefreshRunId: input.refreshRunId,
          semanticDiagnostics: inputJson([{ status: "worker_failure", message }]),
          semanticAnalyzedAt: new Date(),
        },
      }).catch(() => null);
    }
  }

  // Cache checks and repository reads stay file-local, while only uncached
  // semantic windows are grouped. This preserves immutable-blob reuse and
  // exact per-file persistence while reducing provider round trips by roughly
  // threefold on an initial refresh.
  for (let offset = 0; offset < pending.length; offset += SEMANTIC_MICRO_BATCH_SIZE) {
    const group = pending.slice(offset, offset + SEMANTIC_MICRO_BATCH_SIZE);
    let semanticAnalyses: RepositoryFileAnalysis[];
    try {
      const semanticInputs = group.map((entry) => ({
        workItemId: input.workItemId,
        refreshRunId: input.refreshRunId,
        repository: entry.target.repository,
        commitSha: entry.target.commitSha,
        path: entry.file.path,
        content: entry.read.content,
        task: entry.fileTask,
        budget,
        staticAnalysis: entry.freshStaticAnalysis ?? entry.staticAnalysis,
      }));
      semanticAnalyses = group.length === 1
        ? [await analyzeRepositoryFile(semanticInputs[0]!)]
        : await analyzeRepositoryFileBatch(semanticInputs);
    } catch (error) {
      const message = errorMessage(error);
      semanticAnalyses = [];
      gaps.push(`Semantic micro-batch ${Math.floor(offset / SEMANTIC_MICRO_BATCH_SIZE) + 1} failed before per-file extraction: ${message}`);
    }
    for (const [index, entry] of group.entries()) {
      const semantic = semanticAnalyses[index];
      if (!semantic) {
        const message = "Semantic micro-batch returned no file result.";
        gaps.push(`${entry.file.path}: ${message}`);
        await prisma.repositoryFileSnapshot.update({
          where: { id: entry.file.id },
          data: {
            semanticStatus: "failed",
            semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
            semanticRefreshRunId: input.refreshRunId,
            semanticDiagnostics: inputJson([{ status: "missing_batch_result", message }]),
            semanticAnalyzedAt: new Date(),
          },
        }).catch(() => null);
        continue;
      }
      // Provider usage belongs to the batch even if this file's persistence
      // subsequently fails. Recording before the write prevents cost
      // telemetry from silently dropping a charged call on a DB error.
      tokenUsage.push(...semantic.tokenUsage);
      try {
        const semanticStatus = semantic.semanticStatus ?? (semantic.facts.length ? "succeeded" : "degraded");
        await prisma.repositoryFileSnapshot.update({
          where: { id: entry.file.id },
          data: {
            // Keep static mapping and semantic extraction as separate layers. This
            // prevents a prior refresh's semantic facts from leaking into a later run.
            analysis: inputJson({ ...(entry.freshStaticAnalysis ?? entry.staticAnalysis), redacted: entry.read.redacted, redactionCategories: entry.read.redactionCategories }),
            semanticStatus,
            semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
            semanticRefreshRunId: input.refreshRunId,
            semanticAnalysis: inputJson(semantic),
            semanticDiagnostics: inputJson(semantic.semanticDiagnostics ?? []),
            semanticAnalyzedAt: new Date(),
            analyzedAt: new Date(),
          },
        });
        inspected.push(entry.file.id);
        const reportSignals = semanticFileReportSignals({
          path: entry.file.path,
          semanticStatus,
          unresolvedQuestions: semantic.unresolvedQuestions,
        });
        gaps.push(...reportSignals.gaps);
        diagnosticNotes.push(...reportSignals.diagnosticNotes);
        candidates.push(...capabilityCandidatesFromAnalysis({
          fileSnapshotId: entry.file.id,
          analysis: semantic,
          relevantCapabilityKeys: entry.fileTask.capabilityKeys,
        }));
      } catch (error) {
        const message = errorMessage(error);
        gaps.push(`${entry.file.path}: Semantic result persistence failed: ${message}`);
        await prisma.repositoryFileSnapshot.update({
          where: { id: entry.file.id },
          data: {
            semanticStatus: "failed",
            semanticAnalyzerVersion: REPOSITORY_SEMANTIC_ANALYZER_VERSION,
            semanticRefreshRunId: input.refreshRunId,
            semanticDiagnostics: inputJson([{ status: "result_persistence_failure", message }]),
            semanticAnalyzedAt: new Date(),
          },
        }).catch(() => null);
      }
    }
  }
  gaps.push(...missingCapabilityCandidateGaps({
    capabilityKeys: input.workPackage.capabilityKeys,
    candidates,
  }));
  gaps.push(...missingAssignedFileCandidateGaps({
    files: files.flatMap((file) => {
      const staticAnalysis = parseAnalysis(file.analysis);
      return staticAnalysis
        ? [{ id: file.id, path: file.path, staticSubsystemKeys: staticAnalysis.subsystemKeys }]
        : [];
    }),
    workPackageCapabilityKeys: input.workPackage.capabilityKeys,
    candidates,
  }));
  const usage = snapshotRepositorySemanticBudget(budget);
  const report: CapabilityReport = {
    packageId: input.workPackage.id,
    inspectedFileSnapshotIds: inspected,
    candidates,
    contradictions: [],
    gaps: Array.from(new Set(gaps)),
    tokenUsage,
    usage,
    partial: gaps.length > 0 || inspected.length !== relevantFileCount || !candidates.length,
    diagnosticNotes: Array.from(new Set(diagnosticNotes)),
    cacheHits,
  };
  try {
    await prisma.agentRun.update({
      where: { id: child.id },
      data: { status: "completed", result: inputJson(report), finishedAt: new Date() },
    });
  } catch (error) {
    report.gaps.push(`Semantic worker audit persistence failed after extraction: ${errorMessage(error)}`);
    report.partial = true;
  }
  return report;
}

export async function orchestrateRepositorySemanticCoverage(refreshRunId: string) {
  const run = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: refreshRunId },
    include: {
      workItem: { select: { id: true, userId: true, title: true } },
      snapshots: { include: { files: { where: { disposition: "analyzed" }, orderBy: { path: "asc" } } } },
    },
  });
  const targets = new Map((run.targetHeads as unknown as RepositoryTargetHead[]).map((target) => [target.sourceId, target]));
  const root = await ensureRefreshAgentRun({ refreshRunId, userId: run.workItem.userId, workItemId: run.workItem.id });
  const manifest = run.snapshots.flatMap((snapshot) => {
    const analyzed = snapshot.files.flatMap((file) => {
      const analysis = parseAnalysis(file.analysis);
      return analysis ? [{ path: file.path, analysis, file }] : [];
    });
    const incomingReferences = repositoryIncomingReferenceCounts(analyzed);
    return selectRequiredSemanticCoverageAreas(buildCoverageMatrix(analyzed))
      .map((area) => ({
        key: area.key,
        label: area.label,
        scopeKey: targets.get(snapshot.sourceId)?.repository ?? snapshot.id,
        requiredSemanticPathCount: area.requiredSemanticPathCount,
        files: analyzed.filter((entry) =>
          entry.analysis.subsystemKeys.includes(area.key) &&
          isRepositoryImplementationPathForCapability(entry.path, area.key)
        ).map((entry) => ({
          id: entry.file.id,
          path: entry.path,
          score: scoreAdaptiveRepresentative({
            capabilityKey: area.key,
            path: entry.path,
            analysis: entry.analysis,
            changeType: entry.file.changeType,
            incomingReferences: incomingReferences.get(entry.path) ?? 0,
          }),
        })),
      }));
  });
  const planned = await planWorkPackages({ refreshRunId, workItemId: run.workItem.id, projectTitle: run.workItem.title, manifest });
  const guardedPlan = enforceMandatoryCoverage({ packages: planned.packages, manifest });
  const plannerTokenReserve = semanticPlannerTokenReserve(planned.usage);
  const normalizedPlan = guardedPlan.map((entry) => ({
    ...entry,
    capabilityKeys: Array.from(new Set(entry.capabilityKeys)).sort(),
    fileSnapshotIds: Array.from(new Set(entry.fileSnapshotIds)).sort().slice(0, MAX_FILES_PER_WORKER),
  }));
  const modelCallCounts = normalizedPlan.map((entry) =>
    Math.max(1, Math.ceil(entry.fileSnapshotIds.length / SEMANTIC_MICRO_BATCH_SIZE))
  );
  const workerTokenAllocations = allocateSemanticWorkerTokenBudgets({
    totalTokens: REPOSITORY_ORCHESTRATION_MAX_TOTAL_TOKENS - plannerTokenReserve,
    modelCallCounts,
  });
  const packages: SemanticWorkPackage[] = normalizedPlan.map((entry, index) => ({
    ...entry,
    id: stablePackageId(refreshRunId, entry.capabilityKeys, entry.fileSnapshotIds),
    budget: {
      maxWorkers: REPOSITORY_ORCHESTRATION_MAX_WORKERS,
      // Enforce the micro-batched execution shape in the budget itself. A
      // future regression to one provider call per file should fail closed
      // instead of silently restoring the old cost profile.
      maxModelCalls: modelCallCounts[index]!,
      maxInputBytes: 64 * 1024,
      maxOutputTokens: 6_000,
      maxTotalTokens: workerTokenAllocations[index]!,
      maxRepairPasses: 0 as const,
    },
  })).sort((left, right) => left.id.localeCompare(right.id));
  await prisma.knowledgeRefreshRun.update({
    where: { id: refreshRunId },
    data: {
      status: "semantic_analysis",
      orchestration: inputJson({ policyVersion: REPOSITORY_ORCHESTRATION_POLICY_VERSION, rootAgentRunId: root.id, fallbackUsed: planned.fallbackUsed, generationRunId: planned.generationRunId, packages }),
      budgetUsage: inputJson({
        maxWorkers: REPOSITORY_ORCHESTRATION_MAX_WORKERS,
        maxTotalTokens: REPOSITORY_ORCHESTRATION_MAX_TOTAL_TOKENS,
        allocatedWorkerTokens: workerTokenAllocations.reduce((total, value) => total + value, 0),
        workerTokenAllocations,
      }),
    },
  });
  const settledReports = await Promise.allSettled(packages.map((workPackage) => runWorkPackage({
    rootRunId: root.id,
    refreshRunId,
    userId: run.workItem.userId,
    workItemId: run.workItem.id,
    targets,
    workPackage,
  })));
  const finalReports = preserveSettledCapabilityReports(packages, settledReports);
  await Promise.all(settledReports.flatMap((result, index) => result.status === "rejected"
    ? [prisma.agentRun.updateMany({
        where: {
          userId: run.workItem.userId,
          idempotencyKey: `semantic-worker:${packages[index]!.id}`,
          status: { in: ["queued", "running"] },
        },
        data: {
          status: "failed",
          error: inputJson({ message: errorMessage(result.reason), workPackageId: packages[index]!.id }),
          finishedAt: new Date(),
        },
      })]
    : []));
  const remainingGaps = Array.from(new Set([
    ...finalReports.flatMap((report) => report.gaps),
    ...semanticCoverageAssignmentGaps({
      manifest,
      packages,
      expectedScopeKeys: Array.from(targets.values()).map((target) => target.repository),
    }),
  ]));
  const packageCompletion = partitionCapabilityReports(finalReports);
  const workerUsage = aggregateWorkerUsage(finalReports);
  const actualUsage = {
    inputBytes: workerUsage.inputBytes,
    modelCalls: workerUsage.modelCalls + planned.usage.modelCalls,
    repairPasses: workerUsage.repairPasses + planned.usage.repairPasses,
    inputTokens: workerUsage.inputTokens + planned.usage.inputTokens,
    outputTokens: workerUsage.outputTokens + planned.usage.outputTokens,
    totalTokens: workerUsage.totalTokens + planned.usage.totalTokens,
    unknownUsageCalls: workerUsage.unknownUsageCalls + planned.usage.unknownUsageCalls,
  };
  const coverageAudit = await prisma.agentRun.upsert({
    where: { userId_idempotencyKey: { userId: run.workItem.userId, idempotencyKey: `coverage-audit:${refreshRunId}` } },
    create: {
      userId: run.workItem.userId,
      workItemId: run.workItem.id,
      parentRunId: root.id,
      knowledgeRefreshRunId: refreshRunId,
      idempotencyKey: `coverage-audit:${refreshRunId}`,
      kind: "coverage_audit",
      status: "completed",
      request: inputJson({ packageIds: packages.map((entry) => entry.id) }),
      result: inputJson({
        ...packageCompletion,
        remainingGaps,
        usage: actualUsage,
      }),
      startedAt: new Date(),
      finishedAt: new Date(),
      harnessVersion: "v5",
    },
    update: {
      status: "completed",
      result: inputJson({
        ...packageCompletion,
        remainingGaps,
        usage: actualUsage,
      }),
      finishedAt: new Date(),
    },
  });
  await prisma.agentRun.update({
    where: { id: root.id },
    data: { status: "completed", result: inputJson({ reports: finalReports, remainingGaps, partial: remainingGaps.length > 0 || finalReports.some((report) => report.partial), usage: actualUsage }), finishedAt: new Date() },
  });
  await prisma.knowledgeRefreshRun.update({
    where: { id: refreshRunId },
    data: {
      status: "auditing",
      orchestration: inputJson({ policyVersion: REPOSITORY_ORCHESTRATION_POLICY_VERSION, rootAgentRunId: root.id, coverageAuditRunId: coverageAudit.id, fallbackUsed: planned.fallbackUsed, generationRunId: planned.generationRunId, packages, reportCount: finalReports.length, remainingGaps }),
      budgetUsage: inputJson({
        limits: { maxWorkers: REPOSITORY_ORCHESTRATION_MAX_WORKERS, maxTotalTokens: REPOSITORY_ORCHESTRATION_MAX_TOTAL_TOKENS },
        allocations: {
          plannerTokens: plannerTokenReserve,
          workerTokens: workerTokenAllocations.reduce((total, value) => total + value, 0),
          workerTokenAllocations,
        },
        actual: actualUsage,
      }),
    },
  });
  return { repaired: finalReports.reduce((total, report) => total + report.inspectedFileSnapshotIds.length, 0), remainingGaps, reports: finalReports, rootAgentRunId: root.id };
}

export const repositorySemanticOrchestratorService = { orchestrate: orchestrateRepositorySemanticCoverage };
