import { collectUnknownModelUsageAttempts } from "@/src/services/model-usage-service";

export const repositoryKnowledgeModelGenerationKinds = [
  "semantic_extraction",
  "semantic_repair",
  "capability_synthesis",
  "coverage_audit",
] as const;

type RepositoryKnowledgeModelGenerationKind =
  (typeof repositoryKnowledgeModelGenerationKinds)[number];

export interface RepositoryKnowledgeGenerationAuditRecord {
  kind: string;
  status: string;
  provider: string;
  modelId: string;
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
  warnings: unknown;
}) {
  const issues: string[] = [];
  const requiredCounts = {
    semanticExtraction: input.generationRuns.filter((run) =>
      run.kind === "semantic_extraction"
    ).length,
    capabilitySynthesis: input.generationRuns.filter((run) =>
      run.kind === "capability_synthesis"
    ).length,
  };
  if (!requiredCounts.semanticExtraction) {
    issues.push("No audited semantic extraction generation ran.");
  }
  if (!requiredCounts.capabilitySynthesis) {
    issues.push("No audited capability synthesis generation ran.");
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
      successfulGenerations: input.generationRuns.filter((run) => run.status === "success").length,
      totalGenerations: input.generationRuns.length,
      providerAttemptCount,
      schemaRepairRunCount,
      deterministicSemanticPathCount,
      deterministicSynthesis,
      budgetExhausted,
    },
  };
}
