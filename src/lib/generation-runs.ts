import { Prisma } from "@/src/generated/prisma/client";
import { prisma } from "@/src/lib/prisma";

type GenerationRunWriteInput = {
  workItemId: string;
  kind:
    | "claim_research"
    | "claim_verification"
    | "artifact_generation"
    | "evidence_clustering";
  status: "success" | "provider_error" | "parse_error" | "validation_error";
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
    inputSummary: run.inputSummary,
    rawOutput: run.rawOutput,
    parsedOutput: run.parsedOutput,
    validationErrors: run.validationErrors,
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
    resultRefs: run.resultRefs,
  });

  return run;
}
