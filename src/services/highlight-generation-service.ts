import type { Prisma } from "@/src/generated/prisma/client";
import type {
  JsonValue,
  NormalizedEvidenceItem,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { createGenerationRun } from "@/src/lib/generation-runs";
import {
  buildHighlightGenerationJsonSchema,
  highlightGenerationExampleOutput,
  highlightGenerationRepairMappings,
  highlightGenerationRequiredFields,
  highlightGenerationSchemaDescription,
  highlightGenerationSchemaName,
} from "@/src/lib/llm-json-schemas";
import { batchHighlightGenerationLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { formatTaggedSections } from "@/src/lib/structured-prompt";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import {
  buildRepairEvidenceRefHints,
  buildResearchSourceCatalog,
  normalizeResearchDrafts,
} from "@/src/services/claim-research-shared";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockClaimResearchService } from "@/src/services/mock-claim-research-service";
import type { HighlightGenerationService } from "@/src/services/types";

const MAX_BATCH_ITEMS = 4;
const highlightBatchJsonSchema = buildHighlightGenerationJsonSchema({
  minHighlights: 0,
  maxHighlights: 2,
});

function isRejectedGuidanceSource(item: NormalizedEvidenceItem) {
  return (
    typeof item.metadata === "object" &&
    item.metadata &&
    "kind" in item.metadata &&
    (item.metadata.kind === "rejected_highlight_context" ||
      item.metadata.kind === "rejected_claim_context")
  );
}

function buildRejectedGuidance(evidenceItems: NormalizedEvidenceItem[]) {
  return evidenceItems
    .filter(isRejectedGuidanceSource)
    .map((item) => item.body)
    .join("\n\n");
}

function buildBatchKey(item: NormalizedEvidenceItem) {
  return item.parentKey ?? `${item.sourceId}:${item.evidenceType}`;
}

function buildEvidenceBatches(evidenceItems: NormalizedEvidenceItem[]) {
  const grouped = new Map<string, NormalizedEvidenceItem[]>();

  for (const item of evidenceItems) {
    if (isRejectedGuidanceSource(item)) {
      continue;
    }

    const batchKey = buildBatchKey(item);
    const existing = grouped.get(batchKey) ?? [];
    existing.push(item);
    grouped.set(batchKey, existing);
  }

  return Array.from(grouped.entries()).flatMap(([batchKey, items]) => {
    const chunks: Array<{ batchKey: string; evidenceItems: NormalizedEvidenceItem[] }> = [];

    for (let index = 0; index < items.length; index += MAX_BATCH_ITEMS) {
      chunks.push({
        batchKey: `${batchKey}:${index / MAX_BATCH_ITEMS}`,
        evidenceItems: items.slice(index, index + MAX_BATCH_ITEMS),
      });
    }

    return chunks;
  });
}

function buildBatchInputSummary(params: {
  workItem: WorkItemSnapshot;
  batchKey: string;
  evidenceItems: NormalizedEvidenceItem[];
  systemPrompt: string;
  userPrompt: string;
  transportMode?: string | null;
  attempts?: JsonValue | null;
}) {
  return {
    workItemId: params.workItem.id,
    workItemTitle: params.workItem.title,
    batchKey: params.batchKey,
    evidenceCount: params.evidenceItems.length,
    totalExcerptChars: params.evidenceItems.reduce(
      (sum, item) => sum + item.excerpts.join(" ").length,
      0,
    ),
    transportMode: params.transportMode ?? null,
    transportAttempts: params.attempts ?? null,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  };
}

const bedrockHighlightGenerationService: HighlightGenerationService = {
  async generate({ workItem, evidenceItems, artifactRequest }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const rejectedHighlightGuidance = buildRejectedGuidance(evidenceItems);
    const batches = buildEvidenceBatches(evidenceItems);
    const generationRunIds: string[] = [];
    const highlights = [];

    for (const batch of batches) {
      const sourceCatalog = buildResearchSourceCatalog(batch.evidenceItems);
      const allowedEvidenceIds = new Set(
        sourceCatalog.map((sourceRef) => sourceRef.evidenceItemId),
      );
      const repairMappings = [
        ...highlightGenerationRepairMappings,
        ...buildRepairEvidenceRefHints(sourceCatalog),
      ];
      const systemPrompt = [
        "You generate Workbase reusable highlights from technical evidence.",
        "Return JSON that matches the provided schema exactly.",
        "Do not invent metrics, outcomes, ownership, or technologies that are not present in the supplied evidence.",
      ].join(" ");
      const userPrompt = formatTaggedSections([
        {
          tag: "task",
          content:
            "Generate up to 2 reusable highlights from this evidence batch. Highlights should be evidence-backed, reusable across artifacts, and narrower than a final resume bullet.",
        },
        {
          tag: "rules",
          content: [
            "Return a top-level JSON object with a `highlights` array.",
            "Each item must include text, category, confidence, ownershipClarity, summary, rationaleSummary, sourceRefs, risksSummary, missingInfo.",
            "Use `text`, not `claimText`, `title`, or `claim`.",
            "Only cite provided evidenceItemId values.",
            "It is valid to return an empty array if this evidence batch does not support a defensible highlight.",
          ].join("\n"),
        },
        {
          tag: "output_schema",
          content: JSON.stringify(highlightBatchJsonSchema, null, 2),
        },
        {
          tag: "required_fields",
          content: JSON.stringify(highlightGenerationRequiredFields, null, 2),
        },
        {
          tag: "example_output",
          content: JSON.stringify(
            {
              highlights: highlightGenerationExampleOutput.highlights.slice(0, 1),
            },
            null,
            2,
          ),
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
        ...(artifactRequest
          ? [
              {
                tag: "artifact_request",
                content: JSON.stringify(
                  {
                    type: artifactRequest.type,
                    targetAngle: artifactRequest.targetAngle,
                    tone: artifactRequest.tone,
                  },
                  null,
                  2,
                ),
              },
              {
                tag: "artifact_request_rules",
                content: [
                  "Prefer highlights that best support this artifact request.",
                  "Do not invent accomplishments just to satisfy the request.",
                  "It is better to return fewer highlights than to stretch the evidence.",
                ].join("\n"),
              },
            ]
          : []),
        {
          tag: "rejected_highlight_guidance",
          content: rejectedHighlightGuidance || "null",
        },
        {
          tag: "evidence_refs",
          content: JSON.stringify(sourceCatalog, null, 2),
        },
      ]);
      const baseInputSummary = buildBatchInputSummary({
        workItem,
        batchKey: batch.batchKey,
        evidenceItems: batch.evidenceItems,
        systemPrompt,
        userPrompt,
      });

      try {
        const result = await structuredClient.generateStructured({
          systemPrompt,
          userPrompt,
          schema: batchHighlightGenerationLlmOutputSchema,
          schemaName: highlightGenerationSchemaName,
          schemaDescription: highlightGenerationSchemaDescription,
          jsonSchema: highlightBatchJsonSchema,
          exampleOutput: {
            highlights: highlightGenerationExampleOutput.highlights.slice(0, 1),
          },
          requiredFieldPaths: highlightGenerationRequiredFields,
          repairMappings,
          maxTokens: 1800,
          extraValidation: (value) => {
            const errors: string[] = [];

            value.highlights.forEach((highlight, highlightIndex) => {
              highlight.sourceRefs.forEach((sourceRef, sourceRefIndex) => {
                const evidenceItemId =
                  typeof sourceRef === "string"
                    ? sourceRef
                    : "evidenceItemId" in sourceRef &&
                        typeof sourceRef.evidenceItemId === "string"
                      ? sourceRef.evidenceItemId
                      : "id" in sourceRef && typeof sourceRef.id === "string"
                        ? sourceRef.id
                        : null;

                if (!evidenceItemId || !allowedEvidenceIds.has(evidenceItemId)) {
                  errors.push(
                    `highlights[${highlightIndex}].sourceRefs[${sourceRefIndex}] uses an unknown evidence reference.`,
                  );
                }
              });
            });

            return errors;
          },
        });

        const drafts = normalizeResearchDrafts(result.data, sourceCatalog);
        const generationRun = await createGenerationRun({
          workItemId: workItem.id,
          kind: "highlight_generation",
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
            batchKey: batch.batchKey,
            generatedHighlightCount: drafts.length,
          } as Prisma.InputJsonValue,
          tokenUsage: (result.tokenUsage as Prisma.InputJsonValue | null) ?? null,
          estimatedCostUsd: result.estimatedCostUsd,
        });

        generationRunIds.push(generationRun.id);
        highlights.push(...drafts);
      } catch (error) {
        const failure = error instanceof StructuredOutputError ? error : null;

        await createGenerationRun({
          workItemId: workItem.id,
          kind: "highlight_generation",
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
          resultRefs: {
            batchKey: batch.batchKey,
          } as Prisma.InputJsonValue,
          tokenUsage: (failure?.tokenUsage as Prisma.InputJsonValue | null) ?? null,
          estimatedCostUsd: null,
        });

        throw error;
      }
    }

    return {
      highlights,
      generationRunIds: {
        generation: generationRunIds,
        verification: null,
      },
    };
  },
};

export const highlightGenerationService: HighlightGenerationService = {
  async generate(input) {
    if (resolveWorkbaseLlmProvider() === "mock") {
      const mockResult = await mockClaimResearchService.generate(input);

      return {
        highlights: mockResult.highlights,
        generationRunIds: mockResult.generationRunIds,
      };
    }

    return bedrockHighlightGenerationService.generate(input);
  },
};
