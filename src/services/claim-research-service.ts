import type { Prisma } from "@/src/generated/prisma/client";
import type { ClaimDraft, JsonValue, NormalizedSource } from "@/src/domain/types";
import { attachGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { createGenerationRun } from "@/src/lib/generation-runs";
import { claimResearchLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { toSentence } from "@/src/lib/utils";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import type { ClaimResearchService } from "@/src/services/types";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockClaimResearchService } from "@/src/services/mock-claim-research-service";

function isRejectedGuidanceSource(source: NormalizedSource) {
  return (
    typeof source.metadata === "object" &&
    source.metadata &&
    "kind" in source.metadata &&
    source.metadata.kind === "rejected_claim_context"
  );
}

function buildResearchSourceCatalog(workItemId: string, sources: NormalizedSource[]) {
  const workSources = sources.filter((source) => !isRejectedGuidanceSource(source));
  const sourceCatalog = workSources.flatMap((source) =>
    (source.excerpts.length ? source.excerpts : [source.body]).slice(0, 4).map((excerpt) => ({
      sourceId: source.id,
      sourceLabel: source.label,
      sourceType: source.type,
      excerpt: toSentence(excerpt),
    })),
  );

  return [
    {
      sourceId: `${workItemId}-description`,
      sourceLabel: "Work Item description",
      sourceType: "manual_note" as const,
      excerpt: "",
    },
    ...sourceCatalog,
  ];
}

function buildRejectedGuidance(sources: NormalizedSource[]) {
  return sources
    .filter(isRejectedGuidanceSource)
    .map((source) => source.body)
    .join("\n\n");
}

function buildResearchInputSummary(params: {
  workItemId: string;
  workItemTitle: string;
  sourceCatalog: ReturnType<typeof buildResearchSourceCatalog>;
  rejectedGuidance: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  return {
    workItemId: params.workItemId,
    workItemTitle: params.workItemTitle,
    sourceRefCount: params.sourceCatalog.length,
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
            sourceId: string;
            sourceLabel: string;
            sourceType: "manual_note" | "github_repo";
            excerpt: string;
          }
        | { id: string }
        | { sourceId: string }
        | string
      >;
    }>;
  },
  sourceCatalog: ReturnType<typeof buildResearchSourceCatalog>,
) {
  const sourceCatalogById = new Map<string, (typeof sourceCatalog)[number]>();

  for (const sourceRef of sourceCatalog) {
    if (!sourceCatalogById.has(sourceRef.sourceId)) {
      sourceCatalogById.set(sourceRef.sourceId, sourceRef);
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
        const sourceId =
          typeof sourceRef === "string"
            ? sourceRef
            : "id" in sourceRef
              ? sourceRef.id
              : sourceRef.sourceId;
        const catalogRef = sourceCatalogById.get(sourceId);

        if (
          typeof sourceRef !== "string" &&
          "sourceLabel" in sourceRef &&
          "sourceType" in sourceRef &&
          "excerpt" in sourceRef
        ) {
          return [
            {
              sourceId: sourceRef.sourceId,
              sourceLabel: sourceRef.sourceLabel,
              sourceType: sourceRef.sourceType,
              excerpt: toSentence(sourceRef.excerpt),
            },
          ];
        }

        if (!catalogRef) {
          return [];
        }

        return [
          {
            sourceId: catalogRef.sourceId,
            sourceLabel: catalogRef.sourceLabel,
            sourceType: catalogRef.sourceType,
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
  async generate({ workItem, sources }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const sourceCatalog = buildResearchSourceCatalog(workItem.id, sources).map((sourceRef) =>
      sourceRef.sourceId === `${workItem.id}-description`
        ? {
            ...sourceRef,
            excerpt: toSentence(workItem.description),
          }
        : sourceRef,
    );
    const rejectedGuidance = buildRejectedGuidance(sources);
    const allowedSourceIds = new Set(sourceCatalog.map((sourceRef) => sourceRef.sourceId));
    const systemPrompt = [
      "You generate Workbase candidate claims from technical evidence.",
      "Return strict JSON only.",
      "Do not invent metrics, outcomes, ownership, or technologies not present in the provided evidence.",
      "Each claim must cite at least one provided source reference.",
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
        rejectedClaimGuidance: rejectedGuidance || null,
        availableSourceRefs: sourceCatalog,
      },
      null,
      2,
    );
    const inputSummary = buildResearchInputSummary({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      sourceCatalog,
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
              const sourceId =
                typeof sourceRef === "string"
                  ? sourceRef
                  : "id" in sourceRef
                    ? sourceRef.id
                    : sourceRef.sourceId;

              if (!allowedSourceIds.has(sourceId)) {
                errors.push(
                  `claims[${claimIndex}].sourceRefs[${sourceRefIndex}] uses an unknown sourceId: ${sourceId}.`,
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
