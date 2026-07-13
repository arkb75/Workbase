import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import { sanitizeBedrockConverseEventValue } from "@/src/lib/bedrock-converse-agent";
import { resolveBedrockConfig } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";

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

export async function runAuditedStructuredGeneration<TResult extends StructuredResult>(input: {
  workItemId?: string;
  kind: AuditedGenerationKind;
  idempotencyKey?: string;
  inputSummary: unknown;
  execute: () => Promise<TResult>;
}): Promise<TResult & { generationRunId: string | null }> {
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
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          rawOutput: rawPreview(result.rawOutput),
          parsedOutput: json(result.parsedOutput),
          validationErrors: Prisma.JsonNull,
          tokenUsage: result.tokenUsage == null ? Prisma.JsonNull : json(result.tokenUsage),
          resultRefs: json({
            transportMode: result.transportMode,
            attempts: result.attempts,
            rawOutputHash: rawHash(result.rawOutput),
          }),
        },
      });
    }
    return { ...result, generationRunId: run?.id ?? null };
  } catch (error) {
    if (run) {
      const structured = error instanceof StructuredOutputError ? error : null;
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: structured?.status ?? "provider_error",
          rawOutput: rawPreview(structured?.rawOutput ?? null),
          validationErrors: structured?.validationErrors == null ? Prisma.JsonNull : json(structured.validationErrors),
          tokenUsage: structured?.tokenUsage == null ? Prisma.JsonNull : json(structured.tokenUsage),
          resultRefs: json({
            transportMode: structured?.transportMode ?? null,
            attempts: structured?.attempts ?? null,
            rawOutputHash: rawHash(structured?.rawOutput ?? null),
            message: error instanceof Error ? error.message.slice(0, 500) : "Unknown structured generation error.",
          }),
        },
      });
    }
    throw error;
  }
}
