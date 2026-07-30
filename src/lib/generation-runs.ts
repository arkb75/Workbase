import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { StructuredGenerationBudgetError } from "@/src/lib/bedrock-structured-llm-client";
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

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * A structured-generation budget error is an admission failure only when no
 * provider dispatch has occurred. The same error class is also used after a
 * charged response pushes the cumulative token total over its ceiling.
 */
export function isStructuredGenerationAdmissionFailure(error: unknown) {
  return (
    error instanceof StructuredGenerationBudgetError &&
    error.usage.modelCalls === 0
  );
}

function isModelProvider(provider: string) {
  return !["", "mock", "workbase", "deterministic"].includes(
    provider.trim().toLowerCase(),
  );
}

function generationRunMetering(data: GenerationRunWriteInput) {
  const finalStatus = data.status !== "queued" && data.status !== "running";
  const modelProvider = isModelProvider(data.provider);
  const usageEntryCount = countModelUsageEntries(data.tokenUsage);
  const explicitUnknownUsageAttempts =
    collectUnknownModelUsageAttempts(data.tokenUsage);
  let providerAttemptCount = Math.max(
    countModelProviderAttempts(data.tokenUsage),
    explicitUnknownUsageAttempts,
  );
  const admissionFailure =
    record(data.resultRefs).admissionFailure === true &&
    providerAttemptCount === 0 &&
    usageEntryCount === 0;
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
  if (error instanceof StructuredGenerationBudgetError) {
    if (isStructuredGenerationAdmissionFailure(error)) return null;
    const usage = error.usage;
    return {
      attempts: [{
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      }],
      failedAttempts: [],
      providerAttemptCount: usage.modelCalls,
      unknownUsageAttempts: usage.unknownUsageCalls,
      budgetCode: error.code,
    };
  }

  const candidate = record(error);
  const tokenUsage = jsonValue(candidate.tokenUsage);
  const tokenUsageRecord = record(tokenUsage);
  const tokenUsageIsAggregate =
    ![
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
    ].some((key) => typeof tokenUsageRecord[key] === "number") &&
    (
      Array.isArray(tokenUsageRecord.attempts) ||
      Array.isArray(tokenUsageRecord.failedAttempts)
    );
  const attempts = tokenUsageIsAggregate
    ? Array.isArray(tokenUsageRecord.attempts)
      ? tokenUsageRecord.attempts
          .map((attempt) => jsonValue(attempt))
          .filter((attempt): attempt is Prisma.InputJsonValue => attempt != null)
      : []
    : tokenUsage == null
      ? []
      : [tokenUsage];
  const failedAttempts = [
    ...(tokenUsageIsAggregate && Array.isArray(tokenUsageRecord.failedAttempts)
      ? tokenUsageRecord.failedAttempts
      : []),
    ...(Array.isArray(candidate.failedAttempts)
      ? candidate.failedAttempts
      : []),
  ]
    .map((attempt) => jsonValue(attempt))
    .filter((attempt): attempt is Prisma.InputJsonValue => attempt != null)
    .filter((attempt, index, all) => {
      const attemptRecord = record(attempt);
      const requestId =
        typeof attemptRecord.requestId === "string" &&
        attemptRecord.requestId.trim()
          ? attemptRecord.requestId.trim()
          : null;
      const identity = requestId
        ? `request:${requestId}`
        : `metadata:${JSON.stringify(attempt)}`;
      return all.findIndex((candidateAttempt) => {
        const candidateRecord = record(candidateAttempt);
        const candidateRequestId =
          typeof candidateRecord.requestId === "string" &&
          candidateRecord.requestId.trim()
            ? candidateRecord.requestId.trim()
            : null;
        return (
          candidateRequestId
            ? `request:${candidateRequestId}`
            : `metadata:${JSON.stringify(candidateAttempt)}`
        ) === identity;
      }) === index;
    });
  const explicitProviderAttemptCount =
    nonNegativeInteger(candidate.providerAttemptCount);
  const explicitUnknownUsageAttempts =
    nonNegativeInteger(candidate.unknownUsageAttempts);
  if (
    tokenUsage == null &&
    failedAttempts.length === 0 &&
    explicitProviderAttemptCount == null &&
    explicitUnknownUsageAttempts == null
  ) {
    return null;
  }
  const providerAttemptCount = Math.max(
    explicitProviderAttemptCount ?? 0,
    countModelProviderAttempts(tokenUsage),
    explicitUnknownUsageAttempts ?? 0,
    failedAttempts.length,
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
    attempts,
    failedAttempts,
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
