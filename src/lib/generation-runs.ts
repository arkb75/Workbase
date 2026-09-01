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

export type GenerationRunWriteInput = {
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
    | "answer_completeness_audit"
    | "project_chat_planning"
    | "project_chat_answer"
    | "project_chat_verification";
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

export class GenerationRunReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationRunReplayError";
  }
}

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
    (
      error.operationUsage
        ? error.operationUsage.providerAttemptCount === 0
        : error.usage.modelCalls === 0
    )
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
    if (error.operationUsage) {
      const operationTokenUsage = generationRunFailureTokenUsage({
        tokenUsage: error.operationUsage.tokenUsage,
        providerAttemptCount: error.operationUsage.providerAttemptCount,
        unknownUsageAttempts: error.operationUsage.unknownUsageAttempts,
      });
      return {
        ...record(operationTokenUsage),
        budgetCode: error.code,
      };
    }
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

function persistenceErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
}

/**
 * Loads the immutable successful result bound to a workflow idempotency key.
 * A malformed or conflicting row is an integrity failure: callers must not
 * spend on another provider request that could never become authoritative.
 */
export async function findSuccessfulGenerationRunReplay(input: {
  workItemId: string;
  idempotencyKey: string;
  kind: GenerationRunWriteInput["kind"];
}) {
  const run = await prisma.generationRun.findUnique({
    where: {
      workItemId_idempotencyKey: {
        workItemId: input.workItemId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });

  if (!run) return null;
  if (run.kind !== input.kind) {
    throw new GenerationRunReplayError(
      `Generation replay key ${input.idempotencyKey} is bound to ${run.kind}, not ${input.kind}.`,
    );
  }
  if (run.status !== "success") {
    throw new GenerationRunReplayError(
      `Generation replay key ${input.idempotencyKey} is not in a successful state.`,
    );
  }
  if (run.parsedOutput == null) {
    throw new GenerationRunReplayError(
      `Generation replay key ${input.idempotencyKey} has no parsed output.`,
    );
  }

  logGenerationEvent("workbase.generation_run.replayed", {
    generationRunId: run.id,
    workItemId: run.workItemId,
    kind: run.kind,
  });
  return run;
}

/**
 * Persists a successful provider result once. If a concurrent workflow retry
 * won the unique-key race, its already-persisted output is returned as the
 * authoritative result instead of creating a second lineage record.
 */
export async function createGenerationRunIdempotently(
  data: GenerationRunWriteInput & {
    idempotencyKey: string;
    status: "success";
  },
) {
  try {
    return await createGenerationRun(data);
  } catch (error) {
    if (persistenceErrorCode(error) !== "P2002") throw error;

    const winner = await findSuccessfulGenerationRunReplay({
      workItemId: data.workItemId,
      idempotencyKey: data.idempotencyKey,
      kind: data.kind,
    });
    if (winner) return winner;
    throw error;
  }
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
