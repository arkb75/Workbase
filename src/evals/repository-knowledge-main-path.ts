import {
  repositorySynthesisClaimContentDigest as computedRepositorySynthesisClaimContentDigest,
  repositorySynthesisCriticClaimContentDigest,
} from "@/src/domain/repository-synthesis-attestation";
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

function requestIds(resultRefs: unknown) {
  const refs = record(resultRefs);
  return Array.isArray(refs?.requestIds)
    ? refs.requestIds.filter((value): value is string =>
        typeof value === "string" && Boolean(value.trim())
      )
    : [];
}

type RepositorySynthesisGenerationPhase = "synthesis" | "entailment_critic";

function repositorySynthesisGenerationPhase(
  inputSummary: unknown,
): RepositorySynthesisGenerationPhase | null {
  const phase = record(inputSummary)?.phase;
  return phase === "synthesis" || phase === "entailment_critic"
    ? phase
    : null;
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

type RepositorySynthesisAuditClaim = {
  claimKey: string;
  kind: "fact" | "highlight";
  claim: Record<string, unknown>;
  citationIndexes: number[];
};

function repositorySynthesisAuditClaimPayload(value: unknown) {
  const subsystems = record(value)?.subsystems;
  if (!Array.isArray(subsystems)) return null;
  const claims: RepositorySynthesisAuditClaim[] = [];
  for (const candidate of subsystems) {
    const subsystem = record(candidate);
    const subsystemKey = typeof subsystem?.subsystemKey === "string"
      ? subsystem.subsystemKey.trim()
      : "";
    if (
      !subsystemKey ||
      !Array.isArray(subsystem?.facts) ||
      !Array.isArray(subsystem.highlights)
    ) {
      return null;
    }
    for (const [index, candidateFact] of subsystem.facts.entries()) {
      const fact = record(candidateFact);
      if (!fact || !Array.isArray(fact.citationIndexes)) return null;
      claims.push({
        claimKey: `${subsystemKey}:fact:${index + 1}`,
        kind: "fact",
        claim: { statement: fact.statement },
        citationIndexes: fact.citationIndexes as number[],
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
              claim: { statement: replacement.statement },
              citationIndexes: replacement.citationIndexes as number[],
            }
          : {
              claimKey: nextClaimKey,
              kind: "highlight" as const,
              claim: {
                text: replacement.text,
                summary: replacement.summary,
              },
              citationIndexes: replacement.citationIndexes as number[],
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
  coverage: unknown;
  orchestration: unknown;
  warnings: unknown;
}) {
  const issues: string[] = [];
  const capabilitySynthesisRuns = input.generationRuns.filter((run) =>
    run.kind === "capability_synthesis"
  );
  const synthesisRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) === "synthesis"
  );
  const criticRuns = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) === "entailment_critic"
  );
  const requiredCounts = {
    semanticPlanning: input.generationRuns.filter((run) =>
      run.kind === "execution_routing"
    ).length,
    semanticExtraction: input.generationRuns.filter((run) =>
      run.kind === "semantic_extraction"
    ).length,
    capabilitySynthesis: synthesisRuns.length,
    entailmentCritic: criticRuns.length,
  };
  if (!requiredCounts.semanticPlanning) {
    issues.push("No audited semantic planning generation ran.");
  }
  if (!requiredCounts.semanticExtraction) {
    issues.push("No audited semantic extraction generation ran.");
  }
  if (!requiredCounts.capabilitySynthesis) {
    issues.push("No audited capability synthesis generation ran.");
  }

  const missingPhaseAttestation = capabilitySynthesisRuns.length -
    synthesisRuns.length - criticRuns.length;
  if (missingPhaseAttestation) {
    issues.push(
      `${missingPhaseAttestation} capability synthesis generation(s) have no valid synthesis-phase attestation.`,
    );
  }
  const missingBatchAttestation = capabilitySynthesisRuns.filter((run) =>
    repositorySynthesisGenerationPhase(run.inputSummary) !== null &&
    repositorySynthesisBatchKey(run.inputSummary) === null
  ).length;
  if (missingBatchAttestation) {
    issues.push(
      `${missingBatchAttestation} capability synthesis generation(s) have no valid subsystem-batch attestation.`,
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
    const currentDigest = computedRepositorySynthesisClaimContentDigest(
      run.parsedOutput,
    );
    return applied &&
        currentDigest &&
        currentDigest ===
          attestedRepositorySynthesisClaimContentDigest(run.resultRefs) &&
        repositorySynthesisAuditClaimPayloadDigest(applied.claims) === currentDigest
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
      if (
        record(run.inputSummary)?.revisionContract !==
          "rejected_claim_patch_v2_delta_critic"
      ) {
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
      const applied = priorClaims
        ? applyRepositorySynthesisRevisionPatch(
            priorClaims,
            deltaCritic.revisionPatch,
          )
        : null;
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
          currentDigest
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
      for (const assessment of priorAssessments) {
        if (assessment.supported && assessment.issues.length === 0) continue;
        const claimKey = criticKeyRemap.get(assessment.claimKey);
        if (!claimKey) return false;
        rejectedClaimKeys.push(claimKey);
      }
      const patchClaimKeys = [
        ...deltaCritic.revisionPatch.factRevisions,
        ...deltaCritic.revisionPatch.highlightRevisions,
      ].map((entry) => entry.claimKey);
      return sameUniqueKeys(patchClaimKeys, rejectedClaimKeys);
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
    const expected = expectedIdentityFor(run.kind, input.expectedIdentities);
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
      issues.push(`${label} records failed provider attempts.`);
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
  const orchestration = record(input.orchestration);
  const plannerFallbackAttested = typeof orchestration?.fallbackUsed === "boolean";
  const plannerFallbackUsed = orchestration?.fallbackUsed === true;
  const plannerGenerationRunId = typeof orchestration?.generationRunId === "string" &&
      orchestration.generationRunId.trim()
    ? orchestration.generationRunId.trim()
    : null;
  if (plannerFallbackUsed) {
    issues.push("Repository semantic planning used its deterministic fallback.");
  }
  if (!plannerFallbackAttested) {
    issues.push("Repository semantic planning has no valid fallback attestation.");
  }
  if (!plannerGenerationRunId) {
    issues.push("Repository semantic planning has no audited generation reference.");
  } else if (!input.generationRuns.some((run) =>
    run.id === plannerGenerationRunId && run.kind === "execution_routing"
  )) {
    issues.push("Repository semantic planning does not reference its audited routing generation.");
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
      plannerFallbackAttested,
      plannerFallbackUsed,
      deterministicSynthesis,
      budgetExhausted,
    },
  };
}
