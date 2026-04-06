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
  highlightCount: number;
  supportingEvidenceCount: number;
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
    highlightCount: params.highlightCount,
    supportingEvidenceCount: params.supportingEvidenceCount,
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
  async generate({ request, highlights, supportingEvidence }) {
    if (!highlights.length) {
      throw new Error(
        "No approved highlights match the current artifact visibility and sensitivity rules.",
      );
    }

    const structuredClient = getBedrockStructuredLlmClient();
    const allowedHighlightIds = new Set(highlights.map((highlight) => highlight.id));
    const allowedEvidenceItemIds = new Set(
      supportingEvidence.map((item) => item.id),
    );
    const systemPrompt = [
      "You draft Workbase artifacts from already-approved highlights.",
      "Return JSON that matches the provided schema exactly.",
      "Only use the provided approved highlights and supporting evidence.",
    ].join(" ");
    const userPrompt = formatTaggedSections([
      {
        tag: "task",
        content: "Generate one Workbase artifact draft.",
      },
      {
        tag: "rules",
        content: [
          "Return a top-level JSON object with `content`, `usedHighlightIds`, and `supportingEvidenceItemIds`.",
          "Never invent work, metrics, outcomes, scope, or technologies.",
          "Only cite highlight IDs that were provided in the approvedHighlights input.",
          "Only cite supportingEvidenceItemIds that were provided in the supportingEvidence input.",
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
        tag: "approved_highlights",
        content: JSON.stringify(
          highlights.map((highlight) => ({
            id: highlight.id,
            text: highlight.text,
            summary: highlight.summary,
            confidence: highlight.confidence,
            ownershipClarity: highlight.ownershipClarity,
            tags: highlight.tags,
          })),
          null,
          2,
        ),
      },
      {
        tag: "supporting_evidence",
        content: JSON.stringify(
          supportingEvidence.map((item) => ({
            id: item.id,
            title: item.title,
            excerpt: item.content,
            tags: item.tags ?? [],
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
      highlightCount: highlights.length,
      supportingEvidenceCount: supportingEvidence.length,
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

          value.usedHighlightIds.forEach((highlightId, index) => {
            if (!allowedHighlightIds.has(highlightId)) {
              errors.push(`usedHighlightIds[${index}] references an unknown highlightId.`);
            }
          });

          value.supportingEvidenceItemIds.forEach((evidenceItemId, index) => {
            if (!allowedEvidenceItemIds.has(evidenceItemId)) {
              errors.push(
                `supportingEvidenceItemIds[${index}] references an unknown evidenceItemId.`,
              );
            }
          });

          if (new Set(value.usedHighlightIds).size !== value.usedHighlightIds.length) {
            errors.push("usedHighlightIds must not contain duplicates.");
          }

          if (
            new Set(value.supportingEvidenceItemIds).size !==
            value.supportingEvidenceItemIds.length
          ) {
            errors.push("supportingEvidenceItemIds must not contain duplicates.");
          }

          return errors;
        },
      });

      const artifact = {
        type: request.type,
        targetAngle: request.targetAngle,
        tone: request.tone,
        content: result.data.content.trim(),
        usedHighlightIds: result.data.usedHighlightIds,
        supportingEvidenceItemIds: result.data.supportingEvidenceItemIds,
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
          usedHighlightIds: artifact.usedHighlightIds,
          supportingEvidenceItemIds: artifact.supportingEvidenceItemIds,
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
