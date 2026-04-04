import type { Prisma } from "@/src/generated/prisma/client";
import { attachGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { createGenerationRun } from "@/src/lib/generation-runs";
import { artifactGenerationLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import type { ArtifactGenerationService } from "@/src/services/types";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockArtifactGenerationService } from "@/src/services/mock-artifact-generation-service";

function buildArtifactInputSummary(params: {
  workItemId: string;
  artifactType: string;
  targetAngle: string;
  tone: string;
  claimCount: number;
  systemPrompt: string;
  userPrompt: string;
}) {
  return {
    workItemId: params.workItemId,
    artifactType: params.artifactType,
    targetAngle: params.targetAngle,
    tone: params.tone,
    claimCount: params.claimCount,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  };
}

function buildArtifactContentInstructions(
  artifactType: "resume_bullets" | "linkedin_experience" | "project_summary",
) {
  if (artifactType === "resume_bullets") {
    return "Return 2 to 3 concise resume bullets, each starting with '- '.";
  }

  if (artifactType === "linkedin_experience") {
    return "Return one short LinkedIn-style experience entry as a tight paragraph.";
  }

  return "Return one short project summary paragraph.";
}

const bedrockArtifactGenerationService: ArtifactGenerationService = {
  async generate({ request, claims }) {
    if (!claims.length) {
      throw new Error(
        "No approved claims match the current artifact visibility and sensitivity rules.",
      );
    }

    const structuredClient = getBedrockStructuredLlmClient();
    const allowedClaimIds = new Set(claims.map((claim) => claim.id));
    const systemPrompt = [
      "You draft Workbase artifacts from already-approved claims.",
      "Return strict JSON only.",
      "Never invent work, metrics, outcomes, scope, or technologies.",
      "Only use the provided approved claims.",
    ].join(" ");
    const userPrompt = JSON.stringify(
      {
        task: "Generate one Workbase artifact draft.",
        request: {
          type: request.type,
          targetAngle: request.targetAngle,
          tone: request.tone,
        },
        contentInstructions: buildArtifactContentInstructions(request.type),
        approvedClaims: claims.map((claim) => ({
          id: claim.id,
          text: claim.text,
          category: claim.category,
          confidence: claim.confidence,
          ownershipClarity: claim.ownershipClarity,
        })),
      },
      null,
      2,
    );
    const inputSummary = buildArtifactInputSummary({
      workItemId: request.workItemId,
      artifactType: request.type,
      targetAngle: request.targetAngle,
      tone: request.tone,
      claimCount: claims.length,
      systemPrompt,
      userPrompt,
    });

    try {
      const result = await structuredClient.generateStructured({
        systemPrompt,
        userPrompt,
        schema: artifactGenerationLlmOutputSchema,
        maxTokens: 1400,
        extraValidation: (value) => {
          const errors: string[] = [];

          value.usedClaimIds.forEach((claimId, index) => {
            if (!allowedClaimIds.has(claimId)) {
              errors.push(`usedClaimIds[${index}] references an unknown claimId.`);
            }
          });

          if (new Set(value.usedClaimIds).size !== value.usedClaimIds.length) {
            errors.push("usedClaimIds must not contain duplicates.");
          }

          return errors;
        },
      });

      const artifact = {
        type: request.type,
        targetAngle: request.targetAngle,
        tone: request.tone,
        content: result.data.content.trim(),
        usedClaimIds: result.data.usedClaimIds,
      };
      const generationRun = await createGenerationRun({
        workItemId: request.workItemId,
        kind: "artifact_generation",
        status: "success",
        provider: result.provider,
        modelId: result.modelId,
        inputSummary: inputSummary as Prisma.InputJsonValue,
        rawOutput: result.rawOutput,
        parsedOutput: result.parsedOutput as Prisma.InputJsonValue,
        validationErrors: null,
        resultRefs: {
          usedClaimIds: artifact.usedClaimIds,
        } as Prisma.InputJsonValue,
        tokenUsage: (result.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: result.estimatedCostUsd,
      });

      return attachGenerationRunMetadata(artifact, {
        id: generationRun.id,
        kind: "artifact_generation",
      });
    } catch (error) {
      const failure = error instanceof StructuredOutputError ? error : null;

      await createGenerationRun({
        workItemId: request.workItemId,
        kind: "artifact_generation",
        status: failure?.status ?? "provider_error",
        provider: "bedrock",
        modelId: process.env.WORKBASE_BEDROCK_MODEL_ID ?? "unconfigured",
        inputSummary: inputSummary as Prisma.InputJsonValue,
        rawOutput: failure?.rawOutput ?? null,
        parsedOutput: null,
        validationErrors:
          (failure?.validationErrors as Prisma.InputJsonValue | null) ?? null,
        resultRefs: null,
        tokenUsage: (failure?.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: null,
      });

      throw error;
    }
  },
};

export const artifactGenerationService: ArtifactGenerationService = {
  async generate(input) {
    if (resolveWorkbaseLlmProvider() === "mock") {
      return mockArtifactGenerationService.generate(input);
    }

    return bedrockArtifactGenerationService.generate(input);
  },
};
