import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";
import {
  collectModelTokenUsage,
  collectReportedModelCostUsd,
  collectUnknownModelUsageAttempts,
  countCostedModelProviderAttempts,
  countModelProviderAttempts,
  countModelUsageEntries,
  resolveModelCostUsd,
} from "@/src/services/model-usage-service";

type GenerationRunWriteInput = {
  workItemId: string;
  kind:
    | "claim_research"
    | "claim_cluster_research"
    | "claim_merge"
    | "claim_verification"
    | "highlight_generation"
    | "highlight_verification"
    | "artifact_retrieval"
    | "artifact_generation"
    | "evidence_clustering"
    | "execution_routing"
    | "semantic_extraction"
    | "semantic_repair"
    | "capability_synthesis"
    | "coverage_audit"
    | "answer_completeness_audit";
  status: "queued" | "running" | "success" | "provider_error" | "parse_error" | "validation_error";
  idempotencyKey?: string | null;
  provider: string;
  modelId: string;
  inputSummary: Prisma.InputJsonValue;
  rawOutput?: string | null;
  parsedOutput?: Prisma.InputJsonValue | null;
  validationErrors?: Prisma.InputJsonValue | null;
  resultRefs?: Prisma.InputJsonValue | null;
  tokenUsage?: Prisma.InputJsonValue | null;
  estimatedCostUsd?: number | null;
};

function logGenerationEvent(event: string, payload: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      event,
      ...payload,
    }),
  );
}

function rawOutputHash(value: string | null) {
  return value
    ? createHash("sha256").update(value).digest("hex")
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return null;
  }
}

function isModelProvider(provider: string) {
  return !["", "mock", "workbase", "deterministic"].includes(
    provider.trim().toLowerCase(),
  );
}

function generationRunMetering(data: GenerationRunWriteInput) {
  const finalStatus = data.status !== "queued" && data.status !== "running";
  const modelProvider = isModelProvider(data.provider);
  const admissionFailure = record(data.resultRefs).admissionFailure === true;
  const usageEntryCount = countModelUsageEntries(data.tokenUsage);
  const explicitUnknownUsageAttempts =
    collectUnknownModelUsageAttempts(data.tokenUsage);
  let providerAttemptCount = Math.max(
    countModelProviderAttempts(data.tokenUsage),
    explicitUnknownUsageAttempts,
  );
  let unknownUsageAttempts = explicitUnknownUsageAttempts;
  if (
    modelProvider &&
    finalStatus &&
    !admissionFailure &&
    providerAttemptCount === 0
  ) {
    providerAttemptCount = 1;
    unknownUsageAttempts = 1;
  } else if (
    modelProvider &&
    finalStatus &&
    usageEntryCount === 0 &&
    unknownUsageAttempts === 0
  ) {
    unknownUsageAttempts = providerAttemptCount;
  }
  const usage = collectModelTokenUsage(data.tokenUsage);
  const knownEstimatedCostUsd =
    data.estimatedCostUsd ??
    collectReportedModelCostUsd(data.tokenUsage) ??
    resolveModelCostUsd({
      provider: data.provider,
      modelId: data.modelId,
      usage,
      rawUsage: data.tokenUsage,
    });
  const usageComplete =
    unknownUsageAttempts === 0 &&
    (
      data.provider.toLowerCase() !== "openrouter" ||
      providerAttemptCount === 0 ||
      (
        knownEstimatedCostUsd != null &&
        countCostedModelProviderAttempts(data.tokenUsage) >=
          providerAttemptCount
      )
    );
  return {
    providerAttemptCount,
    unknownUsageAttempts,
    usageComplete,
    knownEstimatedCostUsd,
    estimatedCostUsd: usageComplete ? knownEstimatedCostUsd : null,
  };
}

/**
 * Retains only provider-attempt metering from errors that escape before the
 * structured-output client can wrap them. In particular, an OpenRouter 402 can
 * have no token usage while still representing one or more dispatched,
 * unmetered attempts. The resulting shape deliberately leaves those attempts
 * unknown instead of turning them into zero-token, zero-cost calls.
 */
export function generationRunFailureTokenUsage(
  error: unknown,
): Prisma.InputJsonValue | null {
  const candidate = record(error);
  const tokenUsage = jsonValue(candidate.tokenUsage);
  const failedAttempts = jsonValue(candidate.failedAttempts);
  const explicitProviderAttemptCount =
    typeof candidate.providerAttemptCount === "number" &&
    Number.isFinite(candidate.providerAttemptCount) &&
    candidate.providerAttemptCount >= 0
      ? Math.floor(candidate.providerAttemptCount)
      : null;
  const explicitUnknownUsageAttempts =
    typeof candidate.unknownUsageAttempts === "number" &&
    Number.isFinite(candidate.unknownUsageAttempts) &&
    candidate.unknownUsageAttempts >= 0
      ? Math.floor(candidate.unknownUsageAttempts)
      : null;
  if (
    tokenUsage == null &&
    failedAttempts == null &&
    explicitProviderAttemptCount == null &&
    explicitUnknownUsageAttempts == null
  ) {
    return null;
  }
  const providerAttemptCount = Math.max(
    explicitProviderAttemptCount ?? 0,
    countModelProviderAttempts(tokenUsage),
    explicitUnknownUsageAttempts ?? 0,
    1,
  );
  const unknownUsageAttempts =
    explicitUnknownUsageAttempts ??
    (
      tokenUsage == null
        ? providerAttemptCount
        : collectUnknownModelUsageAttempts(tokenUsage)
    );
  const requestId =
    typeof candidate.requestId === "string" && candidate.requestId.trim()
      ? candidate.requestId.trim()
      : null;
  return {
    attempts: tokenUsage == null ? [] : [tokenUsage],
    failedAttempts:
      Array.isArray(failedAttempts)
        ? failedAttempts
        : [],
    ...(requestId ? { requestIds: [requestId] } : {}),
    providerAttemptCount,
    unknownUsageAttempts,
  };
}

export async function createGenerationRun(
  data: GenerationRunWriteInput,
) {
  const metering = generationRunMetering(data);
  const suppliedResultRefs = record(data.resultRefs);
  const run = await prisma.generationRun.create({
    data: {
      ...data,
      rawOutput: data.rawOutput ?? null,
      parsedOutput:
        data.parsedOutput == null ? Prisma.JsonNull : data.parsedOutput,
      validationErrors:
        data.validationErrors == null ? Prisma.JsonNull : data.validationErrors,
      resultRefs: {
        ...suppliedResultRefs,
        auditAttemptCount: metering.providerAttemptCount,
        unknownUsageAttempts: metering.unknownUsageAttempts,
        usageComplete: metering.usageComplete,
        knownEstimatedCostUsd: metering.knownEstimatedCostUsd,
      },
      tokenUsage: data.tokenUsage == null ? Prisma.JsonNull : data.tokenUsage,
      estimatedCostUsd: metering.estimatedCostUsd,
    },
  });

  logGenerationEvent("workbase.generation_run.created", {
    generationRunId: run.id,
    workItemId: run.workItemId,
    kind: run.kind,
    status: run.status,
    provider: run.provider,
    modelId: run.modelId,
    rawOutputHash: rawOutputHash(run.rawOutput),
    rawOutputCharacters: run.rawOutput?.length ?? 0,
    hasParsedOutput: run.parsedOutput != null,
    hasValidationErrors: run.validationErrors != null,
    tokenUsage: run.tokenUsage,
    estimatedCostUsd: run.estimatedCostUsd,
  });

  return run;
}

export async function updateGenerationRunResultRefs(
  generationRunId: string,
  resultRefs: Prisma.InputJsonValue,
) {
  const currentRun = await prisma.generationRun.findUniqueOrThrow({
    where: {
      id: generationRunId,
    },
  });

  const mergedResultRefs =
    currentRun.resultRefs &&
    typeof currentRun.resultRefs === "object" &&
    !Array.isArray(currentRun.resultRefs) &&
    typeof resultRefs === "object" &&
    !Array.isArray(resultRefs)
      ? {
          ...currentRun.resultRefs,
          ...resultRefs,
        }
      : resultRefs;

  const run = await prisma.generationRun.update({
    where: {
      id: generationRunId,
    },
    data: {
      resultRefs: mergedResultRefs,
    },
  });

  logGenerationEvent("workbase.generation_run.updated", {
    generationRunId: run.id,
    resultRefKeys:
      run.resultRefs &&
      typeof run.resultRefs === "object" &&
      !Array.isArray(run.resultRefs)
        ? Object.keys(run.resultRefs).sort()
        : [],
  });

  return run;
}
