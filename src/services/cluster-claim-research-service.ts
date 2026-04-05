import type { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import { createGenerationRun } from "@/src/lib/generation-runs";
import {
  buildClaimResearchJsonSchema,
  claimResearchExampleOutput,
  claimResearchRepairMappings,
  claimResearchRequiredFields,
} from "@/src/lib/llm-json-schemas";
import { clusterClaimResearchLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { formatTaggedSections } from "@/src/lib/structured-prompt";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import {
  buildRepairEvidenceRefHints,
  buildResearchSourceCatalog,
  normalizeResearchDrafts,
  readResearchRefEvidenceItemId,
  readResearchRefSourceId,
} from "@/src/services/claim-research-shared";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import type { ClusterClaimResearchService } from "@/src/services/types";

const clusterClaimResearchJsonSchema = buildClaimResearchJsonSchema({
  minClaims: 0,
  maxClaims: 2,
});

function buildClusterResearchInputSummary(params: {
  workItemId: string;
  workItemTitle: string;
  clusterId: string;
  clusterTitle: string;
  evidenceCount: number;
  totalExcerptChars: number;
  systemPrompt: string;
  userPrompt: string;
  transportMode?: string | null;
  attempts?: JsonValue | null;
}) {
  return {
    workItemId: params.workItemId,
    workItemTitle: params.workItemTitle,
    clusterId: params.clusterId,
    clusterTitle: params.clusterTitle,
    evidenceCount: params.evidenceCount,
    totalExcerptChars: params.totalExcerptChars,
    transportMode: params.transportMode ?? null,
    transportAttempts: params.attempts ?? null,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  };
}

const bedrockClusterClaimResearchService: ClusterClaimResearchService = {
  async generate({ workItem, cluster, evidenceItems, rejectedClaimGuidance }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const sourceCatalog = buildResearchSourceCatalog(workItem, evidenceItems);
    const repairMappings = [
      ...claimResearchRepairMappings,
      ...buildRepairEvidenceRefHints(sourceCatalog),
    ];
    const allowedSourceIds = new Set(sourceCatalog.map((sourceRef) => sourceRef.sourceId));
    const allowedEvidenceItemIds = new Set(
      sourceCatalog.map((sourceRef) => sourceRef.evidenceItemId),
    );
    const systemPrompt = [
      "You generate Workbase candidate claims from one technical work cluster.",
      "Return JSON that matches the provided schema exactly.",
      "Do not invent impact, metrics, ownership, or technologies that are not present in the supplied evidence.",
    ].join(" ");
    const userPrompt = formatTaggedSections([
      {
        tag: "task",
        content:
          "Generate up to 2 cluster-local candidate claims. Use only this cluster and its cited evidence refs. Prefer concrete implementation wording over hype.",
      },
      {
        tag: "rules",
        content: [
          "Return a top-level JSON object with a `claims` array.",
          "Each claim object must include exactly these fields: claimText, category, confidence, ownershipClarity, evidenceSummary, rationaleSummary, sourceRefs, risksSummary, missingInfo.",
          "Use `claimText`, not `title`, `claim`, or `text`.",
          "Use `sourceRefs`, not `evidenceRefs`.",
          "Every sourceRefs item must be an object with `evidenceItemId`.",
          "Only cite the provided evidenceItemId values.",
          "It is valid to return an empty `claims` array if this cluster does not support a defensible claim.",
        ].join("\n"),
      },
      {
        tag: "output_schema",
        content: JSON.stringify(clusterClaimResearchJsonSchema, null, 2),
      },
      {
        tag: "required_fields",
        content: JSON.stringify(claimResearchRequiredFields, null, 2),
      },
      {
        tag: "example_output",
        content: JSON.stringify(
          {
            claims: claimResearchExampleOutput.claims.slice(0, 1),
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
      {
        tag: "cluster",
        content: JSON.stringify(
          {
            clusterId: cluster.id,
            title: cluster.title,
            summary: cluster.summary,
            theme: cluster.theme,
            confidence: cluster.confidence,
          },
          null,
          2,
        ),
      },
      {
        tag: "rejected_claim_guidance",
        content: rejectedClaimGuidance ?? "null",
      },
      {
        tag: "evidence_refs",
        content: JSON.stringify(sourceCatalog, null, 2),
      },
    ]);
    const baseInputSummary = buildClusterResearchInputSummary({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      clusterId: cluster.id,
      clusterTitle: cluster.title,
      evidenceCount: evidenceItems.length,
      totalExcerptChars: sourceCatalog.reduce(
        (sum, sourceRef) => sum + sourceRef.excerpt.length,
        0,
      ),
      systemPrompt,
      userPrompt,
    });

    try {
      const result = await structuredClient.generateStructured({
        systemPrompt,
        userPrompt,
        schema: clusterClaimResearchLlmOutputSchema,
        schemaName: "workbase_claim_cluster_research",
        schemaDescription:
          "Cluster-local Workbase claim drafts grounded in one evidence cluster.",
        jsonSchema: clusterClaimResearchJsonSchema,
        exampleOutput: {
          claims: claimResearchExampleOutput.claims.slice(0, 1),
        },
        requiredFieldPaths: claimResearchRequiredFields,
        repairMappings,
        maxTokens: 1500,
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
        kind: "claim_cluster_research",
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
          clusterId: cluster.id,
          generatedClaimCount: drafts.length,
        } as Prisma.InputJsonValue,
        tokenUsage: (result.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: result.estimatedCostUsd,
      });

      return {
        claims: drafts,
        generationRunId: generationRun.id,
      };
    } catch (error) {
      const failure = error instanceof StructuredOutputError ? error : null;

      await createGenerationRun({
        workItemId: workItem.id,
        kind: "claim_cluster_research",
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
          clusterId: cluster.id,
        } as Prisma.InputJsonValue,
        tokenUsage: (failure?.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: null,
      });

      throw error;
    }
  },
};

export const clusterClaimResearchService: ClusterClaimResearchService = {
  async generate(input) {
    if (resolveWorkbaseLlmProvider() === "mock") {
      return {
        claims: [],
        generationRunId: null,
      };
    }

    return bedrockClusterClaimResearchService.generate(input);
  },
};
