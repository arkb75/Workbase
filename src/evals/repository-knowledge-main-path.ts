import { createHash } from "node:crypto";
import {
  repositorySynthesisClaimContentDigest as computedRepositorySynthesisClaimContentDigest,
  repositorySynthesisCriticClaimContentDigest,
  repositorySynthesisCriticAssessmentDigest,
} from "@/src/domain/repository-synthesis-attestation";
import {
  canonicalRepositoryOperationCommunityMapping,
  isRepositoryOperationCommunityStructuralCapabilityKey,
  repositoryOperationCommunityMappingDigest,
} from "@/src/lib/repository-operation-community";
import { collectUnknownModelUsageAttempts } from "@/src/services/model-usage-service";

export const repositoryKnowledgeModelGenerationKinds = [
  "execution_routing",
  "semantic_extraction",
  "semantic_repair",
  "capability_synthesis",
  "coverage_audit",
] as const;

type RepositoryKnowledgeModelGenerationKind =
  (typeof repositoryKnowledgeModelGenerationKinds)[number];

export interface RepositoryKnowledgeGenerationAuditRecord {
  id: string;
  kind: string;
  status: string;
  provider: string;
  modelId: string;
  inputSummary: unknown;
  parsedOutput: unknown;
  resultRefs: unknown;
  tokenUsage: unknown;
}

export interface RepositoryKnowledgeExpectedModelIdentity {
  provider: string;
  modelId: string;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown) {
  const collected: string[] = [];
  const visit = (current: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof current === "string") {
      collected.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const data = record(current);
    if (data) Object.values(data).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return collected;
}

function sumNumericProperty(value: unknown, property: string) {
  let total = 0;
  const visit = (current: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const data = record(current);
    if (!data) return;
    const candidate = data[property];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      total += Math.max(0, Math.floor(candidate));
    }
    Object.values(data).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function requestIds(resultRefs: unknown) {
  const refs = record(resultRefs);
  return Array.isArray(refs?.requestIds)
    ? refs.requestIds.filter((value): value is string =>
        typeof value === "string" && Boolean(value.trim())
      )
    : [];
}

function completeExactSourceReadSet(value: unknown) {
  return Array.isArray(value) && value.length > 0 && value.every((candidate) => {
    const entry = record(candidate);
    const lineStart = entry?.lineStart;
    const lineEnd = entry?.lineEnd;
    return typeof entry?.evidenceId === "string" && Boolean(entry.evidenceId.trim()) &&
      typeof entry?.sourceId === "string" && Boolean(entry.sourceId.trim()) &&
      typeof entry?.repository === "string" && Boolean(entry.repository.trim()) &&
      typeof entry?.commitSha === "string" &&
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(entry.commitSha) &&
      typeof entry?.path === "string" && Boolean(entry.path.trim()) &&
      typeof entry?.blobSha === "string" &&
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(entry.blobSha) &&
      typeof lineStart === "number" && Number.isInteger(lineStart) && lineStart > 0 &&
      typeof lineEnd === "number" && Number.isInteger(lineEnd) && lineEnd >= lineStart &&
      typeof entry?.excerptHash === "string" && /^[a-f0-9]{64}$/iu.test(entry.excerptHash) &&
      typeof entry?.outputHash === "string" && /^[a-f0-9]{64}$/iu.test(entry.outputHash) &&
      typeof entry?.evidenceVersion === "string" && Boolean(entry.evidenceVersion.trim()) &&
      typeof entry?.redactionPolicyVersion === "string" &&
      Boolean(entry.redactionPolicyVersion.trim());
  });
}

function validVerifierTrace(value: unknown) {
  if (!Array.isArray(value) || !value.length) return false;
  const trace = value.flatMap((candidate) => {
    const entry = record(candidate);
    return entry ? [entry] : [];
  });
  const complete = trace.length === value.length && trace.every((entry) =>
    typeof entry.evidenceId === "string" && Boolean(entry.evidenceId.trim()) &&
    typeof entry.command === "string" && Boolean(entry.command.trim()) &&
    Array.isArray(entry.args) && entry.args.every((argument) => typeof argument === "string") &&
    (entry.operationKind === "discovery" || entry.operationKind === "exact_blob_read") &&
    typeof entry.outputHash === "string" && /^[a-f0-9]{64}$/iu.test(entry.outputHash)
  );
  return complete ? trace : false;
}

function completeIndependentVerifierTrace(value: unknown) {
  const trace = validVerifierTrace(value);
  if (!trace) return false;
  return trace.some((entry) =>
      entry.operationKind === "discovery" &&
      (entry.command === "grep" || entry.command === "ls-tree")
    ) &&
    trace.some((entry) => entry.operationKind === "exact_blob_read");
}

function completeCandidateVerifierTrace(value: unknown) {
  const trace = validVerifierTrace(value);
  return trace ? trace.some((entry) => entry.operationKind === "exact_blob_read") : false;
}

function verifierTraceCoversReadSet(traceValue: unknown, readSetValue: unknown) {
  if (!Array.isArray(traceValue) || !Array.isArray(readSetValue)) return false;
  const exactReads = traceValue.flatMap((candidate) => {
    const entry = record(candidate);
    return entry?.operationKind === "exact_blob_read" &&
        entry.command === "show" &&
        Array.isArray(entry.args) &&
        typeof entry.args[0] === "string" &&
        typeof entry.evidenceId === "string" &&
        typeof entry.outputHash === "string"
      ? [{
          evidenceId: entry.evidenceId,
          revisionPath: entry.args[0],
          outputHash: entry.outputHash.toLocaleLowerCase(),
        }]
      : [];
  });
  return readSetValue.every((candidate) => {
    const entry = record(candidate);
    if (
      typeof entry?.evidenceId !== "string" ||
      typeof entry.commitSha !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.outputHash !== "string"
    ) return false;
    const evidenceId = entry.evidenceId;
    const revisionPaths = new Set([
      `HEAD:${entry.path}`,
      `${entry.commitSha}:${entry.path}`,
    ]);
    const outputHash = entry.outputHash.toLocaleLowerCase();
    return exactReads.some((read) =>
      read.evidenceId === evidenceId &&
      read.outputHash === outputHash &&
      revisionPaths.has(read.revisionPath)
    );
  });
}

function verifierIntegrityDigest(value: unknown) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function normalizedVerifierTrace(value: unknown) {
  if (!Array.isArray(value)) return null;
  const entries = value.map((candidate) => {
    const entry = record(candidate);
    if (
      !entry ||
      typeof entry.evidenceId !== "string" ||
      typeof entry.command !== "string" ||
      !Array.isArray(entry.args) ||
      !entry.args.every((argument) => typeof argument === "string") ||
      (entry.operationKind !== "discovery" &&
        entry.operationKind !== "exact_blob_read") ||
      !sha256Digest(entry.outputHash)
    ) return null;
    return {
      evidenceId: entry.evidenceId,
      command: entry.command,
      args: entry.args,
      operationKind: entry.operationKind,
      outputHash: entry.outputHash,
    };
  });
  return entries.every((entry) => entry !== null)
    ? entries as Array<NonNullable<(typeof entries)[number]>>
    : null;
}

function normalizedVerifierReadSet(value: unknown) {
  if (!Array.isArray(value)) return null;
  const entries = value.map((candidate) => {
    const entry = record(candidate);
    const lineStart = entry?.lineStart;
    const lineEnd = entry?.lineEnd;
    if (
      !entry ||
      typeof entry.evidenceId !== "string" ||
      typeof entry.sourceId !== "string" ||
      typeof entry.repository !== "string" ||
      typeof entry.commitSha !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(entry.commitSha) ||
      typeof entry.path !== "string" ||
      typeof entry.blobSha !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(entry.blobSha) ||
      typeof lineStart !== "number" || !Number.isInteger(lineStart) || lineStart < 1 ||
      typeof lineEnd !== "number" || !Number.isInteger(lineEnd) || lineEnd < lineStart ||
      !sha256Digest(entry.excerptHash) ||
      !sha256Digest(entry.outputHash) ||
      typeof entry.evidenceVersion !== "string" ||
      typeof entry.redactionPolicyVersion !== "string"
    ) return null;
    return {
      evidenceId: entry.evidenceId,
      sourceId: entry.sourceId,
      repository: entry.repository,
      commitSha: entry.commitSha,
      path: entry.path,
      blobSha: entry.blobSha,
      lineStart,
      lineEnd,
      excerptHash: entry.excerptHash,
      outputHash: entry.outputHash,
      evidenceVersion: entry.evidenceVersion,
      redactionPolicyVersion: entry.redactionPolicyVersion,
    };
  });
  return entries.every((entry) => entry !== null)
    ? entries as Array<NonNullable<(typeof entries)[number]>>
    : null;
}

function normalizedIndependentObservations(value: unknown) {
  if (!Array.isArray(value)) return null;
  const allowedKinds = new Set([
    "operation",
    "state_transition",
    "integration",
    "side_effect",
    "boundary",
    "open_lead",
  ]);
  const observations = value.map((candidate) => {
    const observation = record(candidate);
    const evidence = record(observation?.evidence);
    if (
      !observation ||
      typeof observation.kind !== "string" ||
      !allowedKinds.has(observation.kind) ||
      typeof observation.statement !== "string" ||
      typeof evidence?.evidenceId !== "string" ||
      typeof evidence.lineStart !== "number" ||
      !Number.isInteger(evidence.lineStart) || evidence.lineStart < 1 ||
      typeof evidence.lineEnd !== "number" ||
      !Number.isInteger(evidence.lineEnd) || evidence.lineEnd < evidence.lineStart
    ) return null;
    return {
      kind: observation.kind,
      statement: observation.statement,
      evidence: {
        evidenceId: evidence.evidenceId,
        lineStart: evidence.lineStart,
        lineEnd: evidence.lineEnd,
      },
    };
  });
  return observations.every((observation) => observation !== null)
    ? observations as Array<NonNullable<(typeof observations)[number]>>
    : null;
}

function verifierCitationHasEnclosingRead(
  readSet: NonNullable<ReturnType<typeof normalizedVerifierReadSet>>,
  value: unknown,
) {
  const citation = record(value);
  const evidenceId = typeof citation?.evidenceId === "string"
    ? citation.evidenceId
    : null;
  const lineStart = typeof citation?.lineStart === "number"
    ? citation.lineStart
    : null;
  const lineEnd = typeof citation?.lineEnd === "number"
    ? citation.lineEnd
    : null;
  return evidenceId !== null &&
    lineStart !== null && Number.isInteger(lineStart) &&
    lineEnd !== null && Number.isInteger(lineEnd) &&
    readSet.some((read) =>
      read.evidenceId === evidenceId &&
      read.lineStart <= lineStart &&
      read.lineEnd >= lineEnd
    );
}

/**
 * Verifies the durable blind-review -> candidate-audit chain without depending
 * on a live repository. Malformed or pre-split historical records are returned
 * as explicit issues so evaluation remains inspectable instead of throwing.
 */
export function repositoryVerifierTwoPhaseIntegrityIssues(input: {
  repositoryAttestation: unknown;
  generationRuns: ReadonlyArray<{
    id: string;
    kind: string;
    status?: unknown;
    inputSummary?: unknown;
    parsedOutput?: unknown;
    resultRefs?: unknown;
  }>;
}) {
  const issues: string[] = [];
  const repository = record(input.repositoryAttestation);
  const label = typeof repository?.repository === "string"
    ? repository.repository
    : "Agentic repository";
  const sourceId = typeof repository?.sourceId === "string"
    ? repository.sourceId
    : null;
  const repositoryName = typeof repository?.repository === "string"
    ? repository.repository
    : null;
  const commitSha = typeof repository?.commitSha === "string" &&
      /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(repository.commitSha)
    ? repository.commitSha
    : null;
  const scopeDigest = sha256Digest(repository?.snapshotScopeDigest)
    ? repository.snapshotScopeDigest
    : null;
  if (!sourceId || !repositoryName || !commitSha || !scopeDigest) {
    issues.push(`${label} two-phase verifier is not bound to an exact repository snapshot identity.`);
  }

  const independentReviewId = typeof repository?.verifierIndependentReviewGenerationRunId ===
      "string" && repository.verifierIndependentReviewGenerationRunId.trim()
    ? repository.verifierIndependentReviewGenerationRunId
    : null;
  const independentMatches = independentReviewId
    ? input.generationRuns.filter((run) =>
        run.id === independentReviewId && run.kind === "coverage_audit"
      )
    : [];
  if (independentMatches.length !== 1) {
    issues.push(`${label} has no uniquely referenced blind independent-review generation.`);
    return issues;
  }
  const independentRun = independentMatches[0]!;
  const independentSummary = record(independentRun.inputSummary);
  if (
    independentRun.status !== "success" ||
    independentSummary?.phase !== "repository_independent_review" ||
    independentSummary.candidateAvailable !== false ||
    independentSummary.sourceId !== sourceId ||
    independentSummary.repository !== repositoryName ||
    independentSummary.commitSha !== commitSha ||
    independentSummary.snapshotScopeDigest !== scopeDigest
  ) {
    issues.push(`${label} blind independent review does not certify candidate-hidden execution on the exact snapshot.`);
  }

  const rawCheckpoint = record(independentRun.parsedOutput);
  const sourceInspection = record(rawCheckpoint?.sourceInspection);
  const sourceSearchTrace = normalizedVerifierTrace(sourceInspection?.sourceSearchTrace);
  const independentReadSet = normalizedVerifierReadSet(sourceInspection?.readSet);
  const independentObservations = normalizedIndependentObservations(
    rawCheckpoint?.independentObservations,
  );
  const normalizedSourceInspection = sourceSearchTrace && independentReadSet
    ? { sourceSearchTrace, readSet: independentReadSet }
    : null;
  const checkpointShapeValid =
    rawCheckpoint?.schemaVersion === "repository-verifier-independent-review-v1" &&
    rawCheckpoint.sourceId === sourceId &&
    rawCheckpoint.repository === repositoryName &&
    rawCheckpoint.commitSha === commitSha &&
    rawCheckpoint.snapshotScopeDigest === scopeDigest &&
    normalizedSourceInspection !== null &&
    completeIndependentVerifierTrace(sourceSearchTrace) &&
    completeExactSourceReadSet(independentReadSet) &&
    verifierTraceCoversReadSet(sourceSearchTrace, independentReadSet) &&
    independentReadSet?.every((read) =>
      read.sourceId === sourceId &&
      read.repository === repositoryName &&
      read.commitSha === commitSha
    ) === true &&
    independentObservations !== null && independentObservations.length > 0 &&
    (rawCheckpoint.observationCapacityReached === undefined ||
      rawCheckpoint.observationCapacityReached === true) &&
    typeof rawCheckpoint.inspectionToolCalls === "number" &&
    Number.isInteger(rawCheckpoint.inspectionToolCalls) &&
    rawCheckpoint.inspectionToolCalls > 0;
  if (!checkpointShapeValid) {
    issues.push(`${label} blind independent-review checkpoint is incomplete or not snapshot-bound.`);
    return issues;
  }
  if (
    !sourceSearchTrace || !independentReadSet || !independentObservations ||
    !normalizedSourceInspection
  ) return issues;

  const sourceInspectionDigest = verifierIntegrityDigest(normalizedSourceInspection);
  const independentObservationDigest = verifierIntegrityDigest(independentObservations);
  const normalizedCheckpointPayload = {
    schemaVersion: "repository-verifier-independent-review-v1",
    sourceId,
    repository: repositoryName,
    commitSha,
    snapshotScopeDigest: scopeDigest,
    sourceInspection: normalizedSourceInspection,
    sourceInspectionDigest,
    independentObservations,
    independentObservationDigest,
    ...(rawCheckpoint.observationCapacityReached === true
      ? { observationCapacityReached: true }
      : {}),
    inspectionToolCalls: rawCheckpoint.inspectionToolCalls,
  };
  const checkpointDigest = verifierIntegrityDigest(normalizedCheckpointPayload);
  if (
    rawCheckpoint.sourceInspectionDigest !== sourceInspectionDigest ||
    rawCheckpoint.independentObservationDigest !== independentObservationDigest ||
    rawCheckpoint.checkpointDigest !== checkpointDigest ||
    new Set(independentObservations.map(verifierIntegrityDigest)).size !==
      independentObservations.length ||
    !independentObservations.every((observation) =>
      verifierCitationHasEnclosingRead(independentReadSet, observation.evidence)
    )
  ) {
    issues.push(`${label} blind independent-review checkpoint failed digest or cited-read integrity.`);
  }
  const independentAttestation = record(
    record(independentRun.resultRefs)?.resultAttestation,
  );
  if (
    independentAttestation?.executionMode !==
      "agentic_investigator_verifier_independent_review" ||
    independentAttestation.fallbackUsed !== false ||
    independentAttestation.snapshotScopeDigest !== scopeDigest ||
    independentAttestation.checkpointDigest !== checkpointDigest ||
    independentAttestation.sourceInspectionDigest !== sourceInspectionDigest
  ) {
    issues.push(`${label} blind independent-review generation does not attest its exact checkpoint.`);
  }

  const verifierId = typeof repository?.verifierGenerationRunId === "string" &&
      repository.verifierGenerationRunId.trim()
    ? repository.verifierGenerationRunId
    : null;
  const verifierMatches = verifierId
    ? input.generationRuns.filter((run) =>
        run.id === verifierId && run.kind === "coverage_audit"
      )
    : [];
  if (verifierMatches.length !== 1) {
    issues.push(`${label} has no uniquely referenced candidate-audit generation.`);
    return issues;
  }
  const verifierRun = verifierMatches[0]!;
  const verifierSummary = record(verifierRun.inputSummary);
  const verifierPolicy = record(verifierSummary?.verifierToolPolicy);
  if (
    verifierRun.status !== "success" ||
    verifierSummary?.phase !== "repository_candidate_coverage_audit" ||
    verifierSummary.sourceId !== sourceId ||
    verifierSummary.repository !== repositoryName ||
    verifierSummary.commitSha !== commitSha ||
    verifierSummary.snapshotScopeDigest !== scopeDigest ||
    verifierSummary.independentReviewGenerationRunId !== independentReviewId ||
    verifierSummary.independentReviewCheckpointDigest !== checkpointDigest ||
    verifierPolicy?.durableBlindReview !== true ||
    verifierPolicy.representativeCheck !== true
  ) {
    issues.push(`${label} candidate audit is not linked to the exact blind checkpoint or fresh-read contract.`);
  }
  const verifierAttestation = record(record(verifierRun.resultRefs)?.resultAttestation);
  const preDisclosureInspection = record(
    verifierAttestation?.preDisclosureSourceInspection,
  );
  const normalizedPreDisclosureTrace = normalizedVerifierTrace(
    preDisclosureInspection?.sourceSearchTrace,
  );
  const normalizedPreDisclosureReadSet = normalizedVerifierReadSet(
    preDisclosureInspection?.readSet,
  );
  const normalizedPreDisclosureInspection = normalizedPreDisclosureTrace &&
      normalizedPreDisclosureReadSet
    ? {
        sourceSearchTrace: normalizedPreDisclosureTrace,
        readSet: normalizedPreDisclosureReadSet,
      }
    : null;
  const candidateDisclosure = record(verifierAttestation?.candidateDisclosure);
  const disclosedObservations = normalizedIndependentObservations(
    candidateDisclosure?.independentObservations,
  );
  const discoveryIds = Array.isArray(
      candidateDisclosure?.preDisclosureDiscoveryEvidenceIds,
    )
    ? candidateDisclosure.preDisclosureDiscoveryEvidenceIds.filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
    : [];
  const exactReadIds = Array.isArray(
      candidateDisclosure?.preDisclosureExactReadEvidenceIds,
    )
    ? candidateDisclosure.preDisclosureExactReadEvidenceIds.filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
    : [];
  const selectedPreDisclosureInspection = {
    sourceSearchTrace: sourceSearchTrace.filter((entry) =>
      discoveryIds.includes(entry.evidenceId)
    ),
    readSet: independentReadSet.filter((entry) =>
      exactReadIds.includes(entry.evidenceId)
    ),
  };
  if (
    verifierAttestation?.independentReviewGenerationRunId !== independentReviewId ||
    verifierAttestation.independentReviewCheckpointDigest !== checkpointDigest ||
    verifierAttestation.preDisclosureSourceInspectionDigest !== sourceInspectionDigest ||
    !normalizedPreDisclosureInspection ||
    verifierIntegrityDigest(normalizedPreDisclosureInspection) !== sourceInspectionDigest ||
    candidateDisclosure?.inspectionToolCallsAtReveal !== rawCheckpoint.inspectionToolCalls ||
    !discoveryIds.length || new Set(discoveryIds).size !== discoveryIds.length ||
    !exactReadIds.length || new Set(exactReadIds).size !== exactReadIds.length ||
    selectedPreDisclosureInspection.sourceSearchTrace.length !== discoveryIds.length ||
    new Set(selectedPreDisclosureInspection.readSet.map((entry) => entry.evidenceId)).size !== exactReadIds.length ||
    !selectedPreDisclosureInspection.sourceSearchTrace.every((entry) =>
      entry.operationKind === "discovery" &&
      (entry.command === "grep" || entry.command === "ls-tree")
    ) ||
    candidateDisclosure?.preDisclosureAttestationDigest !==
      verifierIntegrityDigest(selectedPreDisclosureInspection) ||
    !disclosedObservations ||
    verifierIntegrityDigest(disclosedObservations) !== independentObservationDigest ||
    candidateDisclosure?.independentObservationDigest !== independentObservationDigest ||
    !disclosedObservations.every((observation) =>
      verifierCitationHasEnclosingRead(
        selectedPreDisclosureInspection.readSet,
        observation.evidence,
      )
    )
  ) {
    issues.push(`${label} candidate disclosure is not an exact continuation of the blind checkpoint.`);
  }

  const candidateTrace = normalizedVerifierTrace(verifierAttestation?.toolTrace);
  const candidateReadSet = normalizedVerifierReadSet(verifierAttestation?.readSet);
  const parsedAudit = record(verifierRun.parsedOutput);
  const capabilityChecks = Array.isArray(parsedAudit?.capabilityChecks)
    ? parsedAudit.capabilityChecks
    : null;
  const independentChecks = Array.isArray(parsedAudit?.independentObservationChecks)
    ? parsedAudit.independentObservationChecks
    : null;
  const missingOperations = Array.isArray(parsedAudit?.missingOperations)
    ? parsedAudit.missingOperations
    : null;
  let freshReadContractValid = candidateTrace !== null && candidateReadSet !== null &&
    completeCandidateVerifierTrace(candidateTrace) &&
    completeExactSourceReadSet(candidateReadSet) &&
    verifierTraceCoversReadSet(candidateTrace, candidateReadSet) &&
    candidateReadSet.every((read) =>
      read.sourceId === sourceId &&
      read.repository === repositoryName &&
      read.commitSha === commitSha
    ) &&
    verifierAttestation?.postDisclosureSourceInspectionDigest ===
      verifierIntegrityDigest({
        sourceSearchTrace: candidateTrace,
        readSet: candidateReadSet,
      }) &&
    capabilityChecks !== null && independentChecks !== null &&
    missingOperations !== null;
  if (freshReadContractValid) {
    const citedOutputs = [
      ...capabilityChecks!,
      ...independentChecks!,
      ...missingOperations!,
    ];
    const expectedObservationDigests = new Map(independentObservations.map((observation) => [
      verifierIntegrityDigest(observation),
      observation,
    ]));
    const seenObservationDigests = new Set<string>();
    freshReadContractValid = citedOutputs.every((value) =>
      verifierCitationHasEnclosingRead(candidateReadSet!, record(value)?.evidence)
    ) && independentChecks!.length === expectedObservationDigests.size &&
      independentChecks!.every((value) => {
        const check = record(value);
        const digest = typeof check?.observationDigest === "string"
          ? check.observationDigest
          : "";
        const observation = expectedObservationDigests.get(digest);
        const candidateCitation = record(check?.evidence);
        const candidateEvidenceId = typeof candidateCitation?.evidenceId === "string"
          ? candidateCitation.evidenceId
          : null;
        const candidateLineStart = typeof candidateCitation?.lineStart === "number"
          ? candidateCitation.lineStart
          : null;
        const candidateLineEnd = typeof candidateCitation?.lineEnd === "number"
          ? candidateCitation.lineEnd
          : null;
        const candidateRead = candidateReadSet!.find((read) =>
          candidateEvidenceId !== null && candidateLineStart !== null &&
          candidateLineEnd !== null &&
          read.evidenceId === candidateEvidenceId &&
          read.lineStart <= candidateLineStart &&
          read.lineEnd >= candidateLineEnd
        );
        const independentRead = observation
          ? independentReadSet.find((read) =>
              read.evidenceId === observation.evidence.evidenceId &&
              read.lineStart <= observation.evidence.lineStart &&
              read.lineEnd >= observation.evidence.lineEnd
            )
          : null;
        if (!digest || seenObservationDigests.has(digest)) return false;
        seenObservationDigests.add(digest);
        return Boolean(
          observation && candidateRead && independentRead &&
          candidateRead.path === independentRead.path &&
          candidateRead.blobSha === independentRead.blobSha &&
          candidateCitation?.lineStart === observation.evidence.lineStart &&
          candidateCitation?.lineEnd === observation.evidence.lineEnd,
        );
      });
  }
  if (!freshReadContractValid) {
    issues.push(`${label} candidate audit does not certify fresh representative exact-source reads.`);
  }
  return issues;
}

type RepositorySynthesisGenerationPhase =
  | "synthesis"
  | "entailment_critic"
  | "operation_community_mapping"
  | "repository_highlight_selection"
  | "repository_highlight_critic"
  | "limitation_entailment_critic";

function repositorySynthesisGenerationPhase(
  inputSummary: unknown,
): RepositorySynthesisGenerationPhase | null {
  const phase = record(inputSummary)?.phase;
  return phase === "synthesis" ||
      phase === "entailment_critic" ||
      phase === "operation_community_mapping" ||
      phase === "repository_highlight_selection" ||
      phase === "repository_highlight_critic" ||
      phase === "limitation_entailment_critic"
    ? phase
    : null;
}

const repositoryOperationCommunitySize = 12;
const repositoryOperationCommunityMaximum = 3;
const repositoryStructuralCommunityMinimum = 7;
const repositoryStructuralCommunityPolicy = "structural_breadth_v1";
const repositoryProjectDomainCommunityPolicy = "project_domain_v1";

type RepositoryOperationCommunityMappingDescriptor = {
  batchKey: string;
  refreshRunId: string;
  subsystemKey: string;
  capabilityKey: string;
  communityPolicy: string;
  notebookEntries: number;
  rawEligibleEntries: number;
  expectedCommunityCount: number;
};

function repositoryOperationCommunityMappingDescriptor(
  inputSummary: unknown,
): RepositoryOperationCommunityMappingDescriptor | null {
  const summary = record(inputSummary);
  const refreshRunId = typeof summary?.refreshRunId === "string"
    ? summary.refreshRunId.trim()
    : "";
  const subsystemKey = typeof summary?.subsystemKey === "string"
    ? summary.subsystemKey.trim()
    : "";
  const explicitCapabilityKey = typeof summary?.capabilityKey === "string"
    ? summary.capabilityKey.trim()
    : "";
  const explicitCommunityPolicy = typeof summary?.communityPolicy === "string"
    ? summary.communityPolicy.trim()
    : "";
  // Mappings emitted before structural communities existed carried only the
  // hashed project-domain parent key. Preserve their stricter >12-entry audit
  // contract for historical comparisons; new structural mappings must declare
  // their exact capability and policy explicitly.
  const legacyProjectCapabilityKey = !explicitCapabilityKey &&
      !explicitCommunityPolicy &&
      /^project_domain:[a-z0-9][a-z0-9_-]*#/iu.test(subsystemKey)
    ? subsystemKey.slice(0, subsystemKey.indexOf("#"))
    : "";
  const capabilityKey = explicitCapabilityKey || legacyProjectCapabilityKey;
  const communityPolicy = explicitCommunityPolicy || (
    legacyProjectCapabilityKey ? repositoryProjectDomainCommunityPolicy : ""
  );
  const parentCapabilityKey = subsystemKey.includes("#")
    ? subsystemKey.slice(0, subsystemKey.indexOf("#"))
    : "";
  const structuralPolicy =
    communityPolicy === repositoryStructuralCommunityPolicy &&
    isRepositoryOperationCommunityStructuralCapabilityKey(capabilityKey) &&
    parentCapabilityKey === capabilityKey;
  const projectDomainPolicy =
    communityPolicy === repositoryProjectDomainCommunityPolicy &&
    /^project_domain:[a-z0-9][a-z0-9_-]*$/iu.test(capabilityKey) &&
    parentCapabilityKey === capabilityKey;
  const notebookEntries = summary?.notebookEntries;
  const rawEligibleEntries = summary?.rawEligibleEntries;
  const expectedCommunityCount = summary?.expectedCommunityCount;
  const expectedCount = typeof notebookEntries === "number" &&
      Number.isInteger(notebookEntries)
    ? structuralPolicy
      ? 2
      : Math.ceil(notebookEntries / repositoryOperationCommunitySize)
    : 0;
  if (
    !refreshRunId ||
    !subsystemKey ||
    (!structuralPolicy && !projectDomainPolicy) ||
    typeof notebookEntries !== "number" ||
    !Number.isInteger(notebookEntries) ||
    (structuralPolicy
      ? notebookEntries < repositoryStructuralCommunityMinimum ||
        notebookEntries > repositoryOperationCommunitySize * 2
      : notebookEntries <= repositoryOperationCommunitySize ||
        notebookEntries >
          repositoryOperationCommunitySize * repositoryOperationCommunityMaximum) ||
    typeof rawEligibleEntries !== "number" ||
    !Number.isInteger(rawEligibleEntries) ||
    rawEligibleEntries < notebookEntries ||
    typeof expectedCommunityCount !== "number" ||
    !Number.isInteger(expectedCommunityCount) ||
    expectedCommunityCount < 2 ||
    expectedCommunityCount > (
      structuralPolicy ? 2 : repositoryOperationCommunityMaximum
    ) ||
    expectedCommunityCount !== expectedCount
  ) {
    return null;
  }
  return {
    batchKey: JSON.stringify([
      refreshRunId,
      subsystemKey,
      capabilityKey,
      communityPolicy,
      notebookEntries,
      rawEligibleEntries,
      expectedCommunityCount,
    ]),
    refreshRunId,
    subsystemKey,
    capabilityKey,
    communityPolicy,
    notebookEntries,
    rawEligibleEntries,
    expectedCommunityCount,
  };
}

function repositoryOperationCommunityMappingIsExactPartition(
  parsedOutput: unknown,
  descriptor: RepositoryOperationCommunityMappingDescriptor,
) {
  const communities = canonicalRepositoryOperationCommunityMapping(
    parsedOutput,
  )?.communities;
  if (
    !communities ||
    communities.length !== descriptor.expectedCommunityCount ||
    communities.length < 2 ||
    communities.length > repositoryOperationCommunityMaximum
  ) {
    return false;
  }

  const normalizedLabels: string[] = [];
  const assignedIndexes: number[] = [];
  for (const community of communities) {
    if (
      community.label.length < 2 ||
      community.label.length > 80 ||
      community.memberIndexes.length < 1 ||
      community.memberIndexes.length > repositoryOperationCommunitySize ||
      community.memberIndexes.some((index) =>
        index < 1 ||
        index > descriptor.notebookEntries
      )
    ) {
      return false;
    }
    normalizedLabels.push(community.label.toLowerCase());
    assignedIndexes.push(...community.memberIndexes);
  }

  const uniqueLabels = new Set(normalizedLabels);
  const uniqueIndexes = new Set(assignedIndexes);
  return uniqueLabels.size === normalizedLabels.length &&
    assignedIndexes.length === descriptor.notebookEntries &&
    uniqueIndexes.size === descriptor.notebookEntries &&
    Array.from(
      { length: descriptor.notebookEntries },
      (_entry, index) => index + 1,
    ).every((index) => uniqueIndexes.has(index));
}

function attestedRepositoryOperationCommunityMappingDigest(
  resultRefs: unknown,
) {
  const digest = record(record(resultRefs)?.resultAttestation)?.mappingDigest;
  return typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)
    ? digest
    : null;
}

type RepositoryOperationCommunityConsumption = {
  childSynthesisKey: string;
  parentSynthesisKey: string;
  mappingDigest: string;
  communityIndex: number;
  memberIndexes: number[];
};

function repositorySynthesisOperationCommunityConsumptions(
  inputSummary: unknown,
) {
  const values = record(inputSummary)?.operationCommunities;
  if (values === undefined) {
    return {
      records: [] as RepositoryOperationCommunityConsumption[],
      invalidRecordCount: 0,
    };
  }
  if (!Array.isArray(values)) {
    return {
      records: [] as RepositoryOperationCommunityConsumption[],
      invalidRecordCount: 1,
    };
  }

  const records: RepositoryOperationCommunityConsumption[] = [];
  let invalidRecordCount = 0;
  for (const value of values) {
    const consumption = record(value);
    const childSynthesisKey = typeof consumption?.childSynthesisKey === "string"
      ? consumption.childSynthesisKey.trim()
      : "";
    const parentSynthesisKey = typeof consumption?.parentSynthesisKey === "string"
      ? consumption.parentSynthesisKey.trim()
      : "";
    const mappingDigest = consumption?.mappingDigest;
    const communityIndex = consumption?.communityIndex;
    const memberIndexes = consumption?.memberIndexes;
    if (
      !childSynthesisKey ||
      !parentSynthesisKey ||
      typeof mappingDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(mappingDigest) ||
      typeof communityIndex !== "number" ||
      !Number.isInteger(communityIndex) ||
      communityIndex < 0 ||
      communityIndex >= repositoryOperationCommunityMaximum ||
      !Array.isArray(memberIndexes) ||
      memberIndexes.length < 1 ||
      memberIndexes.length > repositoryOperationCommunitySize ||
      memberIndexes.some((index) =>
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 1
      ) ||
      new Set(memberIndexes).size !== memberIndexes.length
    ) {
      invalidRecordCount += 1;
      continue;
    }
    records.push({
      childSynthesisKey,
      parentSynthesisKey,
      mappingDigest,
      communityIndex,
      memberIndexes: memberIndexes.map((index) => index as number),
    });
  }
  return { records, invalidRecordCount };
}

function repositoryOperationCommunityConsumptionKey(input: {
  refreshRunId: string;
  parentSynthesisKey: string;
  mappingDigest: string;
  communityIndex: number;
  memberIndexes: readonly number[];
}) {
  return JSON.stringify([
    input.refreshRunId,
    input.parentSynthesisKey,
    input.mappingDigest,
    input.communityIndex,
    input.memberIndexes,
  ]);
}

function attestedRepositoryOperationCommunities(
  run: RepositoryKnowledgeGenerationAuditRecord,
) {
  if (run.status !== "success") return [];
  const descriptor = repositoryOperationCommunityMappingDescriptor(
    run.inputSummary,
  );
  const mapping = canonicalRepositoryOperationCommunityMapping(
    run.parsedOutput,
  );
  const mappingDigest = repositoryOperationCommunityMappingDigest(
    run.parsedOutput,
  );
  if (
    !descriptor ||
    !mapping ||
    !repositoryOperationCommunityMappingIsExactPartition(
      run.parsedOutput,
      descriptor,
    ) ||
    !mappingDigest ||
    attestedRepositoryOperationCommunityMappingDigest(run.resultRefs) !==
      mappingDigest
  ) {
    return [];
  }
  return mapping.communities.map((community, communityIndex) => ({
    refreshRunId: descriptor.refreshRunId,
    parentSynthesisKey: descriptor.subsystemKey,
    mappingDigest,
    communityIndex,
    memberIndexes: [...community.memberIndexes],
  }));
}

function repositorySynthesisBatchKey(inputSummary: unknown) {
  const summary = record(inputSummary);
  const refreshRunId = typeof summary?.refreshRunId === "string"
    ? summary.refreshRunId.trim()
    : "";
  const subsystemKeys = summary?.subsystemKeys;
  const revisionRound = summary?.revisionRound === undefined
    ? 0
    : typeof summary.revisionRound === "number" &&
        Number.isInteger(summary.revisionRound) &&
        summary.revisionRound >= 0
    ? summary.revisionRound
    : null;
  if (!refreshRunId) return null;
  if (!Array.isArray(subsystemKeys)) return null;
  if (revisionRound === null) return null;
  const normalized = Array.from(new Set(subsystemKeys.flatMap((value) =>
    typeof value === "string" && value.trim() ? [value.trim()] : []
  ))).sort();
  return normalized.length
    ? JSON.stringify([refreshRunId, normalized, revisionRound])
    : null;
}

function repositorySynthesisRevisionRound(inputSummary: unknown) {
  const value = record(inputSummary)?.revisionRound;
  return value === undefined
    ? 0
    : typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function repositorySynthesisClaimCount(parsedOutput: unknown) {
  const subsystems = record(parsedOutput)?.subsystems;
  if (!Array.isArray(subsystems)) return null;
  return subsystems.reduce((total, value) => {
    const subsystem = record(value);
    return total +
      (Array.isArray(subsystem?.facts) ? subsystem.facts.length : 0) +
      (Array.isArray(subsystem?.highlights) ? subsystem.highlights.length : 0);
  }, 0);
}

function repositorySynthesisInputSubsystemKeys(inputSummary: unknown) {
  const values = record(inputSummary)?.subsystemKeys;
  if (!Array.isArray(values)) return null;
  const keys = values.flatMap((value) =>
    typeof value === "string" && value.trim() ? [value.trim()] : []
  );
  return keys.length === values.length && new Set(keys).size === keys.length
    ? keys
    : null;
}

function repositorySynthesisOutputSubsystemKeys(parsedOutput: unknown) {
  const values = record(parsedOutput)?.subsystems;
  if (!Array.isArray(values)) return null;
  const keys = values.flatMap((value) => {
    const subsystemKey = record(value)?.subsystemKey;
    return typeof subsystemKey === "string" && subsystemKey.trim()
      ? [subsystemKey.trim()]
      : [];
  });
  return keys.length === values.length && new Set(keys).size === keys.length
    ? keys
    : null;
}

function repositorySynthesisClaimKeys(parsedOutput: unknown) {
  const subsystems = record(parsedOutput)?.subsystems;
  if (!Array.isArray(subsystems)) return null;
  const keys: string[] = [];
  for (const value of subsystems) {
    const subsystem = record(value);
    const subsystemKey = typeof subsystem?.subsystemKey === "string"
      ? subsystem.subsystemKey.trim()
      : "";
    if (!subsystemKey || !Array.isArray(subsystem?.facts) || !Array.isArray(subsystem?.highlights)) {
      return null;
    }
    subsystem.facts.forEach((_claim, index) =>
      keys.push(`${subsystemKey}:fact:${index + 1}`)
    );
    subsystem.highlights.forEach((_claim, index) =>
      keys.push(`${subsystemKey}:highlight:${index + 1}`)
    );
  }
  return keys;
}

function repositoryCriticAssessmentKeys(parsedOutput: unknown) {
  return repositoryCriticAssessments(parsedOutput)?.map((assessment) =>
    assessment.claimKey
  ) ?? null;
}

function attestedRepositorySynthesisClaimContentDigest(resultRefs: unknown) {
  const digest = record(record(resultRefs)?.resultAttestation)?.claimContentDigest;
  return typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)
    ? digest
    : null;
}

type RepositorySynthesisRevisionPatchEntry = {
  claimKey: string;
  replacement: Record<string, unknown> | null;
};

type RepositorySynthesisRevisionPatch = {
  factRevisions: RepositorySynthesisRevisionPatchEntry[];
  highlightRevisions: RepositorySynthesisRevisionPatchEntry[];
};

type RepositorySynthesisAuditPromotion = {
  confidence: "low" | "medium" | "high";
  sensitivityFlag: boolean;
  productImportance: number;
  implementationBreadth: number;
  technicalDifficulty: number;
  distinctiveness: number;
};
type RepositorySynthesisAuditVisibility =
  | "private"
  | "resume_safe"
  | "linkedin_safe"
  | "public_safe";
type RepositorySynthesisAuditFactCategory =
  | "architecture"
  | "behavior"
  | "data_flow"
  | "code_location"
  | "dependency"
  | "configuration";

type RepositorySynthesisAuditClaim = {
  claimKey: string;
  kind: "fact" | "highlight";
  claim: Record<string, unknown>;
  citationIndexes: number[];
  promotion: RepositorySynthesisAuditPromotion | null;
  visibility: RepositorySynthesisAuditVisibility | null;
};

function repositorySynthesisAuditVisibility(
  value: unknown,
): RepositorySynthesisAuditVisibility | null {
  return value === "private" ||
      value === "resume_safe" ||
      value === "linkedin_safe" ||
      value === "public_safe"
    ? value
    : null;
}

function repositorySynthesisAuditFactCategory(
  value: unknown,
): RepositorySynthesisAuditFactCategory | null {
  return value === "architecture" ||
      value === "behavior" ||
      value === "data_flow" ||
      value === "code_location" ||
      value === "dependency" ||
      value === "configuration"
    ? value
    : null;
}

function repositorySynthesisAuditReviewNotes(value: unknown) {
  return value === null || typeof value === "string"
    ? value
    : undefined;
}

function repositorySynthesisAuditPromotion(
  value: Record<string, unknown>,
): RepositorySynthesisAuditPromotion | null {
  const confidence = value.confidence;
  const sensitivityFlag = value.sensitivityFlag;
  const scores = [
    value.productImportance,
    value.implementationBreadth,
    value.technicalDifficulty,
    value.distinctiveness,
  ];
  if (
    (confidence !== "low" && confidence !== "medium" && confidence !== "high") ||
    typeof sensitivityFlag !== "boolean" ||
    scores.some((score) =>
      typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 5
    )
  ) return null;
  return {
    confidence: confidence as RepositorySynthesisAuditPromotion["confidence"],
    sensitivityFlag,
    productImportance: value.productImportance as number,
    implementationBreadth: value.implementationBreadth as number,
    technicalDifficulty: value.technicalDifficulty as number,
    distinctiveness: value.distinctiveness as number,
  };
}

function repositorySynthesisAuditClaimPayload(value: unknown) {
  const subsystems = record(value)?.subsystems;
  if (!Array.isArray(subsystems) || subsystems.length < 1 || subsystems.length > 8) {
    return null;
  }
  const claims: RepositorySynthesisAuditClaim[] = [];
  const subsystemKeys = new Set<string>();
  for (const candidate of subsystems) {
    const subsystem = record(candidate);
    const subsystemKey = typeof subsystem?.subsystemKey === "string"
      ? subsystem.subsystemKey.trim()
      : "";
    if (
      subsystemKey.length < 2 ||
      subsystemKey.length > 100 ||
      subsystemKeys.has(subsystemKey) ||
      !Array.isArray(subsystem?.facts) ||
      subsystem.facts.length > 3 ||
      !Array.isArray(subsystem.highlights) ||
      subsystem.highlights.length > 2
    ) {
      return null;
    }
    subsystemKeys.add(subsystemKey);
    for (const [index, candidateFact] of subsystem.facts.entries()) {
      const fact = record(candidateFact);
      if (!fact || !Array.isArray(fact.citationIndexes)) return null;
      claims.push({
        claimKey: `${subsystemKey}:fact:${index + 1}`,
        kind: "fact",
        claim: {
          statement: fact.statement,
          category: fact.category,
          reviewNotes: fact.reviewNotes,
        },
        citationIndexes: fact.citationIndexes as number[],
        promotion: repositorySynthesisAuditPromotion(fact),
        visibility: null,
      });
    }
    for (const [index, candidateHighlight] of subsystem.highlights.entries()) {
      const highlight = record(candidateHighlight);
      if (!highlight || !Array.isArray(highlight.citationIndexes)) return null;
      claims.push({
        claimKey: `${subsystemKey}:highlight:${index + 1}`,
        kind: "highlight",
        claim: { text: highlight.text, summary: highlight.summary },
        citationIndexes: highlight.citationIndexes as number[],
        promotion: repositorySynthesisAuditPromotion(highlight),
        visibility: repositorySynthesisAuditVisibility(highlight.visibility),
      });
    }
  }
  if (
    claims.length > 10 ||
    new Set(claims.map((claim) => claim.claimKey)).size !== claims.length ||
    (claims.length && !repositorySynthesisCriticClaimContentDigest(claims))
  ) {
    return null;
  }
  return claims;
}

function repositorySynthesisAuditClaimPayloadDigest(
  claims: readonly RepositorySynthesisAuditClaim[],
) {
  return claims.length
    ? repositorySynthesisCriticClaimContentDigest(claims)
    : computedRepositorySynthesisClaimContentDigest({ subsystems: [] });
}

function repositorySynthesisAuditClaimsHaveCompleteServerShape(
  claims: readonly RepositorySynthesisAuditClaim[],
) {
  const boundedTrimmedText = (
    value: unknown,
    minimum: number,
    maximum: number,
  ) => typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum;
  const fieldsAreComplete = claims.every((claim) => {
    const citationsAreValid = claim.citationIndexes.length >= 1 &&
      claim.citationIndexes.length <= 6 &&
      claim.citationIndexes.every((index) =>
        Number.isInteger(index) && index >= 1
      );
    if (!claim.promotion || !citationsAreValid) return false;
    if (claim.kind === "highlight") {
      return claim.visibility !== null &&
        boundedTrimmedText(claim.claim.text, 10, 1_000) &&
        boundedTrimmedText(claim.claim.summary, 10, 1_000);
    }
    const reviewNotes = repositorySynthesisAuditReviewNotes(
      claim.claim.reviewNotes,
    );
    return claim.visibility === null &&
      boundedTrimmedText(claim.claim.statement, 10, 500) &&
      repositorySynthesisAuditFactCategory(claim.claim.category) !== null &&
      reviewNotes !== undefined &&
      (
        reviewNotes === null ||
        (reviewNotes === reviewNotes.trim() && reviewNotes.length <= 1_000)
      );
  });
  if (!fieldsAreComplete) return false;
  const facts = claims.filter((claim) => claim.kind === "fact");
  return claims
    .filter((claim) => claim.kind === "highlight")
    .every((highlight) => {
      const subsystemKey = repositorySynthesisAuditClaimSubsystemKey(
        highlight.claimKey,
        "highlight",
      );
      return Boolean(subsystemKey) && facts.filter((fact) =>
        repositorySynthesisAuditClaimSubsystemKey(fact.claimKey, "fact") ===
          subsystemKey && auditHighlightPromotesFact(highlight, fact)
      ).length === 1;
    });
}

function repositorySynthesisAuditClaimsExactlyEqual(
  left: readonly RepositorySynthesisAuditClaim[],
  right: readonly RepositorySynthesisAuditClaim[],
) {
  const canonical = (claims: readonly RepositorySynthesisAuditClaim[]) =>
    [...claims]
      .sort((a, b) => a.claimKey.localeCompare(b.claimKey))
      .map((claim) => ({
        claimKey: claim.claimKey,
        kind: claim.kind,
        claim: claim.kind === "fact"
          ? {
              statement: claim.claim.statement,
              category: claim.claim.category,
              reviewNotes: claim.claim.reviewNotes,
            }
          : {
              text: claim.claim.text,
              summary: claim.claim.summary,
            },
        citationIndexes: claim.citationIndexes,
        promotion: claim.promotion,
        visibility: claim.visibility,
      }));
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function repositorySynthesisAuditClaimSubsystemKey(
  claimKey: string,
  kind?: "fact" | "highlight",
) {
  const markers = kind
    ? [`:${kind}:`]
    : [":fact:", ":highlight:"];
  for (const marker of markers) {
    const markerIndex = claimKey.lastIndexOf(marker);
    if (markerIndex > 0) return claimKey.slice(0, markerIndex);
  }
  return null;
}

function repositorySynthesisRevisionEvidenceIndexesBySubsystem(
  value: unknown,
) {
  if (!Array.isArray(value) || !value.length || value.length > 10) return null;
  const indexesBySubsystem = new Map<string, ReadonlySet<number>>();
  for (const candidate of value) {
    const entry = record(candidate);
    const subsystemKey = typeof entry?.subsystemKey === "string"
      ? entry.subsystemKey.trim()
      : "";
    const citationIndexes = normalizedAuditCitations(entry?.citationIndexes);
    if (
      !subsystemKey ||
      !citationIndexes?.length ||
      indexesBySubsystem.has(subsystemKey)
    ) return null;
    indexesBySubsystem.set(subsystemKey, new Set(citationIndexes));
  }
  return indexesBySubsystem;
}

function repositorySynthesisRevisionPatch(
  value: unknown,
): RepositorySynthesisRevisionPatch | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    return null;
  }
  const factRevisions: RepositorySynthesisRevisionPatchEntry[] = [];
  const highlightRevisions: RepositorySynthesisRevisionPatchEntry[] = [];
  for (const candidate of value) {
    const entry = record(candidate);
    const claimKey = typeof entry?.claimKey === "string"
      ? entry.claimKey.trim()
      : "";
    if (
      !entry ||
      !claimKey ||
      (entry.kind !== "fact" && entry.kind !== "highlight") ||
      !Object.hasOwn(entry, "replacement") ||
      Object.keys(entry).some((key) =>
        key !== "claimKey" && key !== "kind" && key !== "replacement"
      )
    ) {
      return null;
    }
    const replacement = entry.replacement === null
      ? null
      : record(entry.replacement);
    if (entry.replacement !== null && !replacement) return null;
    const parsed = { claimKey, replacement };
    if (entry.kind === "fact") factRevisions.push(parsed);
    else highlightRevisions.push(parsed);
  }
  const claimKeys = [
    ...factRevisions.map((entry) => entry.claimKey),
    ...highlightRevisions.map((entry) => entry.claimKey),
  ];
  if (
    new Set(claimKeys).size !== claimKeys.length
  ) {
    return null;
  }
  return { factRevisions, highlightRevisions };
}

function applyRepositorySynthesisRevisionPatch(
  prior: readonly RepositorySynthesisAuditClaim[],
  patch: RepositorySynthesisRevisionPatch,
) {
  const slots = new Map<string, "fact" | "highlight">();
  const groups = new Map<string, Array<{
    claim: RepositorySynthesisAuditClaim;
    subsystemKey: string;
    position: number;
  }>>();
  for (const claim of prior) {
    const marker = `:${claim.kind}:`;
    const markerIndex = claim.claimKey.lastIndexOf(marker);
    const subsystemKey = markerIndex > 0
      ? claim.claimKey.slice(0, markerIndex)
      : "";
    const position = Number(claim.claimKey.slice(markerIndex + marker.length));
    if (!subsystemKey || !Number.isInteger(position) || position < 1) return null;
    const groupKey = JSON.stringify([subsystemKey, claim.kind]);
    const group = groups.get(groupKey) ?? [];
    group.push({ claim, subsystemKey, position });
    groups.set(groupKey, group);
    slots.set(claim.claimKey, claim.kind);
  }
  const factRevisions = new Map(
    patch.factRevisions.map((entry) => [entry.claimKey, entry.replacement]),
  );
  const highlightRevisions = new Map(
    patch.highlightRevisions.map((entry) => [entry.claimKey, entry.replacement]),
  );
  if (
    patch.factRevisions.some((entry) => slots.get(entry.claimKey) !== "fact") ||
    patch.highlightRevisions.some((entry) =>
      slots.get(entry.claimKey) !== "highlight"
    )
  ) {
    return null;
  }

  const keyRemap = new Map<string, string>();
  const claims: RepositorySynthesisAuditClaim[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.position - right.position);
    if (group.some((entry, index) => entry.position !== index + 1)) return null;
    let nextPosition = 0;
    for (const entry of group) {
      const revisions = entry.claim.kind === "fact"
        ? factRevisions
        : highlightRevisions;
      const replacement = revisions.get(entry.claim.claimKey);
      if (revisions.has(entry.claim.claimKey) && replacement === null) continue;
      nextPosition += 1;
      const nextClaimKey =
        `${entry.subsystemKey}:${entry.claim.kind}:${nextPosition}`;
      const nextClaim = replacement
        ? entry.claim.kind === "fact"
          ? {
              claimKey: nextClaimKey,
              kind: "fact" as const,
              claim: {
                statement: replacement.statement,
                category: replacement.category,
                reviewNotes: replacement.reviewNotes,
              },
              citationIndexes: replacement.citationIndexes as number[],
              promotion: repositorySynthesisAuditPromotion(replacement),
              visibility: null,
            }
          : {
              claimKey: nextClaimKey,
              kind: "highlight" as const,
              claim: {
                text: replacement.text,
                summary: replacement.summary,
              },
              citationIndexes: replacement.citationIndexes as number[],
              promotion: repositorySynthesisAuditPromotion(replacement),
              visibility: repositorySynthesisAuditVisibility(
                replacement.visibility,
              ),
            }
        : { ...entry.claim, claimKey: nextClaimKey };
      claims.push(nextClaim);
      keyRemap.set(entry.claim.claimKey, nextClaimKey);
    }
  }
  return repositorySynthesisAuditClaimPayloadDigest(claims)
    ? { claims, keyRemap }
    : null;
}

function repositorySynthesisRevisionCriticClaims(
  patch: RepositorySynthesisRevisionPatch,
) {
  const claims: Array<Record<string, unknown>> = [];
  for (const entry of patch.factRevisions) {
    if (!entry.replacement) continue;
    claims.push({
      claimKey: entry.claimKey,
      kind: "fact",
      claim: { statement: entry.replacement.statement },
      citationIndexes: entry.replacement.citationIndexes,
    });
  }
  for (const entry of patch.highlightRevisions) {
    if (!entry.replacement) continue;
    claims.push({
      claimKey: entry.claimKey,
      kind: "highlight",
      claim: {
        text: entry.replacement.text,
        summary: entry.replacement.summary,
      },
      citationIndexes: entry.replacement.citationIndexes,
    });
  }
  const claimContentDigest = claims.length
    ? repositorySynthesisCriticClaimContentDigest(claims)
    : null;
  return claims.length && !claimContentDigest
    ? null
    : { claims, claimContentDigest };
}

function normalizedAuditCitations(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.some((entry) =>
      typeof entry !== "number" || !Number.isInteger(entry) || entry < 1
    )
  ) return null;
  return Array.from(new Set(value as number[])).sort((left, right) => left - right);
}

function sameAuditCitations(left: unknown, right: unknown) {
  const normalizedLeft = normalizedAuditCitations(left);
  const normalizedRight = normalizedAuditCitations(right);
  return normalizedLeft !== null && normalizedRight !== null &&
    JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function sameExactAuditCitations(left: unknown, right: unknown) {
  return Array.isArray(left) && Array.isArray(right) &&
    JSON.stringify(left) === JSON.stringify(right);
}

function normalizedAuditText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : null;
}

function sameAuditPromotion(
  left: RepositorySynthesisAuditPromotion | null,
  right: RepositorySynthesisAuditPromotion | null,
) {
  return left !== null && right !== null &&
    left.confidence === right.confidence &&
    left.sensitivityFlag === right.sensitivityFlag &&
    left.productImportance === right.productImportance &&
    left.implementationBreadth === right.implementationBreadth &&
    left.technicalDifficulty === right.technicalDifficulty &&
    left.distinctiveness === right.distinctiveness;
}

function auditHighlightPromotesFact(
  highlight: RepositorySynthesisAuditClaim,
  fact: RepositorySynthesisAuditClaim,
) {
  return highlight.kind === "highlight" && fact.kind === "fact" &&
    normalizedAuditText(highlight.claim.summary) ===
      normalizedAuditText(fact.claim.statement) &&
    sameAuditCitations(highlight.citationIndexes, fact.citationIndexes) &&
    sameAuditPromotion(highlight.promotion, fact.promotion);
}

/**
 * V3 may server-rebind an otherwise accepted Highlight when its promoted Fact
 * changes. Admit only that exact derived cascade in addition to claims the
 * prior critic rejected; arbitrary accepted-claim edits remain invalid.
 */
function repositorySynthesisRevisionPatchIsAuthorized(input: {
  priorClaims: readonly RepositorySynthesisAuditClaim[];
  patch: RepositorySynthesisRevisionPatch;
  rejectedClaimKeys: readonly string[];
  priorAssessments: readonly {
    claimKey: string;
    supported: boolean;
    issues: string[];
  }[];
  allowedCitationIndexesBySubsystem: ReadonlyMap<
    string,
    ReadonlySet<number>
  >;
}) {
  if (!repositorySynthesisAuditClaimsHaveCompleteServerShape(
    input.priorClaims,
  )) return false;
  const rejected = new Set(input.rejectedClaimKeys);
  const expected = new Set(input.rejectedClaimKeys);
  const highlightPatchByKey = new Map(input.patch.highlightRevisions.map(
    (entry) => [entry.claimKey, entry] as const,
  ));
  const factPatchByKey = new Map(input.patch.factRevisions.map(
    (entry) => [entry.claimKey, entry] as const,
  ));
  const facts = input.priorClaims.filter((claim) => claim.kind === "fact");
  const highlights = input.priorClaims.filter((claim) =>
    claim.kind === "highlight"
  );
  const priorClaimByKey = new Map(input.priorClaims.map((claim) => [
    claim.claimKey,
    claim,
  ]));
  const issuesByKey = new Map(input.priorAssessments.map((assessment) => [
    assessment.claimKey,
    assessment.issues,
  ]));
  for (const revision of [
    ...input.patch.factRevisions.map((entry) => ({
      ...entry,
      kind: "fact" as const,
    })),
    ...input.patch.highlightRevisions.map((entry) => ({
      ...entry,
      kind: "highlight" as const,
    })),
  ]) {
    if (revision.replacement === null) continue;
    const subsystemKey = repositorySynthesisAuditClaimSubsystemKey(
      revision.claimKey,
      revision.kind,
    );
    const allowedCitationIndexes = subsystemKey
      ? input.allowedCitationIndexesBySubsystem.get(subsystemKey)
      : null;
    const replacementPromotion = repositorySynthesisAuditPromotion(
      revision.replacement,
    );
    const replacementVisibility = revision.kind === "highlight"
      ? repositorySynthesisAuditVisibility(revision.replacement.visibility)
      : null;
    if (
      !subsystemKey ||
      !allowedCitationIndexes ||
      !replacementPromotion ||
      (
        revision.kind === "fact" &&
        (
          !repositorySynthesisAuditFactCategory(
            revision.replacement.category,
          ) ||
          repositorySynthesisAuditReviewNotes(
            revision.replacement.reviewNotes,
          ) === undefined
        )
      ) ||
      (revision.kind === "highlight" && !replacementVisibility) ||
      !Array.isArray(revision.replacement.citationIndexes) ||
      revision.replacement.citationIndexes.some((index) =>
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        !allowedCitationIndexes.has(index)
      )
    ) return false;

    if (!rejected.has(revision.claimKey)) continue;
    const priorClaim = priorClaimByKey.get(revision.claimKey);
    if (!priorClaim || priorClaim.kind !== revision.kind) return false;
    const wordingChanged = revision.kind === "fact"
      ? revision.replacement.statement !== priorClaim.claim.statement
      : revision.replacement.text !== priorClaim.claim.text ||
        revision.replacement.summary !== priorClaim.claim.summary;
    const citationsChanged = !sameAuditCitations(
      revision.replacement.citationIndexes,
      priorClaim.citationIndexes,
    );
    const requiresWordingChange = (issuesByKey.get(revision.claimKey) ?? [])
      .some((issue) =>
        issue === "unsupported_compound_action" ||
        issue === "unsupported_broad_qualifier" ||
        issue === "unsupported_detail"
      );
    if (!wordingChanged && (!citationsChanged || requiresWordingChange)) {
      return false;
    }
  }
  const effectiveFacts = facts.flatMap<RepositorySynthesisAuditClaim>((fact) => {
    const revision = factPatchByKey.get(fact.claimKey);
    if (!revision) return [fact];
    if (revision.replacement === null) return [];
    return [{
      ...fact,
      kind: "fact" as const,
      claim: {
        statement: revision.replacement.statement,
        category: revision.replacement.category,
        reviewNotes: revision.replacement.reviewNotes,
      },
      citationIndexes: revision.replacement.citationIndexes as number[],
      promotion: repositorySynthesisAuditPromotion(revision.replacement),
    }];
  });
  for (const priorHighlight of highlights) {
    const markerIndex = priorHighlight.claimKey.lastIndexOf(":highlight:");
    const subsystemPrefix = markerIndex > 0
      ? priorHighlight.claimKey.slice(0, markerIndex)
      : "";
    if (!subsystemPrefix) return false;
    const subsystemFacts = facts.filter((candidate) =>
      candidate.claimKey.startsWith(`${subsystemPrefix}:fact:`)
    );
    const matchingPriorFacts = subsystemFacts.filter((candidate) =>
      auditHighlightPromotesFact(priorHighlight, candidate)
    );
    const priorFact = matchingPriorFacts.length === 1
      ? matchingPriorFacts[0]!
      : null;
    const factRevision = priorFact
      ? factPatchByKey.get(priorFact.claimKey)
      : undefined;
    const isRejected = rejected.has(priorHighlight.claimKey);
    const isAcceptedCascade = !isRejected && Boolean(factRevision);
    if (isAcceptedCascade) expected.add(priorHighlight.claimKey);
    if (!isRejected && !isAcceptedCascade) continue;

    const highlightRevision = highlightPatchByKey.get(
      priorHighlight.claimKey,
    );
    if (!highlightRevision) return false;
    if (!priorFact) {
      if (highlightRevision.replacement !== null) return false;
      continue;
    }
    const effectiveFact = factRevision
      ? effectiveFacts.find((candidate) =>
          candidate.claimKey === priorFact.claimKey
        ) ?? null
      : priorFact;
    if (!effectiveFact) {
      if (highlightRevision.replacement !== null) return false;
      continue;
    }
    if (isRejected && highlightRevision.replacement === null) continue;

    const expectedReplacementHighlight: RepositorySynthesisAuditClaim = {
      ...priorHighlight,
      claim: {
        text: priorHighlight.claim.text,
        summary: effectiveFact.claim.statement,
      },
      citationIndexes: [...effectiveFact.citationIndexes],
      promotion: effectiveFact.promotion,
      visibility: priorHighlight.visibility,
    };
    const effectiveSubsystemFacts = effectiveFacts.filter((candidate) =>
      candidate.claimKey.startsWith(`${subsystemPrefix}:fact:`)
    );
    const remainsUniquelyBound = effectiveSubsystemFacts.filter((candidate) =>
      auditHighlightPromotesFact(expectedReplacementHighlight, candidate)
    ).length === 1;
    if (!remainsUniquelyBound) {
      if (highlightRevision.replacement !== null) return false;
      continue;
    }
    if (highlightRevision.replacement === null) return false;
    if (
      highlightRevision.replacement.summary !== effectiveFact.claim.statement ||
      !sameExactAuditCitations(
        highlightRevision.replacement.citationIndexes,
        effectiveFact.citationIndexes,
      ) ||
      !sameAuditPromotion(
        repositorySynthesisAuditPromotion(highlightRevision.replacement),
        effectiveFact.promotion,
      ) ||
      repositorySynthesisAuditVisibility(
        highlightRevision.replacement.visibility,
      ) !== priorHighlight.visibility ||
      (
        !isRejected &&
        highlightRevision.replacement.text !== priorHighlight.claim.text
      )
    ) return false;
  }
  if (!sameUniqueKeys(
    [...input.patch.factRevisions, ...input.patch.highlightRevisions]
      .map((entry) => entry.claimKey),
    [...expected],
  )) return false;
  const applied = applyRepositorySynthesisRevisionPatch(
    input.priorClaims,
    input.patch,
  );
  if (
    !applied ||
    !repositorySynthesisAuditClaimsHaveCompleteServerShape(applied.claims)
  ) return false;
  const appliedFacts = applied.claims.filter((claim) => claim.kind === "fact");
  return applied.claims
    .filter((claim) => claim.kind === "highlight")
    .every((highlight) => {
      const subsystemKey = repositorySynthesisAuditClaimSubsystemKey(
        highlight.claimKey,
        "highlight",
      );
      return Boolean(subsystemKey) && appliedFacts.filter((fact) =>
        repositorySynthesisAuditClaimSubsystemKey(fact.claimKey, "fact") ===
          subsystemKey && auditHighlightPromotesFact(highlight, fact)
      ).length === 1;
    });
}

function repositorySynthesisFactFloorRevisionPatchIsAuthorized(input: {
  priorClaims: readonly RepositorySynthesisAuditClaim[];
  patch: RepositorySynthesisRevisionPatch;
  priorAssessments: readonly {
    claimKey: string;
    supported: boolean;
    issues: string[];
  }[];
  allowedCitationIndexesBySubsystem: ReadonlyMap<
    string,
    ReadonlySet<number>
  >;
}) {
  const assessmentByKey = new Map(input.priorAssessments.map((assessment) => [
    assessment.claimKey,
    assessment,
  ]));
  const factsBySubsystem = new Map<string, RepositorySynthesisAuditClaim[]>();
  input.priorClaims
    .filter((claim) => claim.kind === "fact")
    .forEach((fact) => {
      const subsystemKey = repositorySynthesisAuditClaimSubsystemKey(
        fact.claimKey,
        "fact",
      );
      if (!subsystemKey) return;
      factsBySubsystem.set(subsystemKey, [
        ...(factsBySubsystem.get(subsystemKey) ?? []),
        fact,
      ]);
    });

  const selectedFactKeys = Array.from(factsBySubsystem.values()).flatMap(
    (facts) => {
      const hasSupportedFact = facts.some((fact) => {
        const assessment = assessmentByKey.get(fact.claimKey);
        return assessment?.supported === true && assessment.issues.length === 0;
      });
      if (hasSupportedFact) return [];
      const firstRejected = facts.find((fact) => {
        const assessment = assessmentByKey.get(fact.claimKey);
        return Boolean(
          assessment &&
          (!assessment.supported || assessment.issues.length > 0),
        );
      });
      return firstRejected ? [firstRejected.claimKey] : [];
    },
  );
  const patchFactKeys = input.patch.factRevisions.map((entry) => entry.claimKey);
  if (!sameUniqueKeys(patchFactKeys, selectedFactKeys)) return false;

  const selectedFacts = input.priorClaims.filter((claim) =>
    claim.kind === "fact" && selectedFactKeys.includes(claim.claimKey)
  );
  const dependentHighlightKeys = input.priorClaims.flatMap((claim) =>
    claim.kind === "highlight" &&
      selectedFacts.some((fact) => auditHighlightPromotesFact(claim, fact))
      ? [claim.claimKey]
      : []
  );
  if (
    !sameUniqueKeys(
      input.patch.highlightRevisions.map((entry) => entry.claimKey),
      dependentHighlightKeys,
    ) ||
    input.patch.highlightRevisions.some((entry) => entry.replacement !== null)
  ) return false;

  const authorizedClaimKeys = [
    ...selectedFactKeys,
    ...dependentHighlightKeys,
  ];
  return repositorySynthesisRevisionPatchIsAuthorized({
    ...input,
    rejectedClaimKeys: authorizedClaimKeys,
  });
}

function repositorySynthesisQualityCriticalFactRevisionPatchIsAuthorized(input: {
  priorClaims: readonly RepositorySynthesisAuditClaim[];
  patch: RepositorySynthesisRevisionPatch;
  priorAssessments: readonly {
    claimKey: string;
    supported: boolean;
    issues: string[];
  }[];
  allowedCitationIndexesBySubsystem: ReadonlyMap<
    string,
    ReadonlySet<number>
  >;
}) {
  const assessmentByKey = new Map(input.priorAssessments.map((assessment) => [
    assessment.claimKey,
    assessment,
  ]));
  const factsBySubsystem = new Map<string, RepositorySynthesisAuditClaim[]>();
  input.priorClaims
    .filter((claim) => claim.kind === "fact")
    .forEach((fact) => {
      const subsystemKey = repositorySynthesisAuditClaimSubsystemKey(
        fact.claimKey,
        "fact",
      );
      if (!subsystemKey) return;
      factsBySubsystem.set(subsystemKey, [
        ...(factsBySubsystem.get(subsystemKey) ?? []),
        fact,
      ]);
    });

  const rejected = (fact: RepositorySynthesisAuditClaim) => {
    const assessment = assessmentByKey.get(fact.claimKey);
    return Boolean(
      assessment && (!assessment.supported || assessment.issues.length > 0),
    );
  };
  const supported = (fact: RepositorySynthesisAuditClaim) => {
    const assessment = assessmentByKey.get(fact.claimKey);
    return assessment?.supported === true && assessment.issues.length === 0;
  };
  const qualityCritical = (fact: RepositorySynthesisAuditClaim) => {
    const promotion = fact.promotion;
    return Boolean(
      promotion &&
      promotion.productImportance >= 3 &&
      promotion.implementationBreadth >= 2 &&
      promotion.technicalDifficulty >= 3 &&
      promotion.distinctiveness >= 3,
    );
  };
  const selectedFactKeys = Array.from(factsBySubsystem.entries()).flatMap(
    ([subsystemKey, facts]) => {
      const hasSupportedFact = facts.some(supported);
      if (!hasSupportedFact) {
        const firstRejected = facts.find(rejected);
        return firstRejected ? [firstRejected.claimKey] : [];
      }
      if (subsystemKey.startsWith("repository_area:quality")) return [];
      const highestRankedEligible = facts
        .map((fact, index) => ({ fact, index }))
        .filter(({ fact }) => rejected(fact) && qualityCritical(fact))
        .sort((left, right) => {
          const leftPromotion = left.fact.promotion!;
          const rightPromotion = right.fact.promotion!;
          return (
            rightPromotion.productImportance +
            rightPromotion.implementationBreadth +
            rightPromotion.technicalDifficulty +
            rightPromotion.distinctiveness
          ) - (
            leftPromotion.productImportance +
            leftPromotion.implementationBreadth +
            leftPromotion.technicalDifficulty +
            leftPromotion.distinctiveness
          ) || left.index - right.index;
        })[0]?.fact;
      return highestRankedEligible ? [highestRankedEligible.claimKey] : [];
    },
  );
  if (!sameUniqueKeys(
    input.patch.factRevisions.map((entry) => entry.claimKey),
    selectedFactKeys,
  )) return false;

  const selectedFacts = input.priorClaims.filter((claim) =>
    claim.kind === "fact" && selectedFactKeys.includes(claim.claimKey)
  );
  const dependentHighlightKeys = input.priorClaims.flatMap((claim) =>
    claim.kind === "highlight" &&
      selectedFacts.some((fact) => auditHighlightPromotesFact(claim, fact))
      ? [claim.claimKey]
      : []
  );
  if (
    !sameUniqueKeys(
      input.patch.highlightRevisions.map((entry) => entry.claimKey),
      dependentHighlightKeys,
    ) ||
    input.patch.highlightRevisions.some((entry) => entry.replacement !== null)
  ) return false;

  return repositorySynthesisRevisionPatchIsAuthorized({
    ...input,
    rejectedClaimKeys: [...selectedFactKeys, ...dependentHighlightKeys],
  });
}

function repositoryCriticAssessments(parsedOutput: unknown) {
  const values = record(parsedOutput)?.assessments;
  if (!Array.isArray(values)) return null;
  const assessments: Array<{
    claimKey: string;
    supported: boolean;
    issues: string[];
  }> = [];
  const allowedIssues = new Set([
    "unsupported_compound_action",
    "unsupported_broad_qualifier",
    "unsupported_detail",
    "citation_mismatch",
    "documentation_only",
  ]);
  for (const candidate of values) {
    const assessment = record(candidate);
    const claimKey = typeof assessment?.claimKey === "string"
      ? assessment.claimKey.trim()
      : "";
    if (
      !claimKey ||
      typeof assessment?.supported !== "boolean" ||
      !Array.isArray(assessment.issues) ||
      assessment.issues.length > 4 ||
      assessment.issues.some((issue) =>
        typeof issue !== "string" || !allowedIssues.has(issue)
      )
    ) {
      return null;
    }
    assessments.push({
      claimKey,
      supported: assessment.supported,
      issues: assessment.issues as string[],
    });
  }
  return new Set(assessments.map((assessment) => assessment.claimKey)).size ===
      assessments.length &&
      assessments.every((assessment) =>
        assessment.supported
          ? assessment.issues.length === 0
          : assessment.issues.length > 0
      )
    ? assessments
    : null;
}

function repositorySynthesisDeltaCriticAttestation(
  resultRefs: unknown,
  parsedOutput: unknown,
) {
  const attestation = record(record(resultRefs)?.resultAttestation);
  if (attestation?.criticScope !== "changed_claims") return null;
  const claimCount = attestation.criticClaimCount;
  const claimKeys = attestation.criticClaimKeys;
  const claimContentDigest = attestation.criticClaimContentDigest;
  const priorClaimContentDigest = attestation.priorClaimContentDigest;
  const revisionPatch = repositorySynthesisRevisionPatch(
    record(parsedOutput)?.revisionPatch,
  );
  if (
    typeof claimCount !== "number" ||
    !Number.isInteger(claimCount) ||
    claimCount < 0 ||
    !Array.isArray(claimKeys) ||
    claimKeys.some((key) => typeof key !== "string" || !key.trim()) ||
    claimKeys.length !== claimCount ||
    new Set(claimKeys).size !== claimKeys.length ||
    (
      claimCount > 0 &&
      (
        typeof claimContentDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(claimContentDigest)
      )
    ) ||
    (
      claimCount === 0 &&
      claimContentDigest !== null &&
      claimContentDigest !== undefined
    ) ||
    typeof priorClaimContentDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(priorClaimContentDigest) ||
    revisionPatch === null
  ) {
    return null;
  }
  return {
    claimCount,
    claimKeys: claimKeys as string[],
    claimContentDigest: claimCount > 0 ? claimContentDigest as string : null,
    priorClaimContentDigest,
    revisionPatch,
  };
}

function repositorySynthesisPriorBatchKey(inputSummary: unknown) {
  const summary = record(inputSummary);
  const revisionRound = summary?.revisionRound;
  if (
    typeof revisionRound !== "number" ||
    !Number.isInteger(revisionRound) ||
    revisionRound < 1
  ) {
    return null;
  }
  return repositorySynthesisBatchKey({
    ...summary,
    revisionRound: revisionRound - 1,
  });
}

function sameUniqueKeys(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((key) => right.includes(key));
}

function digestCanonicalStrings(values: readonly string[]) {
  return createHash("sha256")
    .update(JSON.stringify([...values].sort()))
    .digest("hex");
}

function digestHighlightSelectionOutput(value: unknown) {
  const output = record(value);
  const selections = Array.isArray(output?.selections)
    ? output.selections.map((value) => {
        const selection = record(value);
        return {
          candidateId: selection?.candidateId,
          title: selection?.title,
        };
      })
    : null;
  const omissions = Array.isArray(output?.omissions)
    ? output.omissions.map((value) => {
        const omission = record(value);
        return {
          candidateId: omission?.candidateId,
          reason: omission?.reason,
        };
      })
    : null;
  return createHash("sha256")
    .update(JSON.stringify({ selections, omissions }))
    .digest("hex");
}

function digestHighlightCriticOutput(value: unknown) {
  const output = record(value);
  const includesCorrectedTitle = Array.isArray(output?.assessments) &&
    output.assessments.some((value) => {
      const assessment = record(value);
      return assessment !== null &&
        Object.prototype.hasOwnProperty.call(assessment, "correctedTitle");
    });
  const assessments = Array.isArray(output?.assessments)
    ? output.assessments.map((value) => {
        const assessment = record(value);
        return {
          candidateId: assessment?.candidateId,
          supported: assessment?.supported,
          issues: assessment?.issues,
          ...(includesCorrectedTitle
            ? { correctedTitle: assessment?.correctedTitle }
            : {}),
        };
      })
    : null;
  return createHash("sha256")
    .update(JSON.stringify({ assessments }))
    .digest("hex");
}

function legacySelectedCandidateAttestationMatches(
  parsedSelectedIds: readonly string[],
  attestedValues: readonly unknown[],
) {
  const exactIds = attestedValues.filter((value): value is string =>
    typeof value === "string"
  );
  // A sanitized preview such as `[2 more items]` cannot authenticate the
  // omitted IDs. Legacy records remain verifiable only when they persist the
  // complete exact set; current records use count + canonical SHA-256 digest.
  return sameUniqueKeys(parsedSelectedIds, exactIds);
}

function expectedIdentityFor(
  kind: string,
  expected: Partial<Record<RepositoryKnowledgeModelGenerationKind, RepositoryKnowledgeExpectedModelIdentity>>,
) {
  return repositoryKnowledgeModelGenerationKinds.includes(
    kind as RepositoryKnowledgeModelGenerationKind,
  )
    ? expected[kind as RepositoryKnowledgeModelGenerationKind]
    : undefined;
}

/**
 * Separates product-quality gaps from execution-integrity failures. Thin
 * semantic coverage remains visible to the quality evaluator, while provider
 * substitution, failed generation, unknown usage, or deterministic synthesis
 * makes a live comparison invalid instead of silently scoring fallback output.
 */
export function evaluateRepositoryKnowledgeMainPath(input: {
  generationRuns: readonly RepositoryKnowledgeGenerationAuditRecord[];
  expectedIdentities: Partial<Record<RepositoryKnowledgeModelGenerationKind, RepositoryKnowledgeExpectedModelIdentity>>;
  /** Agentic investigators use the primary-answer profile, not legacy code extraction. */
  expectedAgenticInvestigatorIdentity?: RepositoryKnowledgeExpectedModelIdentity;
  expectedSynthesisCriticIdentity?: RepositoryKnowledgeExpectedModelIdentity;
  coverage: unknown;
  orchestration: unknown;
  warnings: unknown;
}) {
  const issues: string[] = [];
  const orchestration = record(input.orchestration);
  const agenticInvestigation =
    orchestration?.executionMode === "agentic_investigator";
  const capabilitySynthesisRuns = input.generationRuns.filter((run) =>
    run.kind === "capability_synthesis"
  );
  const synthesisRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) === "synthesis"
  );
  const criticRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) === "entailment_critic"
  );
  const operationCommunityMappingRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) ===
      "operation_community_mapping"
  );
  const highlightSelectionRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) ===
      "repository_highlight_selection"
  );
  const highlightCriticRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) ===
      "repository_highlight_critic"
  );
  const limitationCriticRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) === "limitation_entailment_critic"
  );
  for (const run of limitationCriticRuns) {
    const summary = record(run.inputSummary);
    const attestation = record(record(run.resultRefs)?.resultAttestation);
    const claims = Array.isArray(attestation?.claims) ? attestation.claims : [];
    const claimDigest = repositorySynthesisCriticClaimContentDigest(claims);
    const subsystemKeys = Array.isArray(summary?.subsystemKeys) ? summary.subsystemKeys : [];
    const keys = claims.map((claim) => record(claim)?.claimKey);
    const assessmentKeys = repositoryCriticAssessmentKeys(run.parsedOutput);
    if (
      !summary || typeof summary.refreshRunId !== "string" || !summary.refreshRunId ||
      !claimDigest || claims.length > 10 || summary.claimCount !== claims.length ||
      summary.claimContentDigest !== claimDigest || attestation?.claimContentDigest !== claimDigest ||
      !subsystemKeys.length || !subsystemKeys.every((key) => typeof key === "string" && key.length > 0) ||
      !claims.every((claim) => record(claim)?.kind === "fact") ||
      !sameUniqueKeys(keys as string[], subsystemKeys.map((key) => `${key}:fact:1`)) ||
      !assessmentKeys || !sameUniqueKeys(keys as string[], assessmentKeys) ||
      !attestation?.assessmentDigest ||
      attestation.assessmentDigest !== repositorySynthesisCriticAssessmentDigest(run.parsedOutput)
    ) {
      issues.push(`Limitation entailment critic ${run.id ?? "unknown"} lacks exact claim and assessment attestation.`);
    }
  }
  const requiredCounts = {
    semanticPlanning: input.generationRuns.filter((run) =>
      run.kind === "execution_routing"
    ).length,
    semanticExtraction: input.generationRuns.filter((run) =>
      run.kind === "semantic_extraction"
    ).length,
    capabilitySynthesis: synthesisRuns.length,
    entailmentCritic: criticRuns.length,
    highlightSelection: highlightSelectionRuns.length,
    highlightTitleCritic: highlightCriticRuns.length,
  };
  if (!requiredCounts.semanticPlanning && !agenticInvestigation) {
    issues.push("No audited semantic planning generation ran.");
  }
  if (!requiredCounts.semanticExtraction) {
    issues.push("No audited semantic extraction generation ran.");
  }
  if (!requiredCounts.capabilitySynthesis) {
    issues.push("No audited capability synthesis generation ran.");
  }

  const missingPhaseAttestation = capabilitySynthesisRuns.length -
    synthesisRuns.length - criticRuns.length - operationCommunityMappingRuns.length -
    highlightSelectionRuns.length - highlightCriticRuns.length - limitationCriticRuns.length;
  if (missingPhaseAttestation) {
    issues.push(
      `${missingPhaseAttestation} capability synthesis generation(s) have no valid synthesis-phase attestation.`,
    );
  }
  const missingBatchAttestation = capabilitySynthesisRuns.filter((run) => {
    const phase = repositorySynthesisGenerationPhase(run.inputSummary);
    if (phase === null) return false;
    return phase === "operation_community_mapping"
      ? repositoryOperationCommunityMappingDescriptor(run.inputSummary)
          ?.batchKey === undefined
      : phase === "repository_highlight_selection" ||
          phase === "repository_highlight_critic" || phase === "limitation_entailment_critic"
        ? false
      : repositorySynthesisBatchKey(run.inputSummary) === null;
  }).length;
  if (missingBatchAttestation) {
    issues.push(
      `${missingBatchAttestation} capability synthesis generation(s) have no valid subsystem-batch attestation.`,
    );
  }

  const highlightSelections = highlightSelectionRuns.flatMap((run) => {
    const summary = record(run.inputSummary);
    const output = record(run.parsedOutput);
    const attestation = record(record(run.resultRefs)?.resultAttestation);
    const rawOutputHash = record(run.resultRefs)?.rawOutputHash;
    const refreshRunId = typeof summary?.refreshRunId === "string"
      ? summary.refreshRunId
      : "";
    const candidateCount = typeof summary?.candidateCount === "number"
      ? summary.candidateCount
      : -1;
    const candidateDigest = typeof summary?.candidateDigest === "string"
      ? summary.candidateDigest
      : "";
    const selectedIds = Array.isArray(output?.selections)
      ? output.selections.flatMap((value) => {
          const selection = record(value);
          return typeof selection?.candidateId === "string"
            ? [selection.candidateId]
            : [];
        })
      : [];
    const omittedIds = Array.isArray(output?.omissions)
      ? output.omissions.flatMap((value) => {
          const omission = record(value);
          return typeof omission?.candidateId === "string" &&
              typeof omission?.reason === "string"
            ? [omission.candidateId]
            : [];
        })
      : [];
    const allIds = [...selectedIds, ...omittedIds];
    const attestedSelectedIds = Array.isArray(attestation?.selectedCandidateIds)
      ? attestation.selectedCandidateIds
      : [];
    const hasDigestAttestation =
      typeof attestation?.selectedCandidateCount === "number" &&
      Number.isInteger(attestation.selectedCandidateCount) &&
      typeof attestation?.selectedCandidateDigest === "string";
    const selectedAttestationMatches = hasDigestAttestation
      ? attestation.selectedCandidateCount === selectedIds.length &&
        attestation.selectedCandidateDigest === digestCanonicalStrings(selectedIds)
      : legacySelectedCandidateAttestationMatches(
          selectedIds,
          attestedSelectedIds,
        );
    const valid = run.status === "success" &&
      Boolean(refreshRunId) &&
      candidateCount > 0 &&
      summary?.maximumSelections === candidateCount &&
      /^[a-f0-9]{64}$/u.test(candidateDigest) &&
      allIds.length === candidateCount &&
      new Set(allIds).size === candidateCount &&
      selectedAttestationMatches &&
      attestation?.candidateDigest === candidateDigest &&
      typeof rawOutputHash === "string" &&
      /^[a-f0-9]{64}$/u.test(rawOutputHash) &&
      attestation?.selectionDigest ===
        digestHighlightSelectionOutput(run.parsedOutput);
    return valid ? [{ refreshRunId, selectedIds }] : [];
  });
  if (highlightSelections.length !== highlightSelectionRuns.length) {
    issues.push(
      `${highlightSelectionRuns.length - highlightSelections.length} repository Highlight selection generation(s) lack an exact candidate partition and output attestation.`,
    );
  }
  const highlightCritics = highlightCriticRuns.flatMap((run) => {
    const summary = record(run.inputSummary);
    const output = record(run.parsedOutput);
    const attestation = record(record(run.resultRefs)?.resultAttestation);
    const rawOutputHash = record(run.resultRefs)?.rawOutputHash;
    const refreshRunId = typeof summary?.refreshRunId === "string"
      ? summary.refreshRunId
      : "";
    const claimCount = typeof summary?.claimCount === "number"
      ? summary.claimCount
      : -1;
    const assessmentIds = Array.isArray(output?.assessments)
      ? output.assessments.flatMap((value) => {
          const assessment = record(value);
          return typeof assessment?.candidateId === "string"
            ? [assessment.candidateId]
            : [];
        })
      : [];
    const criticInputDigest = typeof summary?.criticInputDigest === "string"
      ? summary.criticInputDigest
      : "";
    const valid = run.status === "success" &&
      Boolean(refreshRunId) &&
      Number.isInteger(summary?.batchIndex) &&
      claimCount > 0 &&
      assessmentIds.length === claimCount &&
      new Set(assessmentIds).size === claimCount &&
      /^[a-f0-9]{64}$/u.test(criticInputDigest) &&
      attestation?.criticInputDigest === criticInputDigest &&
      typeof rawOutputHash === "string" &&
      /^[a-f0-9]{64}$/u.test(rawOutputHash) &&
      attestation?.assessmentDigest ===
        digestHighlightCriticOutput(run.parsedOutput);
    return valid ? [{ refreshRunId, assessmentIds }] : [];
  });
  if (highlightCritics.length !== highlightCriticRuns.length) {
    issues.push(
      `${highlightCriticRuns.length - highlightCritics.length} repository Highlight title critic generation(s) lack exact batch and output attestation.`,
    );
  }
  for (const selection of highlightSelections) {
    const assessedIds = highlightCritics
      .filter((critic) => critic.refreshRunId === selection.refreshRunId)
      .flatMap((critic) => critic.assessmentIds);
    if (!sameUniqueKeys(selection.selectedIds, assessedIds)) {
      issues.push(
        "Repository Highlight selections do not have exactly one independently attested title assessment each.",
      );
    }
  }
  if (highlightCritics.some((critic) => !highlightSelections.some((selection) =>
    selection.refreshRunId === critic.refreshRunId
  ))) {
    issues.push("A repository Highlight title critic has no matching selection generation.");
  }
  const invalidOperationCommunityPartitions = operationCommunityMappingRuns
    .filter((run) => {
      const descriptor = repositoryOperationCommunityMappingDescriptor(
        run.inputSummary,
      );
      return descriptor !== null &&
        !repositoryOperationCommunityMappingIsExactPartition(
          run.parsedOutput,
          descriptor,
        );
    });
  if (invalidOperationCommunityPartitions.length) {
    issues.push(
      `${invalidOperationCommunityPartitions.length} operation-community mapping generation(s) do not contain an exact notebook partition.`,
    );
  }
  const unattestedOperationCommunityMappings = operationCommunityMappingRuns
    .filter((run) => {
      const computedDigest = repositoryOperationCommunityMappingDigest(
        run.parsedOutput,
      );
      return computedDigest === null ||
        attestedRepositoryOperationCommunityMappingDigest(run.resultRefs) !==
          computedDigest;
    });
  if (unattestedOperationCommunityMappings.length) {
    issues.push(
      `${unattestedOperationCommunityMappings.length} operation-community mapping generation(s) do not attest their exact mapping payload.`,
    );
  }

  const expectedOperationCommunities = operationCommunityMappingRuns.flatMap(
    attestedRepositoryOperationCommunities,
  );
  const expectedOperationCommunityCounts = new Map<string, number>();
  for (const community of expectedOperationCommunities) {
    const key = repositoryOperationCommunityConsumptionKey(community);
    expectedOperationCommunityCounts.set(
      key,
      (expectedOperationCommunityCounts.get(key) ?? 0) + 1,
    );
  }

  let invalidOperationCommunityConsumptionCount = 0;
  let orphanOperationCommunityConsumptionCount = 0;
  const matchedOperationCommunityConsumptions: Array<{
    key: string;
    childKey: string;
  }> = [];
  for (const run of synthesisRuns) {
    if (repositorySynthesisRevisionRound(run.inputSummary) !== 0) continue;
    const parsed = repositorySynthesisOperationCommunityConsumptions(
      run.inputSummary,
    );
    invalidOperationCommunityConsumptionCount += parsed.invalidRecordCount;
    const summary = record(run.inputSummary);
    const refreshRunId = typeof summary?.refreshRunId === "string"
      ? summary.refreshRunId.trim()
      : "";
    const batchSubsystemKeys = repositorySynthesisInputSubsystemKeys(
      run.inputSummary,
    );
    for (const consumption of parsed.records) {
      if (
        run.status !== "success" ||
        !refreshRunId ||
        !batchSubsystemKeys?.includes(consumption.childSynthesisKey)
      ) {
        invalidOperationCommunityConsumptionCount += 1;
        continue;
      }
      const key = repositoryOperationCommunityConsumptionKey({
        refreshRunId,
        ...consumption,
      });
      if (!expectedOperationCommunityCounts.has(key)) {
        orphanOperationCommunityConsumptionCount += 1;
        continue;
      }
      matchedOperationCommunityConsumptions.push({
        key,
        childKey: JSON.stringify([
          refreshRunId,
          consumption.childSynthesisKey,
        ]),
      });
    }
  }
  if (invalidOperationCommunityConsumptionCount) {
    issues.push(
      `${invalidOperationCommunityConsumptionCount} operation-community consumption record(s) have invalid shape or reference a child outside their synthesis batch.`,
    );
  }
  if (orphanOperationCommunityConsumptionCount) {
    issues.push(
      `${orphanOperationCommunityConsumptionCount} operation-community consumption record(s) do not match a valid attested mapper community.`,
    );
  }

  const consumedOperationCommunityCounts = new Map<string, number>();
  const consumedOperationCommunityChildren = new Set<string>();
  let duplicateOperationCommunityConsumptionCount = 0;
  for (const consumption of matchedOperationCommunityConsumptions) {
    const consumedCount = consumedOperationCommunityCounts.get(
      consumption.key,
    ) ?? 0;
    if (
      consumedOperationCommunityChildren.has(consumption.childKey) ||
      consumedCount >=
        (expectedOperationCommunityCounts.get(consumption.key) ?? 0)
    ) {
      duplicateOperationCommunityConsumptionCount += 1;
      continue;
    }
    consumedOperationCommunityChildren.add(consumption.childKey);
    consumedOperationCommunityCounts.set(consumption.key, consumedCount + 1);
  }
  if (duplicateOperationCommunityConsumptionCount) {
    issues.push(
      `${duplicateOperationCommunityConsumptionCount} operation-community consumption record(s) duplicate a mapper community or child synthesis key.`,
    );
  }

  let missingOperationCommunityConsumptionCount = 0;
  for (const [key, expectedCount] of expectedOperationCommunityCounts) {
    missingOperationCommunityConsumptionCount += Math.max(
      0,
      expectedCount - (consumedOperationCommunityCounts.get(key) ?? 0),
    );
  }
  if (missingOperationCommunityConsumptionCount) {
    issues.push(
      `${missingOperationCommunityConsumptionCount} valid attested mapper community/communities are not consumed by initial synthesis.`,
    );
  }

  const synthesisBatchKeys = synthesisRuns.flatMap((run) => {
    const batchKey = repositorySynthesisBatchKey(run.inputSummary);
    return batchKey ? [batchKey] : [];
  });
  const duplicateSynthesisBatchCount = synthesisBatchKeys.length -
    new Set(synthesisBatchKeys).size;
  if (duplicateSynthesisBatchCount) {
    issues.push(
      `${duplicateSynthesisBatchCount} synthesis generation(s) duplicate an existing subsystem-batch revision.`,
    );
  }
  const invalidBaseRevisionMetadata = synthesisRuns.filter((run) => {
    if (repositorySynthesisRevisionRound(run.inputSummary) !== 0) return false;
    const summary = record(run.inputSummary);
    const attestation = record(record(run.resultRefs)?.resultAttestation);
    return Object.hasOwn(summary ?? {}, "revisionContract") ||
      attestation?.criticScope === "changed_claims" ||
      Object.hasOwn(record(run.parsedOutput) ?? {}, "revisionPatch");
  }).length;
  if (invalidBaseRevisionMetadata) {
    issues.push(
      `${invalidBaseRevisionMetadata} initial synthesis generation(s) declare revision-only metadata.`,
    );
  }
  const synthesisWithoutClaimAttestation = synthesisRuns.filter((run) => {
    const claimCount = repositorySynthesisClaimCount(run.parsedOutput);
    const computedClaimContentDigest =
      computedRepositorySynthesisClaimContentDigest(run.parsedOutput);
    const attestedClaimContentDigest =
      attestedRepositorySynthesisClaimContentDigest(run.resultRefs);
    const resultAttestation = record(record(run.resultRefs)?.resultAttestation);
    const revisionRound = repositorySynthesisRevisionRound(run.inputSummary);
    const requiresDeltaCritic = revisionRound !== null && revisionRound > 0;
    const inputSubsystemKeys = repositorySynthesisInputSubsystemKeys(
      run.inputSummary,
    );
    const outputSubsystemKeys = repositorySynthesisOutputSubsystemKeys(
      run.parsedOutput,
    );
    return claimCount === null ||
      repositorySynthesisClaimKeys(run.parsedOutput) === null ||
      inputSubsystemKeys === null ||
      outputSubsystemKeys === null ||
      !sameUniqueKeys(inputSubsystemKeys, outputSubsystemKeys) ||
      computedClaimContentDigest === null ||
      attestedClaimContentDigest !== computedClaimContentDigest ||
      (
        (requiresDeltaCritic || resultAttestation?.criticScope === "changed_claims") &&
        repositorySynthesisDeltaCriticAttestation(
          run.resultRefs,
          run.parsedOutput,
        ) === null
      );
  });
  if (synthesisWithoutClaimAttestation.length) {
    issues.push(
      `${synthesisWithoutClaimAttestation.length} synthesis generation(s) do not attest their emitted claim count.`,
    );
  }

  type DeltaCriticAttestation = NonNullable<
    ReturnType<typeof repositorySynthesisDeltaCriticAttestation>
  >;
  const priorSynthesisForDelta = (
    run: RepositoryKnowledgeGenerationAuditRecord,
    deltaCritic: DeltaCriticAttestation,
  ) => {
    const priorBatchKey = repositorySynthesisPriorBatchKey(run.inputSummary);
    if (priorBatchKey === null) return null;
    const matches = synthesisRuns.filter((prior) =>
        prior.status === "success" &&
        repositorySynthesisBatchKey(prior.inputSummary) === priorBatchKey &&
        attestedRepositorySynthesisClaimContentDigest(prior.resultRefs) ===
          deltaCritic.priorClaimContentDigest
    );
    return matches.length === 1 ? matches[0]! : null;
  };

  const criticDescriptorForSynthesis = (
    run: RepositoryKnowledgeGenerationAuditRecord,
  ) => {
    const claimCount = repositorySynthesisClaimCount(run.parsedOutput);
    const claimKeys = repositorySynthesisClaimKeys(run.parsedOutput);
    const claimContentDigest =
      attestedRepositorySynthesisClaimContentDigest(run.resultRefs);
    const resultAttestation = record(record(run.resultRefs)?.resultAttestation);
    const revisionRound = repositorySynthesisRevisionRound(run.inputSummary);
    const deltaCritic = repositorySynthesisDeltaCriticAttestation(
      run.resultRefs,
      run.parsedOutput,
    );
    if (
      claimCount === null ||
      !claimKeys ||
      !claimContentDigest ||
      revisionRound === null ||
      (revisionRound === 0 && deltaCritic !== null) ||
      (revisionRound > 0 && !deltaCritic) ||
      (resultAttestation?.criticScope === "changed_claims" && !deltaCritic)
    ) {
      return null;
    }
    return deltaCritic
      ? {
          claimCount: deltaCritic.claimCount,
          claimKeys: deltaCritic.claimKeys,
          claimContentDigest: deltaCritic.claimContentDigest,
          criticScope: "changed_claims" as const,
        }
      : {
          claimCount,
          claimKeys,
          claimContentDigest,
          criticScope: "full_payload" as const,
        };
  };

  const matchingCriticForSynthesis = (
    run: RepositoryKnowledgeGenerationAuditRecord,
  ) => {
    const descriptor = criticDescriptorForSynthesis(run);
    const batchKey = repositorySynthesisBatchKey(run.inputSummary);
    if (!descriptor || !batchKey || descriptor.claimCount === 0) return null;
    const matches = criticRuns.filter((critic) => {
      const criticScope = record(critic.inputSummary)?.criticScope;
      const scopeMatches = descriptor.criticScope === "changed_claims"
        ? criticScope === "changed_claims"
        : criticScope === undefined || criticScope === "full_payload";
      const assessments = repositoryCriticAssessments(critic.parsedOutput);
      return critic.status === "success" &&
        scopeMatches &&
        repositorySynthesisBatchKey(critic.inputSummary) === batchKey &&
        record(critic.inputSummary)?.claimCount === descriptor.claimCount &&
        record(critic.inputSummary)?.claimContentDigest ===
          descriptor.claimContentDigest &&
        assessments !== null &&
        sameUniqueKeys(
          descriptor.claimKeys,
          assessments.map((assessment) => assessment.claimKey),
        );
    });
    return matches.length === 1 ? matches[0]! : null;
  };

  const criticKeyRemapForSynthesis = (
    run: RepositoryKnowledgeGenerationAuditRecord,
  ) => {
    const claimKeys = repositorySynthesisClaimKeys(run.parsedOutput);
    if (!claimKeys) return null;
    const deltaCritic = repositorySynthesisDeltaCriticAttestation(
      run.resultRefs,
      run.parsedOutput,
    );
    if (!deltaCritic) {
      return new Map(claimKeys.map((claimKey) => [claimKey, claimKey]));
    }
    const source = priorSynthesisForDelta(run, deltaCritic);
    const sourceClaims = source
      ? repositorySynthesisAuditClaimPayload(source.parsedOutput)
      : null;
    const applied = sourceClaims
      ? applyRepositorySynthesisRevisionPatch(
          sourceClaims,
          deltaCritic.revisionPatch,
        )
      : null;
    const currentClaims = repositorySynthesisAuditClaimPayload(
      run.parsedOutput,
    );
    const revisionContract = String(
      record(run.inputSummary)?.revisionContract ?? "",
    );
    const currentDigest = computedRepositorySynthesisClaimContentDigest(
      run.parsedOutput,
    );
    const serverSlotContract =
      revisionContract === "rejected_claim_patch_v3_server_slots" ||
      revisionContract === "empty_fact_floor_patch_v1_server_slots" ||
      revisionContract === "quality_critical_fact_patch_v1_server_slots";
    return applied &&
        currentClaims &&
        currentDigest &&
        currentDigest ===
          attestedRepositorySynthesisClaimContentDigest(run.resultRefs) &&
        repositorySynthesisAuditClaimPayloadDigest(applied.claims) ===
          currentDigest &&
        (
          !serverSlotContract ||
          (
            repositorySynthesisAuditClaimsHaveCompleteServerShape(
              sourceClaims!,
            ) &&
            repositorySynthesisAuditClaimsHaveCompleteServerShape(
              currentClaims,
            ) &&
            repositorySynthesisAuditClaimsExactlyEqual(
              applied.claims,
              currentClaims,
            )
          )
        )
      ? applied.keyRemap
      : null;
  };

  const deltaValidation = new Map<
    RepositoryKnowledgeGenerationAuditRecord,
    boolean
  >();
  const deltaRevisionIsValid = (
    run: RepositoryKnowledgeGenerationAuditRecord,
    deltaCritic: DeltaCriticAttestation,
    visiting = new Set<RepositoryKnowledgeGenerationAuditRecord>(),
  ): boolean => {
    const cached = deltaValidation.get(run);
    if (cached !== undefined) return cached;
    if (visiting.has(run)) return false;
    visiting.add(run);
    const valid = (() => {
      const revisionContract = String(
        record(run.inputSummary)?.revisionContract ?? "",
      );
      if (![
        "rejected_claim_patch_v2_delta_critic",
        "rejected_claim_patch_v3_server_slots",
        "empty_fact_floor_patch_v1_server_slots",
        "quality_critical_fact_patch_v1_server_slots",
      ].includes(revisionContract)) {
        return false;
      }
      const prior = priorSynthesisForDelta(run, deltaCritic);
      if (!prior) return false;
      const priorDelta = repositorySynthesisDeltaCriticAttestation(
        prior.resultRefs,
        prior.parsedOutput,
      );
      if (priorDelta && !deltaRevisionIsValid(prior, priorDelta, visiting)) {
        return false;
      }
      const priorClaims = repositorySynthesisAuditClaimPayload(
        prior.parsedOutput,
      );
      if (!priorClaims) return false;
      const currentClaims = repositorySynthesisAuditClaimPayload(
        run.parsedOutput,
      );
      if (!currentClaims) return false;
      const serverSlots =
        revisionContract === "rejected_claim_patch_v3_server_slots" ||
        revisionContract === "empty_fact_floor_patch_v1_server_slots" ||
        revisionContract === "quality_critical_fact_patch_v1_server_slots";
      const allowedCitationIndexesBySubsystem = serverSlots
        ? repositorySynthesisRevisionEvidenceIndexesBySubsystem(
            record(run.inputSummary)?.revisionEvidenceIndexesBySubsystem,
          )
        : null;
      if (
        serverSlots &&
        (
          !repositorySynthesisAuditClaimsHaveCompleteServerShape(priorClaims) ||
          !repositorySynthesisAuditClaimsHaveCompleteServerShape(currentClaims) ||
          !allowedCitationIndexesBySubsystem
        )
      ) return false;
      const applied = applyRepositorySynthesisRevisionPatch(
        priorClaims,
        deltaCritic.revisionPatch,
      );
      const priorPayloadDigest = computedRepositorySynthesisClaimContentDigest(
        prior.parsedOutput,
      );
      const currentDigest = computedRepositorySynthesisClaimContentDigest(
        run.parsedOutput,
      );
      if (
        !applied ||
        priorPayloadDigest !== deltaCritic.priorClaimContentDigest ||
        !currentDigest ||
        currentDigest !==
          attestedRepositorySynthesisClaimContentDigest(run.resultRefs) ||
        repositorySynthesisAuditClaimPayloadDigest(applied.claims) !==
          currentDigest ||
        (
          serverSlots &&
          !repositorySynthesisAuditClaimsExactlyEqual(
            applied.claims,
            currentClaims,
          )
        )
      ) {
        return false;
      }

      const revisionCriticClaims = repositorySynthesisRevisionCriticClaims(
        deltaCritic.revisionPatch,
      );
      if (!revisionCriticClaims) return false;
      const revisionCriticClaimKeys = revisionCriticClaims.claims.map((claim) =>
        claim.claimKey as string
      );
      if (
        deltaCritic.claimCount !== revisionCriticClaims.claims.length ||
        !sameUniqueKeys(deltaCritic.claimKeys, revisionCriticClaimKeys) ||
        deltaCritic.claimContentDigest !==
          revisionCriticClaims.claimContentDigest
      ) {
        return false;
      }

      const priorCritic = matchingCriticForSynthesis(prior);
      const priorAssessments = priorCritic
        ? repositoryCriticAssessments(priorCritic.parsedOutput)
        : null;
      const criticKeyRemap = criticKeyRemapForSynthesis(prior);
      if (!priorAssessments || !criticKeyRemap) return false;
      const rejectedClaimKeys: string[] = [];
      const remappedPriorAssessments: typeof priorAssessments = [];
      for (const assessment of priorAssessments) {
        const claimKey = criticKeyRemap.get(assessment.claimKey);
        if (!claimKey) return false;
        remappedPriorAssessments.push({ ...assessment, claimKey });
        if (assessment.supported && assessment.issues.length === 0) continue;
        rejectedClaimKeys.push(claimKey);
      }
      const patchClaimKeys = [
        ...deltaCritic.revisionPatch.factRevisions,
        ...deltaCritic.revisionPatch.highlightRevisions,
      ].map((entry) => entry.claimKey);
      return revisionContract === "rejected_claim_patch_v2_delta_critic"
        ? sameUniqueKeys(patchClaimKeys, rejectedClaimKeys)
        : revisionContract === "empty_fact_floor_patch_v1_server_slots"
          ? repositorySynthesisFactFloorRevisionPatchIsAuthorized({
              priorClaims,
              patch: deltaCritic.revisionPatch,
              priorAssessments: remappedPriorAssessments,
              allowedCitationIndexesBySubsystem:
                allowedCitationIndexesBySubsystem!,
            })
        : revisionContract === "quality_critical_fact_patch_v1_server_slots"
          ? repositorySynthesisQualityCriticalFactRevisionPatchIsAuthorized({
              priorClaims,
              patch: deltaCritic.revisionPatch,
              priorAssessments: remappedPriorAssessments,
              allowedCitationIndexesBySubsystem:
                allowedCitationIndexesBySubsystem!,
            })
        : repositorySynthesisRevisionPatchIsAuthorized({
            priorClaims,
            patch: deltaCritic.revisionPatch,
            rejectedClaimKeys,
            priorAssessments: remappedPriorAssessments,
            allowedCitationIndexesBySubsystem:
              allowedCitationIndexesBySubsystem!,
          });
    })();
    visiting.delete(run);
    deltaValidation.set(run, valid);
    return valid;
  };

  const unchainedDeltaRevisions = synthesisRuns.filter((run) => {
    const revisionRound = repositorySynthesisRevisionRound(run.inputSummary);
    if (revisionRound === null || revisionRound === 0) return false;
    const deltaCritic =
      repositorySynthesisDeltaCriticAttestation(run.resultRefs, run.parsedOutput);
    return deltaCritic === null || !deltaRevisionIsValid(run, deltaCritic);
  });
  if (unchainedDeltaRevisions.length) {
    issues.push(
      `${unchainedDeltaRevisions.length} changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.`,
    );
  }
  const claimfulSynthesisRuns = synthesisRuns.flatMap((run) => {
    const emittedClaimCount = repositorySynthesisClaimCount(run.parsedOutput);
    const emittedClaimKeys = repositorySynthesisClaimKeys(run.parsedOutput);
    const batchKey = repositorySynthesisBatchKey(run.inputSummary);
    const emittedClaimContentDigest =
      attestedRepositorySynthesisClaimContentDigest(run.resultRefs);
    const deltaCritic = repositorySynthesisDeltaCriticAttestation(
      run.resultRefs,
      run.parsedOutput,
    );
    const revisionRound = repositorySynthesisRevisionRound(run.inputSummary);
    const claimCount = deltaCritic?.claimCount ?? emittedClaimCount;
    const claimKeys = deltaCritic?.claimKeys ?? emittedClaimKeys;
    const claimContentDigest = deltaCritic?.claimContentDigest ??
      emittedClaimContentDigest;
    const deltaChainCovered = revisionRound === 0
      ? deltaCritic === null
      : revisionRound !== null && deltaCritic !== null &&
        deltaRevisionIsValid(run, deltaCritic);
    return emittedClaimCount !== null &&
        emittedClaimCount > 0 &&
        emittedClaimKeys &&
        batchKey &&
        emittedClaimContentDigest &&
        claimCount !== null &&
        claimKeys &&
        (claimCount === 0 || claimContentDigest)
      ? [{
          run,
          claimCount,
          claimKeys,
          batchKey,
          claimContentDigest,
          deltaChainCovered,
          criticScope: deltaCritic ? "changed_claims" : "full_payload",
        }]
      : [];
  });
  const criticCoveredSynthesisRuns = claimfulSynthesisRuns.filter((synthesis) => {
    if (!synthesis.deltaChainCovered) return false;
    if (synthesis.claimCount === 0) return true;
    return criticRuns.some((critic) => {
      const criticScope = record(critic.inputSummary)?.criticScope;
      const scopeMatches = synthesis.criticScope === "changed_claims"
        ? criticScope === "changed_claims"
        : criticScope === undefined || criticScope === "full_payload";
      return critic.status === "success" &&
        scopeMatches &&
        repositorySynthesisBatchKey(critic.inputSummary) === synthesis.batchKey &&
        record(critic.inputSummary)?.claimCount === synthesis.claimCount &&
        record(critic.inputSummary)?.claimContentDigest === synthesis.claimContentDigest &&
        (() => {
          const criticKeys = repositoryCriticAssessmentKeys(critic.parsedOutput);
          return criticKeys !== null && sameUniqueKeys(synthesis.claimKeys, criticKeys);
        })();
    });
  });
  if (criticCoveredSynthesisRuns.length !== claimfulSynthesisRuns.length) {
    issues.push(
      `${claimfulSynthesisRuns.length - criticCoveredSynthesisRuns.length} claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.`,
    );
  }

  let schemaRepairRunCount = 0;
  let providerAttemptCount = 0;
  input.generationRuns.forEach((run, index) => {
    const label = `${run.kind} generation ${index + 1}`;
    const refs = record(run.resultRefs);
    const phase = repositorySynthesisGenerationPhase(run.inputSummary);
    const expected = agenticInvestigation && run.kind === "semantic_extraction"
      ? input.expectedAgenticInvestigatorIdentity
      : run.kind === "capability_synthesis" &&
        (phase === "entailment_critic" || phase === "repository_highlight_critic" || phase === "limitation_entailment_critic")
      ? input.expectedSynthesisCriticIdentity ?? expectedIdentityFor(run.kind, input.expectedIdentities)
      : expectedIdentityFor(run.kind, input.expectedIdentities);
    if (run.status !== "success") {
      issues.push(`${label} ended with status ${run.status}.`);
    }
    if (!expected) {
      issues.push(`${label} has no configured model identity to verify.`);
    } else {
      if (run.provider !== expected.provider) {
        issues.push(`${label} used provider ${run.provider}; expected ${expected.provider}.`);
      }
      if (run.modelId !== expected.modelId) {
        issues.push(`${label} used model ${run.modelId}; expected ${expected.modelId}.`);
      }
    }
    if (refs?.configuredModelId !== run.modelId) {
      issues.push(`${label} does not attest its configured model identity.`);
    }
    if (!requestIds(run.resultRefs).length) {
      issues.push(`${label} has no provider request ID.`);
    }
    if (refs?.usageComplete !== true || collectUnknownModelUsageAttempts(run.tokenUsage) > 0) {
      issues.push(`${label} has incomplete model-usage evidence.`);
    }
    if (Array.isArray(refs?.failedProviderAttempts) && refs.failedProviderAttempts.length) {
      const sameModelTransientRetries = expected &&
        refs.failedProviderAttempts.every((attempt) => {
          const value = record(attempt);
          return value?.provider === expected.provider &&
            value?.modelId === expected.modelId &&
            value?.status === "provider_error" &&
            value?.retryable === true &&
            typeof value?.requestId === "string" &&
            value.requestId.trim().length > 0;
        });
      if (!sameModelTransientRetries) {
        issues.push(`${label} records failed provider attempts outside the configured same-model transient retry path.`);
      }
    }
    if (refs?.admissionFailure === true) {
      issues.push(`${label} stopped before a provider dispatch.`);
    }
    if (refs?.transportMode === "text_repair_fallback") schemaRepairRunCount += 1;
    if (typeof refs?.providerAttemptCount === "number") {
      providerAttemptCount += Math.max(0, Math.floor(refs.providerAttemptCount));
    }
  });

  const deterministicSemanticPathCount = sumNumericProperty(
    input.coverage,
    "deterministicFallbackPathCount",
  );
  if (deterministicSemanticPathCount) {
    issues.push(
      `${deterministicSemanticPathCount} semantic path(s) used deterministic fallback analysis.`,
    );
  }
  const plannerFallbackAttested = typeof orchestration?.fallbackUsed === "boolean";
  const plannerFallbackUsed = orchestration?.fallbackUsed === true;
  const plannerGenerationRunId = typeof orchestration?.generationRunId === "string" &&
      orchestration.generationRunId.trim()
    ? orchestration.generationRunId.trim()
    : null;
  if (plannerFallbackUsed) {
    issues.push(agenticInvestigation
      ? "Repository investigation used a fallback path."
      : "Repository semantic planning used its deterministic fallback.");
  }
  if (!plannerFallbackAttested) {
    issues.push(agenticInvestigation
      ? "Repository investigation has no valid fallback attestation."
      : "Repository semantic planning has no valid fallback attestation.");
  }
  if (!agenticInvestigation) {
    if (!plannerGenerationRunId) {
      issues.push("Repository semantic planning has no audited generation reference.");
    } else if (!input.generationRuns.some((run) =>
      run.id === plannerGenerationRunId && run.kind === "execution_routing"
    )) {
      issues.push("Repository semantic planning does not reference its audited routing generation.");
    }
  } else {
    const repositories = Array.isArray(orchestration?.repositories)
      ? orchestration.repositories.flatMap((value) => {
          const repository = record(value);
          return repository ? [repository] : [];
        })
      : [];
    if (!repositories.length) {
      issues.push("Agentic repository investigation attests no repository results.");
    }
    for (const repository of repositories) {
      const label = typeof repository.repository === "string"
        ? repository.repository
        : "an investigated repository";
      issues.push(...repositoryVerifierTwoPhaseIntegrityIssues({
        repositoryAttestation: repository,
        generationRuns: input.generationRuns,
      }));
      const investigatorIds = Array.isArray(repository.investigatorGenerationRunIds)
        ? repository.investigatorGenerationRunIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : [];
      if (!investigatorIds.length) {
        issues.push(`${label} has no audited investigator generation reference.`);
      }
      for (const generationRunId of investigatorIds) {
        const matches = input.generationRuns.filter((run) =>
          run.id === generationRunId && run.kind === "semantic_extraction"
        );
        if (matches.length !== 1) {
          issues.push(`${label} does not resolve investigator generation ${generationRunId} exactly once.`);
          continue;
        }
        const run = matches[0]!;
        const parsed = record(run.parsedOutput);
        const attestation = record(record(run.resultRefs)?.resultAttestation);
        const terminationReason = attestation?.terminationReason;
        const validTermination = [
          "investigator_done",
          "investigator_checkpoint_yield",
          "agent_phase_budget_exhausted",
          "shared_budget_exhausted",
        ].includes(String(terminationReason));
        const terminalNotebook = terminationReason === "investigator_done";
        if (
          attestation?.executionMode !== "agentic_investigator" ||
          attestation?.fallbackUsed !== false ||
          !validTermination ||
          typeof attestation?.snapshotScopeDigest !== "string" ||
          typeof attestation?.notebookDigest !== "string" ||
          parsed?.notebookDigest !== attestation.notebookDigest ||
          parsed?.done !== terminalNotebook ||
          !Array.isArray(attestation?.toolTrace) ||
          attestation.toolTrace.length === 0 ||
          !Array.isArray(attestation?.readSet) ||
          attestation.readSet.length === 0
        ) {
          issues.push(`${label} investigator generation ${generationRunId} lacks a complete source-inspection attestation.`);
        }
        if (
          typeof repository.snapshotScopeDigest === "string" &&
          attestation?.snapshotScopeDigest !== repository.snapshotScopeDigest
        ) {
          issues.push(`${label} investigator generation ${generationRunId} is bound to a different snapshot scope.`);
        }
      }
      const finalInvestigator = investigatorIds.length
        ? input.generationRuns.find((run) =>
            run.id === investigatorIds[investigatorIds.length - 1] &&
            run.kind === "semantic_extraction"
          )
        : null;
      const finalInvestigatorParsed = record(finalInvestigator?.parsedOutput);
      const finalInvestigatorAttestation = record(
        record(finalInvestigator?.resultRefs)?.resultAttestation,
      );
      if (
        !sha256Digest(repository.notebookDigest) ||
        finalInvestigatorAttestation?.terminationReason !== "investigator_done" ||
        finalInvestigatorParsed?.done !== true ||
        finalInvestigatorParsed?.notebookDigest !== repository.notebookDigest ||
        finalInvestigatorAttestation?.notebookDigest !== repository.notebookDigest
      ) {
        issues.push(`${label} has no terminal investigator generation matching its final notebook.`);
      }
      const verifierGenerationRunId = typeof repository.verifierGenerationRunId === "string"
        ? repository.verifierGenerationRunId
        : null;
      const verifier = verifierGenerationRunId
        ? input.generationRuns.find((run) =>
            run.id === verifierGenerationRunId && run.kind === "coverage_audit"
          )
        : null;
      const verifierAttestation = record(record(verifier?.resultRefs)?.resultAttestation);
      const verifierInputNotebookDigest = sha256Digest(repository.verifierInputNotebookDigest)
        ? repository.verifierInputNotebookDigest
        : null;
      const verifierTerminationReason = verifierAttestation?.terminationReason;
      const validVerifierTermination = verifierTerminationReason === "verifier_complete" ||
        verifierTerminationReason === "verifier_phase_budget_exhausted" ||
        verifierTerminationReason === "shared_budget_exhausted";
      if (
        !verifier ||
        !verifierInputNotebookDigest ||
        verifierInputNotebookDigest !== repository.notebookDigest ||
        verifierAttestation?.executionMode !== "agentic_investigator_verifier" ||
        verifierAttestation?.fallbackUsed !== false ||
        !validVerifierTermination ||
        !sha256Digest(repository.snapshotScopeDigest) ||
        verifierAttestation?.snapshotScopeDigest !== repository.snapshotScopeDigest ||
        verifierAttestation?.notebookDigest !== verifierInputNotebookDigest ||
        !sha256Digest(repository.verifierDigest) ||
        verifierAttestation.auditDigest !== repository.verifierDigest ||
        !completeCandidateVerifierTrace(verifierAttestation?.toolTrace) ||
        !completeExactSourceReadSet(verifierAttestation?.readSet) ||
        !verifierTraceCoversReadSet(
          verifierAttestation?.toolTrace,
          verifierAttestation?.readSet,
        )
      ) {
        issues.push(`${label} has no matching independently audited coverage generation.`);
      }
      if (validVerifierTermination && verifierTerminationReason !== "verifier_complete") {
        issues.push(`${label} coverage verification ended at ${verifierTerminationReason}.`);
      }
    }
  }
  const warningText = strings(input.warnings).join("\n");
  const deterministicSynthesis = /used deterministic subsystem synthesis|finalized deterministically/iu
    .test(warningText);
  const budgetExhausted = /(?:model-call|token|synthesis) budget (?:was )?exhausted|budget_exhausted/iu
    .test(warningText);
  if (deterministicSynthesis) {
    issues.push("At least one subsystem used deterministic synthesis.");
  }
  if (budgetExhausted) {
    issues.push("Repository generation exhausted a model budget.");
  }

  return {
    passed: issues.length === 0,
    issues,
    metrics: {
      ...requiredCounts,
      claimfulSynthesis: claimfulSynthesisRuns.length,
      criticCoveredSynthesis: criticCoveredSynthesisRuns.length,
      successfulGenerations: input.generationRuns.filter((run) => run.status === "success").length,
      totalGenerations: input.generationRuns.length,
      providerAttemptCount,
      schemaRepairRunCount,
      deterministicSemanticPathCount,
      ...(agenticInvestigation ? { agenticInvestigation: true } : {}),
      plannerFallbackAttested,
      plannerFallbackUsed,
      deterministicSynthesis,
      budgetExhausted,
    },
  };
}
