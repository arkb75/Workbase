import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import { sanitizeBedrockConverseEventValue } from "@/src/lib/bedrock-converse-agent";
import { resolveBedrockConfig } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import {
  addModelTokenUsage,
  collectModelTokenUsage,
  collectUnknownModelUsageAttempts,
  estimateBedrockCostUsd,
  modelTokenUsageJson,
} from "@/src/services/model-usage-service";

type AuditedGenerationKind =
  | "execution_routing"
  | "semantic_extraction"
  | "semantic_repair"
  | "capability_synthesis"
  | "coverage_audit"
  | "answer_completeness_audit";

type StructuredResult = {
  data: unknown;
  rawOutput: string;
  parsedOutput: JsonValue;
  tokenUsage: JsonValue | null;
  provider: string;
  modelId: string;
  transportMode: string;
  attempts: unknown;
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

function cumulativeAuditUsage(input: {
  priorTokenUsage: unknown;
  priorResultRefs: unknown;
  currentTokenUsage: unknown;
  modelId: string;
}) {
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
  const unknownUsageAttempts = priorUnknownUsageAttempts +
    (currentExplicitUnknownUsage || (!currentHasKnownUsage && input.modelId !== "mock" ? 1 : 0));
  const usage = addModelTokenUsage(
    collectModelTokenUsage(input.priorTokenUsage),
    currentUsage,
  );
  const knownEstimatedCostUsd = estimateBedrockCostUsd(input.modelId, usage);

  return {
    usage,
    hasKnownUsage: priorHasKnownUsage || currentHasKnownUsage,
    auditAttemptCount: priorAttemptCount + 1,
    unknownUsageAttempts,
    usageComplete: unknownUsageAttempts === 0,
    knownEstimatedCostUsd,
    // An unobserved provider attempt makes the total cost unknown. Retain the
    // priced known-token lower bound in resultRefs without presenting it as a
    // complete run cost.
    estimatedCostUsd: unknownUsageAttempts === 0 ? knownEstimatedCostUsd : null,
  };
}

export async function runAuditedStructuredGeneration<TResult extends StructuredResult>(input: {
  workItemId?: string;
  kind: AuditedGenerationKind;
  idempotencyKey?: string;
  inputSummary: unknown;
  execute: () => Promise<TResult>;
}): Promise<TResult & { generationRunId: string | null }> {
  const startedAt = Date.now();
  const config = input.workItemId && input.idempotencyKey ? resolveBedrockConfig() : null;
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
        modelId: run.modelId,
      });
      const tokenUsage = auditUsage.hasKnownUsage ? modelTokenUsageJson(auditUsage.usage) : null;
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          rawOutput: rawPreview(result.rawOutput),
          parsedOutput: json(result.parsedOutput),
          validationErrors: Prisma.JsonNull,
          tokenUsage: tokenUsage == null ? Prisma.JsonNull : tokenUsage as Prisma.InputJsonValue,
          estimatedCostUsd: auditUsage.estimatedCostUsd,
          resultRefs: json({
            transportMode: result.transportMode,
            attempts: result.attempts,
            rawOutputHash: rawHash(result.rawOutput),
            durationMs: Date.now() - startedAt,
            auditAttemptCount: auditUsage.auditAttemptCount,
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
      const auditUsage = cumulativeAuditUsage({
        priorTokenUsage: run.tokenUsage,
        priorResultRefs: run.resultRefs,
        currentTokenUsage: structured?.tokenUsage ?? null,
        modelId: run.modelId,
      });
      const tokenUsage = auditUsage.hasKnownUsage ? modelTokenUsageJson(auditUsage.usage) : null;
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: structured?.status ?? "provider_error",
          rawOutput: rawPreview(structured?.rawOutput ?? null),
          validationErrors: structured?.validationErrors == null ? Prisma.JsonNull : json(structured.validationErrors),
          tokenUsage: tokenUsage == null ? Prisma.JsonNull : tokenUsage as Prisma.InputJsonValue,
          estimatedCostUsd: auditUsage.estimatedCostUsd,
          resultRefs: json({
            transportMode: structured?.transportMode ?? null,
            attempts: structured?.attempts ?? null,
            rawOutputHash: rawHash(structured?.rawOutput ?? null),
            message: error instanceof Error ? error.message.slice(0, 500) : "Unknown structured generation error.",
            durationMs: Date.now() - startedAt,
            auditAttemptCount: auditUsage.auditAttemptCount,
            unknownUsageAttempts: auditUsage.unknownUsageAttempts,
            usageComplete: auditUsage.usageComplete,
            knownEstimatedCostUsd: auditUsage.knownEstimatedCostUsd,
          }),
        },
      });
    }
    throw error;
  }
}
