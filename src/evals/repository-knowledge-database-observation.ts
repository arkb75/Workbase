import { createHash } from "node:crypto";
import {
  parseRepositoryKnowledgeMetadata,
  repositoryKnowledgeClaimState,
} from "@/src/domain/repository-knowledge";
import { prisma } from "@/src/lib/prisma";
import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryKnowledgeEvaluationRun,
  type RepositoryKnowledgeEvidenceReference,
  type RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";
import {
  collectUnknownModelUsageAttempts,
} from "@/src/services/model-usage-service";
import {
  evaluateRepositoryKnowledgeMainPath,
  repositoryKnowledgeModelGenerationKinds,
  repositoryVerifierTwoPhaseIntegrityIssues,
} from "@/src/evals/repository-knowledge-main-path";
import { isRepositorySemanticCartographyEvidencePath } from "@/src/services/repository-semantic-orchestrator-service";
import { resolveActiveTextModelIdentity } from "@/src/lib/llm-config";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function repositoryFromMetadata(value: unknown) {
  const metadata = record(value);
  return stringValue(record(metadata?.repository)?.fullName) ??
    stringValue(metadata?.repositoryFullName);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Legacy or mixed-state durable knowledge is unknown rather than guessed. */
export function observedRepositoryKnowledgeClaimState(metadata: unknown) {
  return repositoryKnowledgeClaimState(
    parseRepositoryKnowledgeMetadata(metadata),
  );
}

function tokenCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + tokenCount(entry), 0);
  }
  const data = record(value);
  if (!data) return 0;
  const direct = numberValue(data.totalTokens) ?? numberValue(data.total_tokens);
  if (direct !== null) return direct;
  const input = numberValue(data.inputTokens) ?? numberValue(data.input_tokens);
  const output = numberValue(data.outputTokens) ?? numberValue(data.output_tokens);
  if (input !== null || output !== null) return (input ?? 0) + (output ?? 0);
  return Object.values(data).reduce<number>(
    (sum, entry) => sum + tokenCount(entry),
    0,
  );
}

/** Missing provider metering is unknown, not a zero-cost/token attempt. */
export function repositoryGenerationUsageTotals(generationRuns: ReadonlyArray<{
  tokenUsage: unknown;
  resultRefs: unknown;
  estimatedCostUsd: number | null;
}>) {
  const tokensComplete = generationRuns.every((generation) =>
    generation.tokenUsage !== null && generation.tokenUsage !== undefined &&
    tokenCount(generation.tokenUsage) > 0 &&
    record(generation.resultRefs)?.usageComplete !== false &&
    collectUnknownModelUsageAttempts(generation.tokenUsage) === 0
  );
  const costsComplete = tokensComplete && generationRuns.every((generation) =>
    generation.estimatedCostUsd !== null &&
    Number.isFinite(generation.estimatedCostUsd) && generation.estimatedCostUsd >= 0
  );
  return {
    totalTokens: tokensComplete
      ? generationRuns.reduce((sum, generation) => sum + tokenCount(generation.tokenUsage), 0)
      : null,
    estimatedCostUsd: costsComplete
      ? generationRuns.reduce((sum, generation) => sum + generation.estimatedCostUsd!, 0)
      : null,
  };
}

function maximumBudgetModelCalls(value: unknown) {
  let maximum = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const data = current as Record<string, unknown>;
    const modelCalls = numberValue(data.modelCalls);
    if (modelCalls !== null) maximum = Math.max(maximum, Math.floor(Math.max(0, modelCalls)));
    Object.values(data).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return maximum;
}

function countedProviderAttempts(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const data = current as Record<string, unknown>;
    const explicitAttempts = numberValue(data.providerAttemptCount);
    if (explicitAttempts !== null && explicitAttempts > 0) {
      total += Math.floor(explicitAttempts);
      return;
    }
    const budgetCalls = numberValue(data.modelCalls);
    if (budgetCalls !== null && budgetCalls > 0) {
      // Budget snapshots commonly repeat aggregate input/output token totals.
      // They are not another provider attempt leaf.
      return;
    }
    if ([
      "inputTokens",
      "input_tokens",
      "outputTokens",
      "output_tokens",
      "totalTokens",
      "total_tokens",
    ].some((key) => numberValue(data[key]) !== null)) {
      total += 1;
      return;
    }
    Object.values(data).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

/**
 * A GenerationRun is a logical audited operation, not necessarily one paid
 * model dispatch. Prefer its provider-attempt envelope, with legacy budget and
 * unknown-usage counters as floors. Taking the maximum prevents an aggregate
 * wrapper and its nested attempt leaves from counting the same dispatch twice.
 */
export function modelCallsFromGenerationTelemetry(value: unknown) {
  return Math.max(
    countedProviderAttempts(value),
    collectUnknownModelUsageAttempts(value),
    maximumBudgetModelCalls(value),
  );
}

export function repositoryGenerationModelCalls(
  generationRuns: ReadonlyArray<{ tokenUsage: unknown }>,
  refreshBudgetUsage?: unknown,
) {
  const generationAttempts = generationRuns.reduce(
    (total, generation) => total + modelCallsFromGenerationTelemetry(generation.tokenUsage),
    0,
  );
  // Refresh budget telemetry is cumulative and overlaps the per-generation
  // evidence, so it is an aggregate floor rather than an additive source.
  return Math.max(
    generationAttempts,
    modelCallsFromGenerationTelemetry(refreshBudgetUsage),
  );
}

function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Certification must use only provider calls owned by the selected refresh.
 * A time-window query alone can include project-chat routing or a concurrent
 * refresh for the same Work Item.
 */
export function repositoryGenerationRunsForRefresh<
  T extends { inputSummary: unknown },
>(runs: readonly T[], refreshRunId: string) {
  return runs.filter((run) =>
    stringValue(record(run.inputSummary)?.refreshRunId) === refreshRunId
  );
}

type SemanticFileState = {
  id: string;
  path: string;
  disposition: string;
  semanticStatus: string | null;
};

type AgenticSemanticFileState = SemanticFileState & {
  blobSha: string | null;
  semanticAnalysis: unknown;
};

type AgenticGenerationAttestation = {
  id: string;
  kind: string;
  status?: unknown;
  inputSummary?: unknown;
  parsedOutput?: unknown;
  resultRefs: unknown;
};

type AgenticEvidenceAttestation = {
  sourceId: string;
  content: string;
  metadata: unknown;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Value(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value)
    ? value
    : null;
}

function snapshotScopeDigest(input: {
  sourceId: string;
  repository: string;
  commitSha: string;
  treeSha: string;
  files: readonly AgenticSemanticFileState[];
}) {
  return sha256(JSON.stringify({
    sourceId: input.sourceId,
    repository: input.repository,
    commitSha: input.commitSha,
    treeSha: input.treeSha,
    manifest: input.files
      .map((file) => [file.path, file.blobSha, file.disposition])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  }));
}

function exactReadSetEntry(
  value: unknown,
  input: {
    sourceId: string;
    commitSha: string;
    filesByPath: ReadonlyMap<string, AgenticSemanticFileState>;
  },
) {
  const entry = record(value);
  const sourceId = stringValue(entry?.sourceId);
  const commitSha = stringValue(entry?.commitSha);
  const path = stringValue(entry?.path);
  const blobSha = stringValue(entry?.blobSha);
  const lineStart = numberValue(entry?.lineStart);
  const lineEnd = numberValue(entry?.lineEnd);
  const excerptHash = stringValue(entry?.excerptHash);
  const outputHash = stringValue(entry?.outputHash);
  const evidenceVersion = stringValue(entry?.evidenceVersion);
  const redactionPolicyVersion = stringValue(entry?.redactionPolicyVersion);
  const file = path ? input.filesByPath.get(path) : null;
  if (
    sourceId !== input.sourceId ||
    commitSha?.toLocaleLowerCase() !== input.commitSha.toLocaleLowerCase() ||
    !file ||
    !file.blobSha ||
    blobSha?.toLocaleLowerCase() !== file.blobSha.toLocaleLowerCase() ||
    !Number.isInteger(lineStart) ||
    lineStart! < 1 ||
    !Number.isInteger(lineEnd) ||
    lineEnd! < lineStart! ||
    !excerptHash ||
    !/^[a-f0-9]{64}$/iu.test(excerptHash) ||
    !outputHash ||
    !/^[a-f0-9]{64}$/iu.test(outputHash) ||
    !evidenceVersion ||
    !redactionPolicyVersion
  ) {
    throw new Error(
      "Agentic repository investigation has a read-set entry that is not exactly attested to its immutable snapshot.",
    );
  }
  return {
    sourceId,
    commitSha: commitSha!,
    path: path!,
    blobSha: blobSha!,
    lineStart: lineStart!,
    lineEnd: lineEnd!,
    excerptHash,
  };
}

function exactVerifierReadSetEntry(
  value: unknown,
  input: {
    sourceId: string;
    repository: string;
    commitSha: string;
    filesByPath: ReadonlyMap<string, AgenticSemanticFileState>;
  },
) {
  const entry = record(value);
  if (
    !stringValue(entry?.evidenceId) ||
    stringValue(entry?.repository)?.toLocaleLowerCase() !==
      input.repository.toLocaleLowerCase()
  ) {
    throw new Error(
      "Agentic repository verifier has an incomplete exact-source read-set identity.",
    );
  }
  return exactReadSetEntry(value, input);
}

function exactVerifierCandidateToolTrace(value: unknown) {
  if (!Array.isArray(value) || !value.length) return false;
  const trace = value.flatMap((candidate) => {
    const entry = record(candidate);
    return entry ? [entry] : [];
  });
  return trace.length === value.length && trace.every((entry) =>
    Boolean(stringValue(entry.evidenceId)) &&
    Boolean(stringValue(entry.command)) &&
    Array.isArray(entry.args) && entry.args.every((argument) => typeof argument === "string") &&
    (entry.operationKind === "discovery" || entry.operationKind === "exact_blob_read") &&
    typeof entry.outputHash === "string" && /^[a-f0-9]{64}$/iu.test(entry.outputHash)
  ) && trace.some((entry) => entry.operationKind === "exact_blob_read");
}

function verifierTraceCoversReadSet(traceValue: unknown, readSetValue: unknown) {
  if (!Array.isArray(traceValue) || !Array.isArray(readSetValue)) return false;
  const exactReads = new Set(traceValue.flatMap((candidate) => {
    const entry = record(candidate);
    return entry?.operationKind === "exact_blob_read" &&
        typeof entry.evidenceId === "string" &&
        typeof entry.outputHash === "string"
      ? [`${entry.evidenceId}:${entry.outputHash.toLocaleLowerCase()}`]
      : [];
  }));
  return readSetValue.every((candidate) => {
    const entry = record(candidate);
    return typeof entry?.evidenceId === "string" &&
      typeof entry?.outputHash === "string" &&
      exactReads.has(`${entry.evidenceId}:${entry.outputHash.toLocaleLowerCase()}`);
  });
}

function exactReadSetKey(entry: {
  sourceId: string;
  commitSha: string;
  path: string;
  blobSha: string;
  lineStart: number;
  lineEnd: number;
  excerptHash: string;
}) {
  return JSON.stringify([
    entry.sourceId,
    entry.commitSha.toLocaleLowerCase(),
    entry.path,
    entry.blobSha.toLocaleLowerCase(),
    entry.lineStart,
    entry.lineEnd,
    entry.excerptHash.toLocaleLowerCase(),
  ]);
}

function unnumberedEvidenceExcerpt(value: string) {
  const lines = value.split("\n");
  if (!lines.length || lines.some((line) => !/^\d+:/u.test(line))) return null;
  return lines.map((line) => line.replace(/^\d+: ?/u, "")).join("\n");
}

function finalSemanticEvidenceKeys(input: {
  snapshot: {
    sourceId: string;
    commitSha: string;
    files: AgenticSemanticFileState[];
  };
  readSetKeys: ReadonlySet<string>;
}) {
  const keys = new Set<string>();
  for (const file of input.snapshot.files.filter((candidate) =>
    candidate.semanticStatus === "succeeded"
  )) {
    if (!file.blobSha) {
      throw new Error("Agentic repository semantic analysis has no immutable blob identity.");
    }
    const analysis = record(file.semanticAnalysis);
    const facts = Array.isArray(analysis?.facts) ? analysis.facts : [];
    if (!facts.length) {
      throw new Error(
        "Agentic repository semantic analysis has no exact final notebook evidence ranges.",
      );
    }
    for (const value of facts) {
      const fact = record(value);
      const lineStart = numberValue(fact?.lineStart);
      const lineEnd = numberValue(fact?.lineEnd);
      const evidenceExcerpt = stringValue(fact?.evidenceExcerpt);
      const unnumberedExcerpt = evidenceExcerpt
        ? unnumberedEvidenceExcerpt(evidenceExcerpt)
        : null;
      if (
        !Number.isInteger(lineStart) ||
        lineStart! < 1 ||
        !Number.isInteger(lineEnd) ||
        lineEnd! < lineStart! ||
        !evidenceExcerpt ||
        unnumberedExcerpt === null
      ) {
        throw new Error(
          "Agentic repository semantic analysis contains a malformed final evidence range.",
        );
      }
      const readSetKey = exactReadSetKey({
        sourceId: input.snapshot.sourceId,
        commitSha: input.snapshot.commitSha,
        path: file.path,
        blobSha: file.blobSha,
        lineStart: lineStart!,
        lineEnd: lineEnd!,
        excerptHash: sha256(evidenceExcerpt),
      });
      if (!input.readSetKeys.has(readSetKey)) {
        throw new Error(
          "Agentic repository final semantic evidence is not backed by its exact attested read-set excerpt.",
        );
      }
      keys.add(exactReadSetKey({
        sourceId: input.snapshot.sourceId,
        commitSha: input.snapshot.commitSha,
        path: file.path,
        blobSha: file.blobSha,
        lineStart: lineStart!,
        lineEnd: lineEnd!,
        excerptHash: sha256(unnumberedExcerpt),
      }));
    }
  }
  return keys;
}

/**
 * Reconstructs agentic coverage from immutable database facts. "Inspected"
 * means an exact source range retained in an investigator read-set;
 * "analyzed" means that the final notebook was durably materialized for the
 * file; and "cited" means a current fact or Highlight references that exact
 * attested range. These sets are related but intentionally not conflated.
 */
export function agenticSemanticCoverageFromAttestations(input: {
  orchestration: unknown;
  snapshot: {
    sourceId: string;
    repository: string;
    commitSha: string;
    treeSha: string;
    files: AgenticSemanticFileState[];
  };
  generationRuns: readonly AgenticGenerationAttestation[];
  evidence: readonly AgenticEvidenceAttestation[];
}) {
  const orchestration = record(input.orchestration);
  if (orchestration?.executionMode !== "agentic_investigator") {
    throw new Error("Agentic repository coverage requires an agentic orchestration attestation.");
  }
  const repositories = Array.isArray(orchestration.repositories)
    ? orchestration.repositories.flatMap((value) => {
        const repository = record(value);
        return repository ? [repository] : [];
      })
    : [];
  const matchingRepositories = repositories.filter((repository) =>
    stringValue(repository.sourceId) === input.snapshot.sourceId &&
    stringValue(repository.repository)?.toLocaleLowerCase() ===
      input.snapshot.repository.toLocaleLowerCase() &&
    stringValue(repository.commitSha)?.toLocaleLowerCase() ===
      input.snapshot.commitSha.toLocaleLowerCase()
  );
  if (matchingRepositories.length !== 1) {
    throw new Error(
      "Agentic repository orchestration does not identify this immutable snapshot exactly once.",
    );
  }
  const repository = matchingRepositories[0]!;
  const computedScopeDigest = snapshotScopeDigest(input.snapshot);
  if (stringValue(repository.snapshotScopeDigest) !== computedScopeDigest) {
    throw new Error(
      "Agentic repository orchestration snapshot scope does not match the exact persisted manifest.",
    );
  }
  const verifierIntegrityIssues = repositoryVerifierTwoPhaseIntegrityIssues({
    repositoryAttestation: repository,
    generationRuns: input.generationRuns,
  });
  if (verifierIntegrityIssues.length) {
    throw new Error(
      `Agentic repository two-phase verifier integrity failed: ${verifierIntegrityIssues.join(" ")}`,
    );
  }
  const investigatorGenerationRunIds = jsonStringArray(
    repository.investigatorGenerationRunIds,
  );
  if (
    !investigatorGenerationRunIds.length ||
    new Set(investigatorGenerationRunIds).size !== investigatorGenerationRunIds.length
  ) {
    throw new Error("Agentic repository orchestration has an invalid investigator run set.");
  }
  const filesByPath = new Map(input.snapshot.files.map((file) => [file.path, file]));
  if (filesByPath.size !== input.snapshot.files.length) {
    throw new Error("Agentic repository snapshot manifest contains duplicate paths.");
  }
  const independentReviewGenerationRunId = stringValue(
    repository.verifierIndependentReviewGenerationRunId,
  )!;
  const independentReviewRun = input.generationRuns.find((run) =>
    run.id === independentReviewGenerationRunId && run.kind === "coverage_audit"
  )!;
  const independentCheckpoint = record(independentReviewRun.parsedOutput)!;
  const independentSourceInspection = record(independentCheckpoint.sourceInspection)!;
  (independentSourceInspection.readSet as unknown[]).forEach(
    (entry) => exactVerifierReadSetEntry(entry, {
      sourceId: input.snapshot.sourceId,
      repository: input.snapshot.repository,
      commitSha: input.snapshot.commitSha,
      filesByPath,
    }),
  );
  const verifierGenerationRunId = stringValue(repository.verifierGenerationRunId);
  const verifierInputNotebookDigest = sha256Value(repository.verifierInputNotebookDigest);
  const verifierDigest = sha256Value(repository.verifierDigest);
  const verifierMatches = verifierGenerationRunId
    ? input.generationRuns.filter((run) =>
        run.id === verifierGenerationRunId && run.kind === "coverage_audit"
      )
    : [];
  const verifierAttestation = verifierMatches.length === 1
    ? record(record(verifierMatches[0]!.resultRefs)?.resultAttestation)
    : null;
  const verifierTerminationReason = stringValue(verifierAttestation?.terminationReason);
  if (
    verifierMatches.length !== 1 ||
    !verifierInputNotebookDigest ||
    !verifierDigest ||
    verifierAttestation?.executionMode !== "agentic_investigator_verifier" ||
    verifierAttestation?.fallbackUsed !== false ||
    ![
      "verifier_complete",
      "verifier_phase_budget_exhausted",
      "shared_budget_exhausted",
    ].includes(verifierTerminationReason ?? "") ||
    stringValue(verifierAttestation?.snapshotScopeDigest) !== computedScopeDigest ||
    stringValue(verifierAttestation?.notebookDigest) !== verifierInputNotebookDigest ||
    stringValue(verifierAttestation?.auditDigest) !== verifierDigest ||
    !exactVerifierCandidateToolTrace(verifierAttestation?.toolTrace) ||
    !Array.isArray(verifierAttestation?.readSet) ||
    !verifierAttestation.readSet.length ||
    !verifierTraceCoversReadSet(
      verifierAttestation?.toolTrace,
      verifierAttestation?.readSet,
    )
  ) {
    throw new Error(
      "Agentic repository coverage verifier lacks an exact independent source-inspection attestation.",
    );
  }
  const verifierReadSet = verifierAttestation.readSet.map((entry) =>
    exactVerifierReadSetEntry(entry, {
      sourceId: input.snapshot.sourceId,
      repository: input.snapshot.repository,
      commitSha: input.snapshot.commitSha,
      filesByPath,
    })
  );
  const readSet = investigatorGenerationRunIds.flatMap((generationRunId) => {
    const matches = input.generationRuns.filter((run) =>
      run.id === generationRunId && run.kind === "semantic_extraction"
    );
    if (matches.length !== 1) {
      throw new Error(
        `Agentic investigator generation ${generationRunId} does not resolve exactly once.`,
      );
    }
    const attestation = record(record(matches[0]!.resultRefs)?.resultAttestation);
    if (
      attestation?.executionMode !== "agentic_investigator" ||
      attestation?.fallbackUsed !== false ||
      stringValue(attestation?.snapshotScopeDigest) !== computedScopeDigest ||
      !Array.isArray(attestation?.readSet) ||
      !attestation.readSet.length
    ) {
      throw new Error(
        `Agentic investigator generation ${generationRunId} lacks an exact snapshot read-set attestation.`,
      );
    }
    return attestation.readSet.map((entry) => exactReadSetEntry(entry, {
      sourceId: input.snapshot.sourceId,
      commitSha: input.snapshot.commitSha,
      filesByPath,
    }));
  });
  const readSetKeys = new Set(readSet.map(exactReadSetKey));
  const inspectedPaths = Array.from(new Set(readSet.map((entry) => entry.path))).sort();
  const independentlyEligibleFiles = input.snapshot.files.filter((file) =>
    file.disposition === "analyzed" &&
    isRepositorySemanticCartographyEvidencePath(file.path)
  );
  const independentlyEligiblePaths = new Set(
    independentlyEligibleFiles.map((file) => file.path),
  );
  const verifierInspectedPaths = Array.from(new Set(
    verifierReadSet.map((entry) => entry.path),
  )).sort();
  const analyzedPaths = input.snapshot.files
    .filter((file) => file.semanticStatus === "succeeded")
    .map((file) => file.path)
    .sort();
  const inspectedPathSet = new Set(inspectedPaths);
  if (analyzedPaths.some((path) => !inspectedPathSet.has(path))) {
    throw new Error(
      "Agentic repository durable semantic analysis is not backed by its attested read-set.",
    );
  }
  const semanticEvidenceKeys = finalSemanticEvidenceKeys({
    snapshot: input.snapshot,
    readSetKeys,
  });
  const citedPaths = Array.from(new Set(input.evidence.map((evidence) => {
    const metadata = record(evidence.metadata);
    const path = stringValue(metadata?.path);
    const blobSha = stringValue(metadata?.blobSha);
    const commitSha = stringValue(metadata?.commitSha);
    const lineStart = numberValue(metadata?.startLine);
    const lineEnd = numberValue(metadata?.endLine);
    const excerptHash = stringValue(metadata?.excerptHash);
    const file = path ? filesByPath.get(path) : null;
    const attested = sourceIdAndRangeKey({
      sourceId: evidence.sourceId,
      commitSha,
      path,
      blobSha,
      lineStart,
      lineEnd,
      excerptHash,
    });
    if (
      evidence.sourceId !== input.snapshot.sourceId ||
      commitSha?.toLocaleLowerCase() !== input.snapshot.commitSha.toLocaleLowerCase() ||
      !file ||
      !file.blobSha ||
      blobSha?.toLocaleLowerCase() !== file.blobSha.toLocaleLowerCase() ||
      !Number.isInteger(lineStart) ||
      lineStart! < 1 ||
      !Number.isInteger(lineEnd) ||
      lineEnd! < lineStart! ||
      !excerptHash ||
      excerptHash.toLocaleLowerCase() !== sha256(evidence.content).toLocaleLowerCase() ||
      !attested ||
      !semanticEvidenceKeys.has(attested)
    ) {
      throw new Error(
        "Current repository knowledge cites evidence outside the investigator's exact attested read-set.",
      );
    }
    return path!;
  }))).sort();
  const analyzedPathSet = new Set(analyzedPaths);
  if (citedPaths.some((path) => !analyzedPathSet.has(path))) {
    throw new Error(
      "Current repository knowledge cites a file that was not durably analyzed from the final notebook.",
    );
  }
  // Documentation and other exact supplemental reads remain in the durable
  // provenance sets above. Only executable production paths participate in
  // semantic coverage so a planned README limitation cannot inflate or exceed
  // the production semantic denominator.
  const coverageAnalyzedPaths = analyzedPaths.filter((path) =>
    independentlyEligiblePaths.has(path)
  );
  return {
    semanticCoverageBasis: "agentic_snapshot_read_set" as const,
    semanticEligibleFiles: independentlyEligibleFiles.length,
    semanticInspectedFiles: inspectedPaths.length,
    semanticVerifierInspectedFiles: verifierInspectedPaths.length,
    semanticAnalyzedFiles: analyzedPaths.length,
    semanticCitedFiles: citedPaths.length,
    semanticInspectedPaths: inspectedPaths,
    semanticVerifierInspectedPaths: verifierInspectedPaths,
    semanticAnalyzedPaths: analyzedPaths,
    semanticCitedPaths: citedPaths,
    semanticCoverage: independentlyEligibleFiles.length
      ? coverageAnalyzedPaths.length / independentlyEligibleFiles.length
      : null,
  };
}

function sourceIdAndRangeKey(input: {
  sourceId: string;
  commitSha: string | null;
  path: string | null;
  blobSha: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  excerptHash: string | null;
}) {
  if (
    !input.commitSha ||
    !input.path ||
    !input.blobSha ||
    !Number.isInteger(input.lineStart) ||
    !Number.isInteger(input.lineEnd) ||
    !input.excerptHash
  ) return null;
  return exactReadSetKey({
    sourceId: input.sourceId,
    commitSha: input.commitSha,
    path: input.path,
    blobSha: input.blobSha,
    lineStart: input.lineStart!,
    lineEnd: input.lineEnd!,
    excerptHash: input.excerptHash,
  });
}

/**
 * Read the immutable, pre-selection semantic denominator recorded by the
 * orchestrator. A missing or inconsistent universe is an evaluation error:
 * substituting the selected package files would report planned sampling as if
 * it were repository coverage.
 */
export function semanticCoverageFromOrchestration(input: {
  orchestration: unknown;
  files: SemanticFileState[];
}) {
  const universe = record(record(input.orchestration)?.semanticEvidenceUniverse);
  const rawIds = universe?.fileSnapshotIds;
  const fileCount = numberValue(universe?.fileCount);
  if (
    !Array.isArray(rawIds) ||
    !Number.isInteger(fileCount) ||
    fileCount! < 0 ||
    rawIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error(
      "Repository refresh is missing its persisted semantic evidence universe; rerun the repository refresh before evaluation.",
    );
  }
  const fileSnapshotIds = rawIds as string[];
  const uniqueIds = new Set(fileSnapshotIds);
  if (uniqueIds.size !== fileSnapshotIds.length || uniqueIds.size !== fileCount) {
    throw new Error(
      "Repository refresh has an inconsistent persisted semantic evidence universe; rerun the repository refresh before evaluation.",
    );
  }
  const fileById = new Map(input.files.map((file) => [file.id, file]));
  const unknownIds = fileSnapshotIds.filter((id) => !fileById.has(id));
  if (unknownIds.length) {
    throw new Error(
      "Repository refresh semantic evidence universe references files outside its immutable snapshot; rerun the repository refresh before evaluation.",
    );
  }
  const independentlyEligibleIds = new Set(input.files.flatMap((file) =>
    file.disposition === "analyzed" && isRepositorySemanticCartographyEvidencePath(file.path)
      ? [file.id]
      : []
  ));
  const omittedIds = Array.from(independentlyEligibleIds).filter((id) => !uniqueIds.has(id));
  const ineligibleIds = fileSnapshotIds.filter((id) => !independentlyEligibleIds.has(id));
  if (omittedIds.length || ineligibleIds.length) {
    throw new Error(
      "Repository refresh semantic evidence universe does not match the independently eligible snapshot files; rerun the repository refresh before evaluation.",
    );
  }
  const succeededFiles = fileSnapshotIds.flatMap((id) => {
    const file = fileById.get(id)!;
    return file.semanticStatus === "succeeded" ? [file] : [];
  });
  return {
    semanticCoverageBasis: "legacy_semantic_universe" as const,
    semanticEligibleFiles: fileSnapshotIds.length,
    semanticAnalyzedFiles: succeededFiles.length,
    semanticAnalyzedPaths: succeededFiles.map((file) => file.path),
    semanticCoverage: fileSnapshotIds.length
      ? succeededFiles.length / fileSnapshotIds.length
      : null,
  };
}

function evidenceReference(evidence: {
  title: string;
  content: string;
  metadata: unknown;
}): RepositoryKnowledgeEvidenceReference | null {
  const metadata = record(evidence.metadata);
  const path = stringValue(metadata?.path) ??
    evidence.title.match(/^(.+?):\d+(?:-\d+)?$/u)?.[1] ?? null;
  if (!path) return null;
  return {
    path,
    lineStart: numberValue(metadata?.startLine),
    lineEnd: numberValue(metadata?.endLine),
    quote: evidence.content.slice(0, 2_000) || null,
  };
}

function normalizedKnowledgeStatement(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

export function repositoryLimitationPersistenceIssues(input: {
  sourceId: string;
  refreshRunId?: string;
  repository: string;
  commitSha: string;
  files: ReadonlyArray<{
    path: string;
    blobSha: string | null;
    semanticStatus: string | null;
    semanticAnalysis: unknown;
  }>;
  facts: ReadonlyArray<{
    statement: string;
    evidence: ReadonlyArray<{
      evidenceItem: {
        sourceId: string;
        metadata: unknown;
      };
    }>;
  }>;
  quarantinedFacts?: ReadonlyArray<{
    statement: string;
    lifecycleStatus: string;
    approvalSource: string;
    validatedThroughSha: string | null;
    knowledgeChanges: ReadonlyArray<{ refreshRunId: string | null; action: string }>;
    evidence: ReadonlyArray<{ evidenceItem: { sourceId: string; metadata: unknown } }>;
  }>;
  warnings: unknown;
}) {
  const synthesisCoverageGaps = jsonStringArray(
    record(input.warnings)?.synthesisCoverageGaps,
  );
  return input.files.flatMap((file) => {
    if (file.semanticStatus !== "succeeded" || !file.blobSha) return [];
    const analysis = record(file.semanticAnalysis);
    const semanticFacts = Array.isArray(analysis?.facts) ? analysis.facts : [];
    return semanticFacts.flatMap((value) => {
      const fact = record(value);
      const semanticSignals = jsonStringArray(fact?.semanticSignals);
      const knowledgeRole = stringValue(fact?.knowledgeRole) ??
        (semanticSignals.some((signal) =>
            normalizedKnowledgeStatement(signal).toLowerCase() === "limitation"
          )
          ? "limitation"
          : "implementation");
      if (knowledgeRole !== "limitation") return [];
      const statement = stringValue(fact?.statement);
      const lineStart = numberValue(fact?.lineStart);
      const lineEnd = numberValue(fact?.lineEnd);
      if (
        !statement ||
        !Number.isInteger(lineStart) ||
        !Number.isInteger(lineEnd)
      ) {
        return [`${input.repository}: a final semantic limitation has no atomic statement and exact source range.`];
      }
      const normalizedStatement = normalizedKnowledgeStatement(statement);
      // Quarantine is an explicit durable disposition, not usable knowledge.
      // Only the selected refresh's automated, commit-bound quarantine counts
      // here; it never enters the scored active-output collection below.
      const persisted = [...input.facts, ...(input.quarantinedFacts ?? []).filter((candidate) =>
        candidate.lifecycleStatus === "quarantined" &&
        candidate.approvalSource === "automation" &&
        candidate.validatedThroughSha === input.commitSha &&
        Boolean(input.refreshRunId) &&
        candidate.knowledgeChanges.some((change) =>
          change.refreshRunId === input.refreshRunId && change.action === "quarantined"
        )
      )].some((candidate) =>
        normalizedKnowledgeStatement(candidate.statement) === normalizedStatement &&
        candidate.evidence.some(({ evidenceItem }) => {
          const metadata = record(evidenceItem.metadata);
          return evidenceItem.sourceId === input.sourceId &&
            stringValue(metadata?.path) === file.path &&
            numberValue(metadata?.startLine) === lineStart &&
            numberValue(metadata?.endLine) === lineEnd;
        })
      );
      if (persisted) return [];
      const limitationDigest = sha256(JSON.stringify([
        input.sourceId,
        input.commitSha,
        file.blobSha,
        file.path,
        lineStart,
        lineEnd,
        normalizedStatement.toLowerCase(),
      ])).slice(0, 16);
      if (synthesisCoverageGaps.some((gap) =>
        gap.includes(`#limitation-${limitationDigest}`)
      )) return [];
      return [
        `${input.repository}: material limitation ${file.path}:${lineStart}-${lineEnd} was neither persisted as an exact Project Fact nor recorded as an explicit synthesis rejection.`,
      ];
    });
  });
}

/**
 * Converts the latest completed repository snapshot and the automatic
 * knowledge applied or revalidated by that exact refresh into the neutral
 * observation contract. User-authored rows cannot inflate an extraction run.
 * It does not trigger a refresh; run a normal branch import/refresh first so
 * both implementations are compared at the same product boundary.
 */
export async function repositoryKnowledgeObservationFromDatabase(
  fixture: Pick<
    RepositoryKnowledgeFixture,
    "id" | "repository" | "snapshotCommit"
  >,
  input: {
    workItemId?: string;
    /**
     * Packet exports may retain an integrity-failed historical observation for
     * diagnosis. Certification callers must leave this false so missing or
     * inconsistent attestations still fail closed.
     */
    tolerateIntegrityFailure?: boolean;
  } = {},
): Promise<RepositoryKnowledgeEvaluationRun> {
  if (!fixture.repository) {
    throw new Error(`Fixture ${fixture.id} is not backed by a real repository.`);
  }
  const sources = await prisma.source.findMany({
    where: {
      type: "github_repo",
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: {
      id: true,
      workItemId: true,
      metadata: true,
      repositorySnapshots: {
        where: {
          analysisComplete: true,
          ...(fixture.snapshotCommit ? { commitSha: fixture.snapshotCommit } : {}),
        },
        orderBy: { resolvedAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  const matchingSources = sources.filter((candidate) =>
    repositoryFromMetadata(candidate.metadata)?.toLocaleLowerCase() ===
      fixture.repository!.toLocaleLowerCase()
  );
  if (!matchingSources.length) {
    throw new Error(
      input.workItemId
        ? `Work item ${input.workItemId} has no GitHub source matching ${fixture.repository}.`
        : `No imported GitHub source matched ${fixture.repository}; import and refresh it before evaluation.`,
    );
  }
  const source = matchingSources.find((candidate) =>
    candidate.repositorySnapshots.length > 0
  );
  if (!source) {
    throw new Error(
      `No completed repository snapshot matched ${fixture.repository} at ${fixture.snapshotCommit ?? "the latest analyzed commit"}.`,
    );
  }
  const snapshotRepository = repositoryFromMetadata(source.metadata);
  if (!snapshotRepository) {
    throw new Error(
      `The selected GitHub source has no canonical repository identity for ${fixture.repository}.`,
    );
  }
  const snapshot = await prisma.repositorySnapshot.findFirst({
    where: {
      id: source.repositorySnapshots[0]!.id,
    },
    orderBy: { resolvedAt: "desc" },
    select: {
      id: true,
      commitSha: true,
      treeSha: true,
      refreshRunId: true,
      files: {
        select: {
          id: true,
          path: true,
          blobSha: true,
          disposition: true,
          semanticStatus: true,
          semanticAnalysis: true,
        },
      },
      capabilityLedger: {
        orderBy: [{ priority: "desc" }, { capabilityKey: "asc" }],
        select: {
          capabilityKey: true,
          label: true,
          status: true,
          representativeFileIds: true,
        },
      },
      refreshRun: {
        select: {
          startedAt: true,
          finishedAt: true,
          budgetUsage: true,
          coverage: true,
          orchestration: true,
          warnings: true,
        },
      },
    },
  });
  if (!snapshot) {
    throw new Error(
      `No analyzed repository snapshot exists for ${fixture.repository}; wait for its refresh to finish.`,
    );
  }
  const refreshRunId = snapshot.refreshRunId;
  if (!refreshRunId) {
    throw new Error(
      `The analyzed snapshot for ${fixture.repository} is not bound to a repository refresh; rerun the repository refresh before evaluation.`,
    );
  }
  const [highlights, facts, generationRunsInWindow, quarantinedFacts] = await Promise.all([
    prisma.highlight.findMany({
      where: {
        workItemId: source.workItemId,
        lifecycleStatus: "active",
        approvalSource: "automation",
        autoAppliedAt: { not: null },
        validatedThroughSha: snapshot.commitSha,
        knowledgeChanges: { some: { refreshRunId } },
        evidence: { some: { evidenceItem: { sourceId: source.id } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        text: true,
        summary: true,
        metadata: true,
        evidence: {
          where: { evidenceItem: { sourceId: source.id } },
          select: {
            evidenceItem: {
              select: { sourceId: true, title: true, content: true, metadata: true },
            },
          },
        },
      },
    }),
    prisma.projectFact.findMany({
      where: {
        workItemId: source.workItemId,
        lifecycleStatus: "active",
        approvalSource: "automation",
        autoAppliedAt: { not: null },
        validatedThroughSha: snapshot.commitSha,
        knowledgeChanges: { some: { refreshRunId } },
        evidence: { some: { evidenceItem: { sourceId: source.id } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        statement: true,
        subsystemKey: true,
        metadata: true,
        evidence: {
          where: { evidenceItem: { sourceId: source.id } },
          select: {
            evidenceItem: {
              select: { sourceId: true, title: true, content: true, metadata: true },
            },
          },
        },
      },
    }),
    snapshot.refreshRun?.startedAt
      ? prisma.generationRun.findMany({
          where: {
            workItemId: source.workItemId,
            kind: {
              in: [...repositoryKnowledgeModelGenerationKinds],
            },
            createdAt: {
              gte: snapshot.refreshRun.startedAt,
              ...(snapshot.refreshRun.finishedAt
                ? { lte: snapshot.refreshRun.finishedAt }
                : {}),
            },
          },
          select: {
            id: true,
            kind: true,
            status: true,
            provider: true,
            modelId: true,
            inputSummary: true,
            parsedOutput: true,
            resultRefs: true,
            tokenUsage: true,
            estimatedCostUsd: true,
          },
        })
      : Promise.resolve([]),
    prisma.projectFact.findMany({
      where: {
        workItemId: source.workItemId,
        lifecycleStatus: "quarantined",
        approvalSource: "automation",
        validatedThroughSha: snapshot.commitSha,
        knowledgeChanges: { some: { refreshRunId, action: "quarantined" } },
        evidence: { some: { evidenceItem: { sourceId: source.id } } },
      },
      take: 1000,
      orderBy: { id: "asc" },
      select: {
        statement: true,
        lifecycleStatus: true,
        approvalSource: true,
        validatedThroughSha: true,
        knowledgeChanges: {
          where: { refreshRunId, action: "quarantined" },
          select: { refreshRunId: true, action: true },
        },
        evidence: {
          where: { evidenceItem: { sourceId: source.id } },
          select: { evidenceItem: { select: { sourceId: true, metadata: true } } },
        },
      },
    }),
  ]);
  const generationRuns = repositoryGenerationRunsForRefresh(
    generationRunsInWindow,
    refreshRunId,
  );

  const evidence = (rows: Array<{ evidenceItem: { title: string; content: string; metadata: unknown } }>) =>
    rows.flatMap((row) => {
      const reference = evidenceReference(row.evidenceItem);
      return reference ? [reference] : [];
    });
  const filePathById = new Map(snapshot.files.map((file) => [file.id, file.path]));
  const scannablePaths = snapshot.files
    .filter((file) => file.disposition === "eligible" || file.disposition === "analyzed")
    .map((file) => file.path);
  const analyzedPaths = snapshot.files
    .filter((file) => file.disposition === "analyzed")
    .map((file) => file.path);
  const orchestrationRecord = record(snapshot.refreshRun?.orchestration);
  const activeEvidence = [
    ...highlights.flatMap((highlight) => highlight.evidence),
    ...facts.flatMap((fact) => fact.evidence),
  ].map((row) => row.evidenceItem);
  const observationIntegrityIssues: string[] = [];
  observationIntegrityIssues.push(...repositoryLimitationPersistenceIssues({
    sourceId: source.id,
    refreshRunId,
    repository: snapshotRepository,
    commitSha: snapshot.commitSha,
    files: snapshot.files,
    facts,
    quarantinedFacts,
    warnings: snapshot.refreshRun?.warnings,
  }));
  let semanticCoverage;
  try {
    semanticCoverage = orchestrationRecord?.executionMode === "agentic_investigator"
      ? agenticSemanticCoverageFromAttestations({
          orchestration: snapshot.refreshRun?.orchestration,
          snapshot: {
            sourceId: source.id,
            repository: snapshotRepository,
            commitSha: snapshot.commitSha,
            treeSha: snapshot.treeSha,
            files: snapshot.files,
          },
          generationRuns,
          evidence: activeEvidence,
        })
      : semanticCoverageFromOrchestration({
          orchestration: snapshot.refreshRun?.orchestration,
          files: snapshot.files,
        });
  } catch (error) {
    if (!input.tolerateIntegrityFailure) throw error;
    observationIntegrityIssues.push(
      error instanceof Error ? error.message : String(error),
    );
    const succeededPaths = snapshot.files
      .filter((file) => file.semanticStatus === "succeeded")
      .map((file) => file.path);
    semanticCoverage = {
      semanticCoverageBasis: undefined,
      semanticEligibleFiles: null,
      semanticAnalyzedFiles: succeededPaths.length,
      semanticAnalyzedPaths: succeededPaths,
      semanticCoverage: null,
    };
  }
  const applicableCapabilities = snapshot.capabilityLedger.filter((entry) =>
    entry.status !== "not_applicable"
  );
  const verifiedCapabilities = applicableCapabilities.filter((entry) =>
    entry.status === "semantic_verified"
  );
  const startedAt = snapshot.refreshRun?.startedAt;
  const finishedAt = snapshot.refreshRun?.finishedAt;
  const mainPathIntegrity = evaluateRepositoryKnowledgeMainPath({
    generationRuns,
    expectedIdentities: {
      execution_routing: resolveActiveTextModelIdentity("routing"),
      semantic_extraction: resolveActiveTextModelIdentity("code_extraction"),
      semantic_repair: resolveActiveTextModelIdentity("code_extraction"),
      capability_synthesis: resolveActiveTextModelIdentity("deep_synthesis"),
      coverage_audit: resolveActiveTextModelIdentity("verification"),
    },
    expectedAgenticInvestigatorIdentity: resolveActiveTextModelIdentity("primary_answer"),
    expectedSynthesisCriticIdentity: resolveActiveTextModelIdentity("verification"),
    coverage: snapshot.refreshRun?.coverage,
    orchestration: snapshot.refreshRun?.orchestration,
    warnings: snapshot.refreshRun?.warnings,
  });
  const warningRecord = record(snapshot.refreshRun?.warnings);
  const policyVersions = Array.from(new Set([
    ...Object.entries(warningRecord ?? {}).flatMap(([key, value]) =>
      /version$/iu.test(key) && typeof value === "string" && value.trim()
        ? [`${key}=${value.trim()}`]
        : []
    ),
    ...(typeof orchestrationRecord?.policyVersion === "string" && orchestrationRecord.policyVersion.trim()
      ? [`orchestration.policyVersion=${orchestrationRecord.policyVersion.trim()}`]
      : []),
  ])).sort();
  const modelIdentities = Array.from(new Set(generationRuns.map((generation) =>
    `${generation.kind}:${generation.provider}:${generation.modelId}`
  ))).sort();

  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: fixture.id,
    repository: fixture.repository,
    commitSha: snapshot.commitSha,
    refreshRunId,
    items: [
      ...highlights.map((highlight) => ({
        id: highlight.id,
        kind: "highlight" as const,
        text: highlight.text,
        summary: highlight.summary,
        claimState: observedRepositoryKnowledgeClaimState(highlight.metadata),
        domain: stringValue(record(highlight.metadata)?.subsystemKey),
        evidence: evidence(highlight.evidence),
      })),
      ...facts.map((fact) => ({
        id: fact.id,
        kind: "fact" as const,
        text: fact.statement,
        summary: null,
        claimState: observedRepositoryKnowledgeClaimState(fact.metadata),
        domain: fact.subsystemKey,
        evidence: evidence(fact.evidence),
      })),
    ],
    domains: applicableCapabilities.map((entry) => ({
      key: entry.capabilityKey,
      label: entry.label,
    })),
    discoveredCapabilities: applicableCapabilities.map((entry) => ({
      key: entry.capabilityKey,
      label: entry.label,
      evidencePaths: jsonStringArray(entry.representativeFileIds).flatMap((id) => {
        const path = filePathById.get(id);
        return path ? [path] : [];
      }),
    })),
    inventory: {
      scannableFiles: scannablePaths.length,
      analyzedFiles: analyzedPaths.length,
      semanticEligibleFiles: semanticCoverage.semanticEligibleFiles,
      semanticAnalyzedFiles: semanticCoverage.semanticAnalyzedFiles,
      analyzedPaths,
      semanticAnalyzedPaths: semanticCoverage.semanticAnalyzedPaths,
      semanticCoverageBasis: semanticCoverage.semanticCoverageBasis,
      ...(semanticCoverage.semanticCoverageBasis === "agentic_snapshot_read_set" ? {
        semanticInspectedFiles: semanticCoverage.semanticInspectedFiles,
        semanticVerifierInspectedFiles: semanticCoverage.semanticVerifierInspectedFiles,
        semanticCitedFiles: semanticCoverage.semanticCitedFiles,
        semanticInspectedPaths: semanticCoverage.semanticInspectedPaths,
        semanticVerifierInspectedPaths: semanticCoverage.semanticVerifierInspectedPaths,
        semanticCitedPaths: semanticCoverage.semanticCitedPaths,
      } : {}),
    },
    coverage: {
      static: scannablePaths.length
        ? analyzedPaths.length / scannablePaths.length
        : null,
      semantic: semanticCoverage.semanticCoverage,
      knowledge: applicableCapabilities.length
        ? verifiedCapabilities.length / applicableCapabilities.length
        : null,
    },
    performance: {
      durationMs: startedAt && finishedAt
        ? Math.max(0, finishedAt.getTime() - startedAt.getTime())
        : null,
      modelCalls: repositoryGenerationModelCalls(
        generationRuns,
        snapshot.refreshRun?.budgetUsage,
      ),
      ...repositoryGenerationUsageTotals(generationRuns),
    },
    executionIntegrity: {
      passed: mainPathIntegrity.passed && observationIntegrityIssues.length === 0,
      issues: [...mainPathIntegrity.issues, ...observationIntegrityIssues],
      modelIdentities,
      policyVersions,
    },
  };
}
