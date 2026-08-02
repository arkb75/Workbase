import type { Prisma } from "@/src/generated/prisma/client";
import { attachGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import {
  createGenerationRun,
  generationRunFailureTokenUsage,
  isStructuredGenerationAdmissionFailure,
} from "@/src/lib/generation-runs";
import { artifactGenerationLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import {
  resolveActiveTextModelIdentity,
  resolveWorkbaseLlmProvider,
} from "@/src/lib/llm-config";
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
import { getStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockArtifactGenerationService } from "@/src/services/mock-artifact-generation-service";
import { deriveArtifactEvidenceItemIds } from "@/src/services/artifact-publication-policy";

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

export function buildArtifactContentInstructions(
  artifactType: "resume_bullets" | "linkedin_experience" | "project_summary",
  approvedHighlightCount: number,
) {
  if (artifactType === "resume_bullets") {
    const maximumSupportedBullets = Math.min(
      3,
      Math.max(1, Math.floor(approvedHighlightCount)),
    );
    return [
      `Return 1 to ${maximumSupportedBullets} concise resume bullet${maximumSupportedBullets === 1 ? "" : "s"}, each starting with '- '.`,
      "Use at most one bullet per independently approved Highlight.",
      "Return fewer bullets than the request asks for when the approved Highlights do not independently support that count.",
    ].join(" ");
  }

  if (artifactType === "linkedin_experience") {
    return "Return one short LinkedIn-style experience entry as a tight paragraph.";
  }

  return "Return one short project summary paragraph.";
}

const bedrockArtifactGenerationService: ArtifactGenerationService = {
  async generate({ request, highlights, supportingEvidence, agentRunId }) {
    if (!highlights.length) {
      throw new Error(
        "No approved highlights match the current artifact visibility and sensitivity rules.",
      );
    }

    const structuredClient = getStructuredLlmClient("drafting");
    const configuredIdentity = resolveActiveTextModelIdentity("drafting");
    const allowedHighlightIds = new Set(highlights.map((highlight) => highlight.id));
    const allowedEvidenceItemIds = new Set(supportingEvidence.map((item) => item.id));
    const systemPrompt = [
      "You draft Workbase artifacts from already-approved highlights.",
      "Return JSON that matches the provided schema exactly.",
      "Only use the provided approved highlights. Raw supporting evidence is deliberately unavailable during drafting.",
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
          "Preserve the approved Highlight wording wherever possible; do not replace it with broader synonyms or inferred benefits.",
          "Only cite highlight IDs that were provided in the approvedHighlights input.",
          "Return an empty supportingEvidenceItemIds array. Workbase derives exact evidence provenance from the selected approved Highlights after generation.",
          buildArtifactContentInstructions(request.type, highlights.length),
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
            brief: request.brief ?? null,
          },
          null,
          2,
        ),
      },
      ...(request.brief
        ? [
            {
              tag: "request_brief",
              content: [
                request.brief,
                "Follow this brief only where the approved highlights support it.",
              ].join("\n"),
            },
          ]
        : []),
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

          if (value.supportingEvidenceItemIds.length) {
            errors.push("supportingEvidenceItemIds must be empty; provenance is derived from approved Highlights.");
          }

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
        supportingEvidenceItemIds: deriveArtifactEvidenceItemIds({
          highlights,
          usedHighlightIds: result.data.usedHighlightIds,
          allowedEvidenceItemIds,
        }),
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
          ...(agentRunId ? { agentRunId } : {}),
          profile: "drafting",
          configuredModelId: configuredIdentity.modelId,
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
      const admissionFailure =
        isStructuredGenerationAdmissionFailure(error);

      await createGenerationRun({
        workItemId: request.workItemId,
        kind: "artifact_generation",
        status: failure?.status ?? "provider_error",
        provider: configuredIdentity.provider,
        modelId: configuredIdentity.modelId,
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
        resultRefs: {
          ...(agentRunId ? { agentRunId } : {}),
          profile: "drafting",
          configuredModelId: configuredIdentity.modelId,
          ...(admissionFailure ? { admissionFailure: true } : {}),
        },
        tokenUsage:
          (failure?.tokenUsage as Prisma.InputJsonValue | null) ??
          (admissionFailure ? null : generationRunFailureTokenUsage(error)),
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
