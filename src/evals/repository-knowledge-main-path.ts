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
  const assessments = record(parsedOutput)?.assessments;
  if (!Array.isArray(assessments)) return null;
  const keys = assessments.flatMap((assessment) => {
    const claimKey = record(assessment)?.claimKey;
    return typeof claimKey === "string" && claimKey.trim()
      ? [claimKey.trim()]
      : [];
  });
  return keys.length === assessments.length ? keys : null;
}

function repositorySynthesisClaimContentDigest(resultRefs: unknown) {
  const digest = record(record(resultRefs)?.resultAttestation)?.claimContentDigest;
  return typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)
    ? digest
    : null;
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
  const synthesisWithoutClaimAttestation = synthesisRuns.filter((run) =>
    repositorySynthesisClaimCount(run.parsedOutput) === null ||
    repositorySynthesisClaimKeys(run.parsedOutput) === null ||
    (
      (repositorySynthesisClaimCount(run.parsedOutput) ?? 0) > 0 &&
      repositorySynthesisClaimContentDigest(run.resultRefs) === null
    )
  );
  if (synthesisWithoutClaimAttestation.length) {
    issues.push(
      `${synthesisWithoutClaimAttestation.length} synthesis generation(s) do not attest their emitted claim count.`,
    );
  }
  const claimfulSynthesisRuns = synthesisRuns.flatMap((run) => {
    const claimCount = repositorySynthesisClaimCount(run.parsedOutput);
    const claimKeys = repositorySynthesisClaimKeys(run.parsedOutput);
    const batchKey = repositorySynthesisBatchKey(run.inputSummary);
    const claimContentDigest = repositorySynthesisClaimContentDigest(run.resultRefs);
    return claimCount !== null && claimCount > 0 && claimKeys && batchKey && claimContentDigest
      ? [{ run, claimCount, claimKeys, batchKey, claimContentDigest }]
      : [];
  });
  const criticCoveredSynthesisRuns = claimfulSynthesisRuns.filter((synthesis) =>
    criticRuns.some((critic) =>
      critic.status === "success" &&
      repositorySynthesisBatchKey(critic.inputSummary) === synthesis.batchKey &&
      record(critic.inputSummary)?.claimCount === synthesis.claimCount &&
      record(critic.inputSummary)?.claimContentDigest === synthesis.claimContentDigest &&
      (() => {
        const criticKeys = repositoryCriticAssessmentKeys(critic.parsedOutput);
        return criticKeys !== null && sameUniqueKeys(synthesis.claimKeys, criticKeys);
      })()
    )
  );
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
