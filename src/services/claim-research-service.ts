import type { Prisma } from "@/src/generated/prisma/client";
import type {
  ClaimDraft,
  JsonValue,
  NormalizedEvidenceItem,
} from "@/src/domain/types";
import { attachGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { createGenerationRun } from "@/src/lib/generation-runs";
import { claimResearchLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { toSentence } from "@/src/lib/utils";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import type { ClaimResearchService } from "@/src/services/types";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockClaimResearchService } from "@/src/services/mock-claim-research-service";

function isRejectedGuidanceSource(source: NormalizedEvidenceItem) {
  return (
    typeof source.metadata === "object" &&
    source.metadata &&
    "kind" in source.metadata &&
    source.metadata.kind === "rejected_claim_context"
  );
}

function buildResearchSourceCatalog(
  workItemId: string,
  evidenceItems: NormalizedEvidenceItem[],
) {
  return [
    {
      evidenceItemId: `${workItemId}-description`,
      sourceId: `${workItemId}-description`,
      sourceLabel: "Work Item description",
      sourceType: "manual_note" as const,
      title: "Work Item description",
      excerpt: "",
    },
    ...evidenceItems
      .filter((item) => !isRejectedGuidanceSource(item))
      .map((item) => ({
        evidenceItemId: item.id,
        sourceId: item.sourceId,
        sourceLabel:
          typeof item.metadata === "object" &&
          item.metadata &&
          "sourceLabel" in item.metadata &&
          typeof item.metadata.sourceLabel === "string"
            ? item.metadata.sourceLabel
            : item.label,
        sourceType: item.type,
        title: item.label,
        excerpt: toSentence(item.excerpts[0] ?? item.body),
      })),
  ];
}

function buildRejectedGuidance(evidenceItems: NormalizedEvidenceItem[]) {
  return evidenceItems
    .filter(isRejectedGuidanceSource)
    .map((source) => source.body)
    .join("\n\n");
}

function readResearchRefEvidenceItemId(
  sourceRef:
    | {
        evidenceItemId?: string;
        sourceId: string;
        sourceLabel: string;
        sourceType: "manual_note" | "github_repo";
        title?: string;
        excerpt: string;
      }
    | { evidenceItemId: string }
    | { id: string }
    | { sourceId: string }
    | string,
) {
  if (typeof sourceRef === "string") {
    return sourceRef;
  }

  if ("evidenceItemId" in sourceRef && typeof sourceRef.evidenceItemId === "string") {
    return sourceRef.evidenceItemId;
  }

  if ("id" in sourceRef && typeof sourceRef.id === "string") {
    return sourceRef.id;
  }

  return null;
}

function readResearchRefSourceId(
  sourceRef:
    | {
        evidenceItemId?: string;
        sourceId: string;
        sourceLabel: string;
        sourceType: "manual_note" | "github_repo";
        title?: string;
        excerpt: string;
      }
    | { evidenceItemId: string }
    | { id: string }
    | { sourceId: string }
    | string,
) {
  if (typeof sourceRef === "string") {
    return null;
  }

  if ("sourceId" in sourceRef && typeof sourceRef.sourceId === "string") {
    return sourceRef.sourceId;
  }

  return null;
}

function buildResearchInputSummary(params: {
  workItemId: string;
  workItemTitle: string;
  sourceCatalog: ReturnType<typeof buildResearchSourceCatalog>;
  clusterCount: number;
  rejectedGuidance: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  return {
    workItemId: params.workItemId,
    workItemTitle: params.workItemTitle,
    sourceRefCount: params.sourceCatalog.length,
    clusterCount: params.clusterCount,
    rejectedGuidancePresent: Boolean(params.rejectedGuidance),
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  } as JsonValue;
}

function normalizeResearchDrafts(
  output: {
    claims: Array<{
      text?: string;
      claimText?: string;
      category?: string | null;
      confidence: "low" | "medium" | "high";
      ownershipClarity: "unclear" | "partial" | "clear";
      evidenceSummary: string;
      rationaleSummary: string;
      risksSummary?: string | null;
      missingInfo?: string | null;
      sourceRefs: Array<
        | {
            evidenceItemId?: string;
            sourceId: string;
            sourceLabel: string;
            sourceType: "manual_note" | "github_repo";
            title?: string;
            excerpt: string;
          }
        | { evidenceItemId: string }
        | { id: string }
        | { sourceId: string }
        | string
      >;
    }>;
  },
  sourceCatalog: ReturnType<typeof buildResearchSourceCatalog>,
) {
  const sourceCatalogByEvidenceItemId = new Map<string, (typeof sourceCatalog)[number]>();
  const sourceCatalogBySourceId = new Map<string, (typeof sourceCatalog)[number]>();

  for (const sourceRef of sourceCatalog) {
    if (!sourceCatalogByEvidenceItemId.has(sourceRef.evidenceItemId)) {
      sourceCatalogByEvidenceItemId.set(sourceRef.evidenceItemId, sourceRef);
    }

    if (!sourceCatalogBySourceId.has(sourceRef.sourceId)) {
      sourceCatalogBySourceId.set(sourceRef.sourceId, sourceRef);
    }
  }

  return output.claims.map<ClaimDraft>((claim) => ({
    text: toSentence(claim.text ?? claim.claimText ?? ""),
    category: claim.category ?? null,
    confidence: claim.confidence,
    ownershipClarity: claim.ownershipClarity,
    sensitivityFlag: false,
    verificationStatus: "draft",
    visibility: "resume_safe",
    risksSummary: claim.risksSummary ?? null,
    missingInfo: claim.missingInfo ?? null,
    rejectionReason: null,
    evidenceCard: {
      evidenceSummary: claim.evidenceSummary,
      rationaleSummary: claim.rationaleSummary,
      sourceRefs: claim.sourceRefs.flatMap((sourceRef) => {
        const evidenceItemId = readResearchRefEvidenceItemId(sourceRef);
        const sourceId = readResearchRefSourceId(sourceRef);
        const catalogRef =
          (evidenceItemId ? sourceCatalogByEvidenceItemId.get(evidenceItemId) : null) ??
          (sourceId ? sourceCatalogBySourceId.get(sourceId) : null);

        if (
          typeof sourceRef !== "string" &&
          "sourceLabel" in sourceRef &&
          "sourceType" in sourceRef &&
          "excerpt" in sourceRef
        ) {
          return [
            {
              evidenceItemId:
                "evidenceItemId" in sourceRef && typeof sourceRef.evidenceItemId === "string"
                  ? sourceRef.evidenceItemId
                  : catalogRef?.evidenceItemId,
              sourceId: sourceRef.sourceId,
              sourceLabel: sourceRef.sourceLabel,
              sourceType: sourceRef.sourceType,
              title:
                "title" in sourceRef && typeof sourceRef.title === "string"
                  ? sourceRef.title
                  : catalogRef?.title,
              excerpt: toSentence(sourceRef.excerpt),
            },
          ];
        }

        if (!catalogRef) {
          return [];
        }

        return [
          {
            evidenceItemId: catalogRef.evidenceItemId,
            sourceId: catalogRef.sourceId,
            sourceLabel: catalogRef.sourceLabel,
            sourceType: catalogRef.sourceType,
            title: catalogRef.title,
            excerpt: toSentence(catalogRef.excerpt),
          },
        ];
      }),
      verificationNotes:
        [claim.missingInfo, claim.risksSummary].filter(Boolean).join(" ").trim() ||
        "Review wording against the cited source excerpts before approval.",
    },
  }));
}

const bedrockClaimResearchService: ClaimResearchService = {
  async generate({ workItem, evidenceItems, clusters }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const sourceCatalog = buildResearchSourceCatalog(workItem.id, evidenceItems).map((sourceRef) =>
      sourceRef.evidenceItemId === `${workItem.id}-description`
        ? {
            ...sourceRef,
            excerpt: toSentence(workItem.description),
          }
        : sourceRef,
    );
    const rejectedGuidance = buildRejectedGuidance(evidenceItems);
    const allowedSourceIds = new Set(sourceCatalog.map((sourceRef) => sourceRef.sourceId));
    const allowedEvidenceItemIds = new Set(
      sourceCatalog.map((sourceRef) => sourceRef.evidenceItemId),
    );
    const systemPrompt = [
      "You generate Workbase candidate claims from technical evidence.",
      "Return strict JSON only.",
      "Do not invent metrics, outcomes, ownership, or technologies not present in the provided evidence.",
      "Each claim must cite at least one provided evidence reference.",
      "Do not restate or re-propose claims listed in the rejected-claim guidance.",
    ].join(" ");
    const userPrompt = JSON.stringify(
      {
        task: "Generate up to 6 candidate claims for Workbase.",
        outputRequirements: {
          categoryOptions: [
            "general",
            "ai_ml",
            "data_engineering",
            "backend",
            "full_stack",
          ],
          notes: [
            "Every claim must stay grounded in the supplied evidence.",
            "Prefer concrete implementation wording over hype.",
            "Use only the source references provided here.",
          ],
        },
        workItem: {
          id: workItem.id,
          title: workItem.title,
          type: workItem.type,
          description: workItem.description,
        },
        clusters: clusters.map((cluster) => ({
          clusterId: cluster.id,
          title: cluster.title,
          summary: cluster.summary,
          theme: cluster.theme,
          confidence: cluster.confidence,
          evidenceItemIds: cluster.items.map((item) => item.evidenceItemId),
        })),
        rejectedClaimGuidance: rejectedGuidance || null,
        availableEvidenceRefs: sourceCatalog,
      },
      null,
      2,
    );
    const inputSummary = buildResearchInputSummary({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      sourceCatalog,
      clusterCount: clusters.length,
      rejectedGuidance,
      systemPrompt,
      userPrompt,
    });

    try {
      const result = await structuredClient.generateStructured({
        systemPrompt,
        userPrompt,
        schema: claimResearchLlmOutputSchema,
        maxTokens: 2200,
        extraValidation: (value) => {
          const errors: string[] = [];

          value.claims.forEach((claim, claimIndex) => {
            claim.sourceRefs.forEach((sourceRef, sourceRefIndex) => {
              const evidenceItemId = readResearchRefEvidenceItemId(sourceRef);
              const sourceId = readResearchRefSourceId(sourceRef);

              if (
                !(evidenceItemId && allowedEvidenceItemIds.has(evidenceItemId)) &&
                !(sourceId && allowedSourceIds.has(sourceId))
              ) {
                errors.push(
                  `claims[${claimIndex}].sourceRefs[${sourceRefIndex}] uses an unknown evidence reference.`,
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
        kind: "claim_research",
        status: "success",
        provider: result.provider,
        modelId: result.modelId,
        inputSummary: inputSummary as Prisma.InputJsonValue,
        rawOutput: result.rawOutput,
        parsedOutput: result.parsedOutput as Prisma.InputJsonValue,
        validationErrors: null,
        resultRefs: null,
        tokenUsage: (result.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: result.estimatedCostUsd,
      });

      return attachGenerationRunMetadata(drafts, {
        id: generationRun.id,
        kind: "claim_research",
      });
    } catch (error) {
      const failure = error instanceof StructuredOutputError ? error : null;

      await createGenerationRun({
        workItemId: workItem.id,
        kind: "claim_research",
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

export const claimResearchService: ClaimResearchService = {
  async generate(input) {
    if (resolveWorkbaseLlmProvider() === "mock") {
      return mockClaimResearchService.generate(input);
    }

    return bedrockClaimResearchService.generate(input);
  },
};
