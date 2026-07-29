import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";

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
  console.info(
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

export async function createGenerationRun(
  data: GenerationRunWriteInput,
) {
  const run = await prisma.generationRun.create({
    data: {
      ...data,
      rawOutput: data.rawOutput ?? null,
      parsedOutput:
        data.parsedOutput == null ? Prisma.JsonNull : data.parsedOutput,
      validationErrors:
        data.validationErrors == null ? Prisma.JsonNull : data.validationErrors,
      resultRefs: data.resultRefs == null ? Prisma.JsonNull : data.resultRefs,
      tokenUsage: data.tokenUsage == null ? Prisma.JsonNull : data.tokenUsage,
      estimatedCostUsd: data.estimatedCostUsd ?? null,
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
