import type { Prisma } from "@/src/generated/prisma/client";
import { attachGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { createGenerationRun } from "@/src/lib/generation-runs";
import { artifactGenerationLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import {
  artifactGenerationExampleOutput,
  artifactGenerationJsonSchema,
  artifactGenerationRequiredFields,
  artifactGenerationSchemaDescription,
  artifactGenerationSchemaName,
} from "@/src/lib/llm-json-schemas";
import { formatTaggedSections } from "@/src/lib/structured-prompt";
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
  transportMode?: string | null;
  attempts?: unknown;
  systemPrompt: string;
  userPrompt: string;
}) {
  return {
    workItemId: params.workItemId,
    artifactType: params.artifactType,
    targetAngle: params.targetAngle,
    tone: params.tone,
    claimCount: params.claimCount,
    transportMode: params.transportMode ?? null,
    transportAttempts: params.attempts ?? null,
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
      "Return JSON that matches the provided schema exactly.",
      "Only use the provided approved claims.",
    ].join(" ");
    const userPrompt = formatTaggedSections([
      {
        tag: "task",
        content: "Generate one Workbase artifact draft.",
      },
      {
        tag: "rules",
        content: [
          "Return a top-level JSON object with `content` and `usedClaimIds`.",
          "Never invent work, metrics, outcomes, scope, or technologies.",
          "Only cite claim IDs that were provided in the approvedClaims input.",
          buildArtifactContentInstructions(request.type),
        ].join("\n"),
      },
      {
        tag: "output_schema",
        content: JSON.stringify(artifactGenerationJsonSchema, null, 2),
      },
      {
        tag: "required_fields",
        content: JSON.stringify(artifactGenerationRequiredFields, null, 2),
      },
      {
        tag: "example_output",
        content: JSON.stringify(artifactGenerationExampleOutput, null, 2),
      },
      {
        tag: "request",
        content: JSON.stringify(
          {
            type: request.type,
            targetAngle: request.targetAngle,
            tone: request.tone,
          },
          null,
          2,
        ),
      },
      {
        tag: "approved_claims",
        content: JSON.stringify(
          claims.map((claim) => ({
            id: claim.id,
            text: claim.text,
            category: claim.category,
            confidence: claim.confidence,
            ownershipClarity: claim.ownershipClarity,
          })),
          null,
          2,
        ),
      },
    ]);
    const baseInputSummary = buildArtifactInputSummary({
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
        schemaName: artifactGenerationSchemaName,
        schemaDescription: artifactGenerationSchemaDescription,
        jsonSchema: artifactGenerationJsonSchema,
        exampleOutput: artifactGenerationExampleOutput,
        requiredFieldPaths: artifactGenerationRequiredFields,
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
        inputSummary: {
          ...baseInputSummary,
          transportMode: result.transportMode,
          transportAttempts: JSON.parse(
            JSON.stringify(result.attempts),
          ) as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
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
        inputSummary: {
          ...baseInputSummary,
          transportMode: failure?.transportMode ?? null,
          transportAttempts:
            failure?.attempts == null
              ? null
              : (JSON.parse(JSON.stringify(failure.attempts)) as Prisma.InputJsonValue),
        } as Prisma.InputJsonValue,
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
