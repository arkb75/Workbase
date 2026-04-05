import type { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import { createGenerationRun } from "@/src/lib/generation-runs";
import {
  buildClaimResearchJsonSchema,
  claimResearchExampleOutput,
  claimResearchRepairMappings,
  claimResearchRequiredFields,
} from "@/src/lib/llm-json-schemas";
import { claimResearchLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { formatTaggedSections } from "@/src/lib/structured-prompt";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import {
  buildRepairEvidenceRefHints,
  normalizeResearchDrafts,
  readResearchRefEvidenceItemId,
  readResearchRefSourceId,
  type ResearchSourceCatalog,
} from "@/src/services/claim-research-shared";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import type { ClaimMergeService } from "@/src/services/types";
import { slugifyText } from "@/src/lib/utils";

const claimMergeJsonSchema = buildClaimResearchJsonSchema({
  minClaims: 1,
  maxClaims: 6,
});

function clipMergeText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  const truncated = value.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace >= Math.floor(maxChars * 0.6)) {
    return `${truncated.slice(0, lastSpace).trim()}…`;
  }

  return `${truncated.trim()}…`;
}

function buildMergeSourceCatalog(input: Parameters<ClaimMergeService["merge"]>[0]) {
  const catalog: ResearchSourceCatalog = [
    {
      evidenceItemId: `${input.workItem.id}-description`,
      sourceId: `${input.workItem.id}-description`,
      sourceLabel: "Work Item description",
      sourceType: "manual_note",
      title: "Work Item description",
      excerpt: input.workItem.description,
    },
  ];
  const seenEvidenceRefs = new Set<string>();

  for (const cluster of input.clusterClaims) {
    for (const claim of cluster.claims) {
      for (const sourceRef of claim.evidenceCard.sourceRefs) {
        const key = sourceRef.evidenceItemId ?? `${sourceRef.sourceId}:${sourceRef.excerpt}`;

        if (seenEvidenceRefs.has(key)) {
          continue;
        }

        seenEvidenceRefs.add(key);
        catalog.push({
          evidenceItemId: sourceRef.evidenceItemId ?? sourceRef.sourceId,
          sourceId: sourceRef.sourceId,
          sourceLabel: sourceRef.sourceLabel,
          sourceType: sourceRef.sourceType,
          title: sourceRef.title ?? sourceRef.sourceLabel,
          excerpt: sourceRef.excerpt,
        });
      }
    }
  }

  return catalog;
}

function buildClaimMergeInputSummary(params: {
  workItemId: string;
  workItemTitle: string;
  clusterCount: number;
  candidateClaimCount: number;
  sourceRefCount: number;
  transportMode?: string | null;
  attempts?: JsonValue | null;
  systemPrompt: string;
  userPrompt: string;
}) {
  return {
    workItemId: params.workItemId,
    workItemTitle: params.workItemTitle,
    clusterCount: params.clusterCount,
    candidateClaimCount: params.candidateClaimCount,
    sourceRefCount: params.sourceRefCount,
    transportMode: params.transportMode ?? null,
    transportAttempts: params.attempts ?? null,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  };
}

const bedrockClaimMergeService: ClaimMergeService = {
  async merge(input) {
    const structuredClient = getBedrockStructuredLlmClient();
    const sourceCatalog = buildMergeSourceCatalog(input);
    const repairMappings = [
      ...claimResearchRepairMappings,
      ...buildRepairEvidenceRefHints(sourceCatalog),
    ];
    const allowedSourceIds = new Set(sourceCatalog.map((sourceRef) => sourceRef.sourceId));
    const allowedEvidenceItemIds = new Set(
      sourceCatalog.map((sourceRef) => sourceRef.evidenceItemId).filter(Boolean),
    );
    const systemPrompt = [
      "You merge and refine Workbase candidate claims that were already drafted cluster by cluster.",
      "Return JSON that matches the provided schema exactly.",
      "Prefer the strongest non-overlapping claims and avoid repetitive variants.",
    ].join(" ");
    const userPrompt = formatTaggedSections([
      {
        tag: "task",
        content:
          "Select and refine up to 6 final candidate claims from the cluster-local drafts. Preserve category diversity when quality is comparable, avoid near-duplicates, and avoid taking more than 2 final claims from the same cluster unless that cluster is clearly dominant.",
      },
      {
        tag: "rules",
        content: [
          "Return a top-level JSON object with a `claims` array.",
          "Each claim object must include exactly these fields: claimText, category, confidence, ownershipClarity, evidenceSummary, rationaleSummary, sourceRefs, risksSummary, missingInfo.",
          "Use `claimText`, not `title`, `claim`, or `text`.",
          "Use `sourceRefs`, not `evidenceRefs`.",
          "Every sourceRefs item must be an object with `evidenceItemId`.",
          "Keep claimText concise and under 180 characters when possible.",
          "Keep evidenceSummary and rationaleSummary to one compact sentence each.",
          "Prefer null for risksSummary or missingInfo when no concise note is needed.",
          "Do not invent new evidence refs or uncited technologies.",
          "Only use the provided cluster-local candidate claims and evidence refs.",
        ].join("\n"),
      },
      {
        tag: "output_schema",
        content: JSON.stringify(claimMergeJsonSchema, null, 2),
      },
      {
        tag: "required_fields",
        content: JSON.stringify(claimResearchRequiredFields, null, 2),
      },
      {
        tag: "example_output",
        content: JSON.stringify(claimResearchExampleOutput, null, 2),
      },
      {
        tag: "work_item",
        content: JSON.stringify(
          {
            id: input.workItem.id,
            title: input.workItem.title,
            type: input.workItem.type,
            description: input.workItem.description,
          },
          null,
          2,
        ),
      },
      {
        tag: "rejected_claim_guidance",
        content: input.rejectedClaimGuidance ?? "null",
      },
      {
        tag: "cluster_local_candidates",
        content: JSON.stringify(
          input.clusterClaims.map((cluster) => ({
            clusterId: cluster.clusterId,
            clusterTitle: cluster.clusterTitle,
            clusterTheme: cluster.clusterTheme,
            clusterConfidence: cluster.clusterConfidence,
            claims: cluster.claims.map((claim) => ({
              claimText: claim.text,
              category: claim.category,
              confidence: claim.confidence,
              ownershipClarity: claim.ownershipClarity,
              evidenceSummary: clipMergeText(claim.evidenceCard.evidenceSummary, 220),
              sourceRefs: claim.evidenceCard.sourceRefs.map((sourceRef) => ({
                evidenceItemId: sourceRef.evidenceItemId,
              })),
            })),
          })),
          null,
          2,
        ),
      },
      {
        tag: "available_evidence_refs",
        content: JSON.stringify(sourceCatalog, null, 2),
      },
    ]);
    const baseInputSummary = buildClaimMergeInputSummary({
      workItemId: input.workItem.id,
      workItemTitle: input.workItem.title,
      clusterCount: input.clusterClaims.length,
      candidateClaimCount: input.clusterClaims.reduce(
        (sum, cluster) => sum + cluster.claims.length,
        0,
      ),
      sourceRefCount: sourceCatalog.length,
      systemPrompt,
      userPrompt,
    });

    try {
      const result = await structuredClient.generateStructured({
        systemPrompt,
        userPrompt,
        schema: claimResearchLlmOutputSchema,
        schemaName: "workbase_claim_merge",
        schemaDescription:
          "Merged final Workbase claim drafts selected from cluster-local candidate claims.",
        jsonSchema: claimMergeJsonSchema,
        exampleOutput: claimResearchExampleOutput,
        requiredFieldPaths: claimResearchRequiredFields,
        repairMappings,
        maxTokens: 2800,
        extraValidation: (value) => {
          const errors: string[] = [];
          const fingerprints = new Set<string>();

          value.claims.forEach((claim, claimIndex) => {
            const fingerprint = slugifyText(claim.claimText);

            if (fingerprints.has(fingerprint)) {
              errors.push(`claims[${claimIndex}] duplicates another claim text.`);
            }

            fingerprints.add(fingerprint);

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

      const claims = normalizeResearchDrafts(result.data, sourceCatalog);
      const generationRun = await createGenerationRun({
        workItemId: input.workItem.id,
        kind: "claim_merge",
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
          mergedClaimCount: claims.length,
        } as Prisma.InputJsonValue,
        tokenUsage: (result.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: result.estimatedCostUsd,
      });

      return {
        claims,
        generationRunId: generationRun.id,
      };
    } catch (error) {
      const failure = error instanceof StructuredOutputError ? error : null;

      await createGenerationRun({
        workItemId: input.workItem.id,
        kind: "claim_merge",
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

export const claimMergeService: ClaimMergeService = {
  async merge(input) {
    if (resolveWorkbaseLlmProvider() === "mock") {
      return {
        claims: input.clusterClaims.flatMap((cluster) => cluster.claims).slice(0, 6),
        generationRunId: null,
      };
    }

    return bedrockClaimMergeService.merge(input);
  },
};
