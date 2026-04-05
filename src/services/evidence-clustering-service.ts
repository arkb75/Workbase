import type { Prisma } from "@/src/generated/prisma/client";
import type { EvidenceClusterDraft, JsonValue } from "@/src/domain/types";
import { buildPromptReadyEvidenceExcerpt } from "@/src/lib/claim-prompt-prep";
import { createGenerationRun } from "@/src/lib/generation-runs";
import { evidenceClusteringLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import {
  evidenceClusteringExampleOutput,
  evidenceClusteringJsonSchema,
  evidenceClusteringRequiredFields,
  evidenceClusteringSchemaDescription,
  evidenceClusteringSchemaName,
} from "@/src/lib/llm-json-schemas";
import { formatTaggedSections } from "@/src/lib/structured-prompt";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import type { EvidenceClusteringService } from "@/src/services/types";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockEvidenceClusteringService } from "@/src/services/mock-evidence-clustering-service";

function buildClusteringInputSummary(params: {
  workItemId: string;
  workItemTitle: string;
  evidenceCount: number;
  totalExcerptChars: number;
  transportMode?: string | null;
  attempts?: JsonValue | null;
  systemPrompt: string;
  userPrompt: string;
}) {
  return {
    workItemId: params.workItemId,
    workItemTitle: params.workItemTitle,
    evidenceCount: params.evidenceCount,
    totalExcerptChars: params.totalExcerptChars,
    transportMode: params.transportMode ?? null,
    transportAttempts: params.attempts ?? null,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  };
}

function toClusterDrafts(
  output: {
    clusters: Array<{
      title: string;
      summary: string;
      theme: string;
      confidence: "low" | "medium" | "high";
      metadata?: Record<string, unknown> | null;
      items: Array<{
        evidenceItemId: string;
        relevanceScore?: number | null;
      }>;
    }>;
  },
): EvidenceClusterDraft[] {
  return output.clusters.map((cluster) => ({
    title: cluster.title,
    summary: cluster.summary,
    theme: cluster.theme,
    confidence: cluster.confidence,
    metadata: (cluster.metadata as JsonValue | null) ?? null,
    items: cluster.items.map((item) => ({
      evidenceItemId: item.evidenceItemId,
      relevanceScore: item.relevanceScore ?? null,
    })),
  }));
}

function buildEvidenceRefMaps(evidenceItems: Array<{ id: string }>) {
  const llmRefToEvidenceItemId = new Map<string, string>();
  const evidenceItemIdToLlmRef = new Map<string, string>();

  evidenceItems.forEach((item, index) => {
    const llmRef = `ev_${String(index + 1).padStart(2, "0")}`;
    llmRefToEvidenceItemId.set(llmRef, item.id);
    evidenceItemIdToLlmRef.set(item.id, llmRef);
  });

  return {
    llmRefToEvidenceItemId,
    evidenceItemIdToLlmRef,
  };
}

const bedrockEvidenceClusteringService: EvidenceClusteringService = {
  async cluster({ workItem, evidenceItems }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const { llmRefToEvidenceItemId, evidenceItemIdToLlmRef } = buildEvidenceRefMaps(
      evidenceItems,
    );
    const llmRefs = new Set(llmRefToEvidenceItemId.keys());
    const systemPrompt = [
      "You cluster Workbase evidence into coherent technical work themes.",
      "Return JSON that matches the provided schema exactly.",
      "Use each included evidence item exactly once.",
    ].join(" ");
    const promptEvidenceItems = evidenceItems.map((item) => ({
      itemRef: evidenceItemIdToLlmRef.get(item.id),
      sourceType: item.source.type,
      evidenceType: item.type,
      title: item.title,
      excerpt: buildPromptReadyEvidenceExcerpt({
        evidenceType: item.type,
        title: item.title,
        content: item.content,
      }),
      sourceLabel: item.source.label,
    }));
    const userPrompt = formatTaggedSections([
      {
        tag: "task",
        content:
          "Group the included evidence into 2 to 8 coherent work clusters. Titles and themes should be specific and derived from the evidence rather than generic bucket names.",
      },
      {
        tag: "rules",
        content: [
          "Return a top-level JSON object with a `clusters` array.",
          "Use every provided itemRef exactly once across all cluster items.",
          "For each cluster item, return the itemRef string in the `evidenceItemId` field exactly as provided.",
          "Do not merge obviously unrelated work to reduce cluster count.",
          "Do not create trivial single-item clusters unless the evidence is clearly distinct.",
        ].join("\n"),
      },
      {
        tag: "output_schema",
        content: JSON.stringify(evidenceClusteringJsonSchema, null, 2),
      },
      {
        tag: "required_fields",
        content: JSON.stringify(evidenceClusteringRequiredFields, null, 2),
      },
      {
        tag: "example_output",
        content: JSON.stringify(evidenceClusteringExampleOutput, null, 2),
      },
      {
        tag: "work_item",
        content: JSON.stringify(
          {
            id: workItem.id,
            title: workItem.title,
            type: workItem.type,
            description: workItem.description,
          },
          null,
          2,
        ),
      },
      {
        tag: "evidence_items",
        content: JSON.stringify(promptEvidenceItems, null, 2),
      },
    ]);
    const baseInputSummary = buildClusteringInputSummary({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      evidenceCount: evidenceItems.length,
      totalExcerptChars: promptEvidenceItems.reduce(
        (sum, item) => sum + item.excerpt.length,
        0,
      ),
      systemPrompt,
      userPrompt,
    });

    try {
      const result = await structuredClient.generateStructured({
        systemPrompt,
        userPrompt,
        schema: evidenceClusteringLlmOutputSchema,
        schemaName: evidenceClusteringSchemaName,
        schemaDescription: evidenceClusteringSchemaDescription,
        jsonSchema: evidenceClusteringJsonSchema,
        exampleOutput: evidenceClusteringExampleOutput,
        requiredFieldPaths: evidenceClusteringRequiredFields,
        maxTokens: 2400,
        extraValidation: (value) => {
          const errors: string[] = [];
          const seenEvidenceItemIds = new Set<string>();

          value.clusters.forEach((cluster, clusterIndex) => {
            cluster.items.forEach((item, itemIndex) => {
              if (!llmRefs.has(item.evidenceItemId)) {
                errors.push(
                  `clusters[${clusterIndex}].items[${itemIndex}] references unknown evidenceItemId ${item.evidenceItemId}.`,
                );
              }

              if (seenEvidenceItemIds.has(item.evidenceItemId)) {
                errors.push(`evidenceItemId ${item.evidenceItemId} was assigned to multiple clusters.`);
              }

              seenEvidenceItemIds.add(item.evidenceItemId);
            });
          });

          if (seenEvidenceItemIds.size !== llmRefs.size) {
            errors.push("Clustering output must cover every included evidence item exactly once.");
          }

          return errors;
        },
      });

      const generationRun = await createGenerationRun({
        workItemId: workItem.id,
        kind: "evidence_clustering",
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
        resultRefs: null,
        tokenUsage: (result.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: result.estimatedCostUsd,
      });

      return {
        clusters: toClusterDrafts({
          clusters: result.data.clusters.map((cluster) => ({
            ...cluster,
            items: cluster.items.map((item) => ({
              ...item,
              evidenceItemId:
                llmRefToEvidenceItemId.get(item.evidenceItemId) ?? item.evidenceItemId,
            })),
          })),
        }),
        generationRunId: generationRun.id,
      };
    } catch (error) {
      const failure = error instanceof StructuredOutputError ? error : null;

      await createGenerationRun({
        workItemId: workItem.id,
        kind: "evidence_clustering",
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

export const evidenceClusteringService: EvidenceClusteringService = {
  async cluster(input) {
    if (resolveWorkbaseLlmProvider() === "mock") {
      return mockEvidenceClusteringService.cluster(input);
    }

    return bedrockEvidenceClusteringService.cluster(input);
  },
};
