import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import {
  StructuredGenerationBudgetError,
  StructuredOutputError,
} from "@/src/lib/bedrock-structured-llm-client";
import { sanitizeBedrockConverseEventValue } from "@/src/lib/bedrock-converse-agent";
import {
  generationRunFailureTokenUsage,
  isStructuredGenerationAdmissionFailure,
} from "@/src/lib/generation-runs";
import {
  resolveActiveTextModelIdentity,
  type TextModelProfile,
} from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import {
  addModelTokenUsage,
  collectModelTokenUsage,
  collectReportedModelCostUsd,
  collectUnknownModelUsageAttempts,
  countCostedModelProviderAttempts,
  countModelUsageEntries,
  countModelProviderAttempts,
  resolveModelCostUsd,
} from "@/src/services/model-usage-service";

type AuditedGenerationKind =
  | "execution_routing"
  | "semantic_extraction"
  | "semantic_repair"
  | "highlight_verification"
  | "artifact_generation"
  | "capability_synthesis"
  | "coverage_audit"
  | "answer_completeness_audit";

type StructuredResult = {
  data: unknown;
  rawOutput: string;
  parsedOutput: JsonValue;
  tokenUsage: JsonValue | null;
  provider: string;
  priorEstimatedCostUsd?: number | null;
  modelId: string;
  transportMode: string;
  attempts: unknown;
  requestId?: string | null;
};

function json(value: unknown): Prisma.InputJsonValue {
  return sanitizeBedrockConverseEventValue(value) as Prisma.InputJsonValue;
}

function rawPreview(raw: string | null) {
  if (!raw) return null;
  const safe = sanitizeBedrockConverseEventValue(raw);
  return typeof safe === "string" ? safe.slice(0, 4_000) : JSON.stringify(safe).slice(0, 4_000);
}

function rawHash(raw: string | null) {
  return raw ? createHash("sha256").update(raw).digest("hex") : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function collectProviderAttemptMetadata(value: unknown) {
  const attempts: JsonValue[] = [];
  const requestIds = new Set<string>();
  const routedProviders = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (
      !current ||
      typeof current !== "object" ||
      depth > 6 ||
      seen.has(current)
    ) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.failedAttempts)) {
      for (const attempt of record.failedAttempts) {
        const sanitized = sanitizeAuditedUsageEvidence(attempt);
        if (
          sanitized &&
          typeof sanitized === "object" &&
          !Array.isArray(sanitized)
        ) {
          attempts.push(sanitized);
        }
        visit(attempt, depth + 1);
      }
    }
    if (
      typeof record.routedProvider === "string" &&
      record.routedProvider.trim()
    ) {
      routedProviders.add(record.routedProvider.trim());
    }
    if (Array.isArray(record.routedProviders)) {
      record.routedProviders.forEach((provider) => {
        if (typeof provider === "string" && provider.trim()) {
          routedProviders.add(provider.trim());
        }
      });
    }
    if (typeof record.requestId === "string" && record.requestId.trim()) {
      requestIds.add(record.requestId.trim());
    }
    if (Array.isArray(record.requestIds)) {
      record.requestIds.forEach((requestId) => {
        if (typeof requestId === "string" && requestId.trim()) {
          requestIds.add(requestId.trim());
        }
      });
    }
    Object.entries(record).forEach(([key, entry]) => {
      if (key !== "failedAttempts") visit(entry, depth + 1);
    });
  };
  visit(value, 0);
  return {
    failedAttempts: attempts,
    requestIds: Array.from(requestIds),
    routedProviders: Array.from(routedProviders),
  };
}

const AUDITED_USAGE_EVIDENCE_VERSION = 1;
const auditedUsageNumberKeys = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
  "cost",
  "costUsd",
  "providerAttemptCount",
  "costedAttemptCount",
  "unknownUsageAttempts",
  "httpStatus",
]);
const auditedUsageStringKeys = new Set([
  "provider",
  "modelId",
  "requestId",
  "routedProvider",
  "status",
  "code",
  "errorType",
  "retryAfter",
]);
const auditedUsageBooleanKeys = new Set(["retryable"]);
const auditedUsageStringArrayKeys = new Set([
  "providers",
  "modelIds",
  "requestIds",
  "routedProviders",
]);
const auditedUsageContainerKeys = new Set([
  "attempts",
  "failedAttempts",
  "usage",
  "tokenUsage",
  "batches",
  "phases",
]);

/**
 * Retains only metering and provider-attempt identity. Provider token-usage
 * objects are trusted as accounting evidence, not as a channel for persisting
 * prompts, response content, or raw error messages.
 */
function sanitizeAuditedUsageEvidence(value: unknown): JsonValue | null {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): JsonValue | null => {
    if (
      !current ||
      typeof current !== "object" ||
      depth > 8 ||
      seen.has(current)
    ) {
      return null;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      return current.flatMap((entry) => {
        const sanitized = visit(entry, depth + 1);
        return sanitized == null ? [] : [sanitized];
      });
    }

    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (auditedUsageNumberKeys.has(key)) {
        if (
          typeof entry === "number" &&
          Number.isFinite(entry) &&
          entry >= 0
        ) {
          output[key] = entry;
        } else if (entry == null) {
          output[key] = null;
        }
        continue;
      }
      if (auditedUsageStringKeys.has(key)) {
        if (typeof entry === "string" && entry.trim()) {
          output[key] = entry.trim();
        } else if (
          key === "code" &&
          typeof entry === "number" &&
          Number.isFinite(entry)
        ) {
          output[key] = entry;
        } else if (entry == null) {
          output[key] = null;
        }
        continue;
      }
      if (auditedUsageBooleanKeys.has(key)) {
        if (typeof entry === "boolean") output[key] = entry;
        continue;
      }
      if (auditedUsageStringArrayKeys.has(key) && Array.isArray(entry)) {
        output[key] = entry.flatMap((candidate) =>
          typeof candidate === "string" && candidate.trim()
            ? [candidate.trim()]
            : []
        );
        continue;
      }
      if (auditedUsageContainerKeys.has(key)) {
        const nested = visit(entry, depth + 1);
        if (nested != null) output[key] = nested;
      }
    }
    if (!Object.keys(output).length) return null;
    return sanitizeBedrockConverseEventValue(output);
  };
  return visit(value, 0);
}

function priorAuditedUsageEntries(value: unknown) {
  const prior = objectValue(value);
  if (
    prior?.auditUsageEvidenceVersion === AUDITED_USAGE_EVIDENCE_VERSION &&
    Array.isArray(prior.attempts)
  ) {
    return prior.attempts.flatMap((entry) => {
      const sanitized = sanitizeAuditedUsageEvidence(entry);
      return sanitized == null ? [] : [sanitized];
    });
  }
  const sanitized = sanitizeAuditedUsageEvidence(value);
  return sanitized == null ? [] : [sanitized];
}

function cumulativeAuditedUsageEvidence(input: {
  priorTokenUsage: unknown;
  currentTokenUsage: unknown;
  providerAttemptCount: number;
  unknownUsageAttempts: number;
}) {
  const current = sanitizeAuditedUsageEvidence(input.currentTokenUsage);
  const attempts = [
    ...priorAuditedUsageEntries(input.priorTokenUsage),
    ...(current == null ? [] : [current]),
  ];
  if (!attempts.length) return null;
  return sanitizeBedrockConverseEventValue({
    auditUsageEvidenceVersion: AUDITED_USAGE_EVIDENCE_VERSION,
    attempts,
    providerAttemptCount: input.providerAttemptCount,
    unknownUsageAttempts: input.unknownUsageAttempts,
  });
}

function providerErrorUsage(error: unknown): JsonValue | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    failedAttempts?: unknown;
    unknownUsageAttempts?: unknown;
    providerAttemptCount?: unknown;
    tokenUsage?: unknown;
  };
  const providerAttemptCount = nonNegativeInteger(
    candidate.providerAttemptCount,
  );
  const unknownUsageAttempts = nonNegativeInteger(
    candidate.unknownUsageAttempts,
  );
  if (
    !Array.isArray(candidate.failedAttempts) &&
    providerAttemptCount == null &&
    unknownUsageAttempts == null
  ) {
    return null;
  }
  return sanitizeBedrockConverseEventValue({
    attempts: candidate.tokenUsage == null ? [] : [candidate.tokenUsage],
    failedAttempts: Array.isArray(candidate.failedAttempts)
      ? candidate.failedAttempts
      : [],
    providerAttemptCount: providerAttemptCount ?? 1,
    unknownUsageAttempts: unknownUsageAttempts ?? 1,
  });
}

function cumulativeAuditUsage(input: {
  priorTokenUsage: unknown;
  priorResultRefs: unknown;
  currentTokenUsage: unknown;
  modelId: string;
  provider: string;
  priorEstimatedCostUsd?: number | null;
  countCurrentAttempt?: boolean;
}) {
  const countCurrentAttempt = input.countCurrentAttempt ?? true;
  const priorRefs = objectValue(input.priorResultRefs);
  const priorHasKnownUsage = input.priorTokenUsage != null;
  const currentUsage = collectModelTokenUsage(input.currentTokenUsage);
  const currentExplicitUnknownUsage = collectUnknownModelUsageAttempts(input.currentTokenUsage);
  const currentHasPositiveUsage = currentUsage.totalTokens > 0 ||
    currentUsage.inputTokens > 0 ||
    currentUsage.outputTokens > 0 ||
    currentUsage.cacheReadInputTokens > 0 ||
    currentUsage.cacheWriteInputTokens > 0;
  const currentHasKnownUsage = input.currentTokenUsage != null &&
    (currentExplicitUnknownUsage === 0 || currentHasPositiveUsage);
  const priorAttemptCount = nonNegativeInteger(priorRefs?.auditAttemptCount) ??
    (input.priorResultRefs != null || priorHasKnownUsage ? 1 : 0);
  const priorUnknownUsageAttempts = nonNegativeInteger(priorRefs?.unknownUsageAttempts) ??
    (input.priorResultRefs != null && !priorHasKnownUsage && input.modelId !== "mock" ? 1 : 0);
  const unknownUsageAttempts = priorUnknownUsageAttempts + (countCurrentAttempt
    ? (currentExplicitUnknownUsage || (!currentHasKnownUsage && input.modelId !== "mock" ? 1 : 0))
    : 0);
  const usage = addModelTokenUsage(
    collectModelTokenUsage(input.priorTokenUsage),
    currentUsage,
  );
  const explicitProviderAttemptCount = countModelProviderAttempts(
    input.currentTokenUsage,
  );
  const currentProviderAttemptCount = countCurrentAttempt
    ? Math.max(
        explicitProviderAttemptCount,
        currentExplicitUnknownUsage,
        input.modelId === "mock" ? 0 : 1,
      )
    : 0;
  const currentReportedCostUsd = collectReportedModelCostUsd(
    input.currentTokenUsage,
  );
  const currentUsageEntryCount = countModelUsageEntries(
    input.currentTokenUsage,
  );
  const currentCostedAttemptCount = countCostedModelProviderAttempts(
    input.currentTokenUsage,
  );
  const priorUsageEntryCount = countModelUsageEntries(input.priorTokenUsage);
  const priorCostedAttemptCount = countCostedModelProviderAttempts(
    input.priorTokenUsage,
  );
  const openRouter = input.provider.toLowerCase() === "openrouter";
  const priorCostComplete =
    !openRouter ||
    input.modelId === "mock" ||
    priorAttemptCount === 0 ||
    (
      priorUsageEntryCount > 0 &&
      priorCostedAttemptCount >= priorAttemptCount
    );
  const priorUsageComplete =
    priorRefs?.usageComplete !== false && priorCostComplete;
  const currentCostComplete =
    !countCurrentAttempt ||
    !openRouter ||
    input.modelId === "mock" ||
    (
      currentUsageEntryCount > 0 &&
      currentCostedAttemptCount >= currentProviderAttemptCount
    );
  const usageComplete =
    unknownUsageAttempts === 0 &&
    priorUsageComplete &&
    currentCostComplete;
  const priorKnownEstimatedCostUsd =
    input.priorEstimatedCostUsd ??
    nonNegativeNumber(priorRefs?.knownEstimatedCostUsd);
  const knownEstimatedCostUsd =
    input.provider === "openrouter"
      ? priorKnownEstimatedCostUsd != null || currentReportedCostUsd != null
        ? Number(
            (
              (priorKnownEstimatedCostUsd ?? 0) +
              (currentReportedCostUsd ?? 0)
            ).toFixed(8),
          )
        : null
      : resolveModelCostUsd({
          provider: input.provider,
          modelId: input.modelId,
          usage,
          rawUsage: {
            prior: input.priorTokenUsage,
            current: input.currentTokenUsage,
          },
        });

  return {
    usage,
    hasKnownUsage: priorHasKnownUsage || currentHasKnownUsage,
    auditAttemptCount: priorAttemptCount + currentProviderAttemptCount,
    currentProviderAttemptCount,
    unknownUsageAttempts,
    usageComplete,
    knownEstimatedCostUsd,
    // An unobserved provider attempt makes the total cost unknown. Retain the
    // priced known-token lower bound in resultRefs without presenting it as a
    // complete run cost.
    estimatedCostUsd: usageComplete ? knownEstimatedCostUsd : null,
  };
}

function profileForAuditedKind(kind: AuditedGenerationKind): TextModelProfile {
  switch (kind) {
    case "execution_routing":
      return "routing";
    case "semantic_extraction":
    case "semantic_repair":
      return "code_extraction";
    case "capability_synthesis":
      return "routing";
    case "coverage_audit":
      return "verification";
    case "answer_completeness_audit":
      return "deep_synthesis";
    case "highlight_verification":
      return "verification";
    case "artifact_generation":
      return "verification";
  }
}

export async function runAuditedStructuredGeneration<TResult extends StructuredResult>(input: {
  workItemId?: string;
  agentRunId?: string;
  kind: AuditedGenerationKind;
  idempotencyKey?: string;
  profile?: TextModelProfile;
  inputSummary: unknown;
  execute: () => Promise<TResult>;
}): Promise<TResult & { generationRunId: string | null }> {
  const startedAt = Date.now();
  const config =
    input.workItemId && input.idempotencyKey
      ? resolveActiveTextModelIdentity(
          input.profile ?? profileForAuditedKind(input.kind),
        )
      : null;
  const run = input.workItemId && input.idempotencyKey && config
    ? await prisma.generationRun.upsert({
        where: {
          workItemId_idempotencyKey: {
            workItemId: input.workItemId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        create: {
          workItemId: input.workItemId,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          status: "running",
          provider: config.provider,
          modelId: config.modelId,
          inputSummary: json(input.inputSummary),
        },
        update: {
          status: "running",
          provider: config.provider,
          modelId: config.modelId,
          inputSummary: json(input.inputSummary),
          validationErrors: Prisma.JsonNull,
        },
      })
    : null;

  try {
    const result = await input.execute();
    if (run) {
      const auditUsage = cumulativeAuditUsage({
        priorTokenUsage: run.tokenUsage,
        priorResultRefs: run.resultRefs,
        currentTokenUsage: result.tokenUsage,
        modelId: result.modelId,
        provider: result.provider,
        priorEstimatedCostUsd: run.estimatedCostUsd,
      });
      const tokenUsage = cumulativeAuditedUsageEvidence({
        priorTokenUsage: run.tokenUsage,
        currentTokenUsage: result.tokenUsage,
        providerAttemptCount: auditUsage.auditAttemptCount,
        unknownUsageAttempts: auditUsage.unknownUsageAttempts,
      });
      const providerAttempts = collectProviderAttemptMetadata(tokenUsage);
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          provider: result.provider,
          modelId: result.modelId,
          rawOutput: rawPreview(result.rawOutput),
          parsedOutput: json(result.parsedOutput),
          validationErrors: Prisma.JsonNull,
          tokenUsage: tokenUsage == null ? Prisma.JsonNull : tokenUsage as Prisma.InputJsonValue,
          estimatedCostUsd: auditUsage.estimatedCostUsd,
          resultRefs: json({
            ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
            transportMode: result.transportMode,
            profile: input.profile ?? profileForAuditedKind(input.kind),
            configuredModelId: config!.modelId,
            requestId: result.requestId ?? null,
            requestIds: providerAttempts.requestIds,
            attempts: result.attempts,
            rawOutputHash: rawHash(result.rawOutput),
            durationMs: Date.now() - startedAt,
            auditAttemptCount: auditUsage.auditAttemptCount,
            providerAttemptCount: auditUsage.currentProviderAttemptCount,
            failedProviderAttempts: providerAttempts.failedAttempts,
            routedProviders: providerAttempts.routedProviders,
            unknownUsageAttempts: auditUsage.unknownUsageAttempts,
            usageComplete: auditUsage.usageComplete,
            knownEstimatedCostUsd: auditUsage.knownEstimatedCostUsd,
          }),
        },
      });
    }
    return { ...result, generationRunId: run?.id ?? null };
  } catch (error) {
    if (run) {
      const structured = error instanceof StructuredOutputError ? error : null;
      const admissionFailure =
        isStructuredGenerationAdmissionFailure(error);
      const failureTokenUsage =
        structured?.tokenUsage ??
        generationRunFailureTokenUsage(error) ??
        providerErrorUsage(error);
      const auditUsage = cumulativeAuditUsage({
        priorTokenUsage: run.tokenUsage,
        priorResultRefs: run.resultRefs,
        currentTokenUsage: failureTokenUsage,
        modelId: run.modelId,
        provider: run.provider ?? config!.provider,
        priorEstimatedCostUsd: run.estimatedCostUsd,
        countCurrentAttempt: !admissionFailure,
      });
      const tokenUsage = cumulativeAuditedUsageEvidence({
        priorTokenUsage: run.tokenUsage,
        currentTokenUsage: failureTokenUsage,
        providerAttemptCount: auditUsage.auditAttemptCount,
        unknownUsageAttempts: auditUsage.unknownUsageAttempts,
      });
      const providerAttempts = collectProviderAttemptMetadata(tokenUsage);
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: structured?.status ?? "provider_error",
          rawOutput: rawPreview(structured?.rawOutput ?? null),
          validationErrors: structured?.validationErrors == null ? Prisma.JsonNull : json(structured.validationErrors),
          tokenUsage: tokenUsage == null ? Prisma.JsonNull : tokenUsage as Prisma.InputJsonValue,
          estimatedCostUsd: auditUsage.estimatedCostUsd,
          resultRefs: json({
            ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
            transportMode: structured?.transportMode ?? null,
            profile: input.profile ?? profileForAuditedKind(input.kind),
            configuredModelId: config!.modelId,
            requestIds: providerAttempts.requestIds,
            attempts: structured?.attempts ?? null,
            rawOutputHash: rawHash(structured?.rawOutput ?? null),
            message: error instanceof Error ? error.message.slice(0, 500) : "Unknown structured generation error.",
            durationMs: Date.now() - startedAt,
            auditAttemptCount: auditUsage.auditAttemptCount,
            providerAttemptCount: auditUsage.currentProviderAttemptCount,
            failedProviderAttempts: providerAttempts.failedAttempts,
            routedProviders: providerAttempts.routedProviders,
            unknownUsageAttempts: auditUsage.unknownUsageAttempts,
            usageComplete: auditUsage.usageComplete,
            knownEstimatedCostUsd: auditUsage.knownEstimatedCostUsd,
            admissionFailure,
            budgetCode:
              error instanceof StructuredGenerationBudgetError
                ? error.code
                : null,
          }),
        },
      });
    }
    throw error;
  }
}
