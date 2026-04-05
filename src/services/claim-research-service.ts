import type { EvidenceClusterSnapshot, NormalizedEvidenceItem } from "@/src/domain/types";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import {
  buildRejectedGuidance,
  isRejectedGuidanceSource,
} from "@/src/services/claim-research-shared";
import { claimMergeService } from "@/src/services/claim-merge-service";
import { clusterClaimResearchService } from "@/src/services/cluster-claim-research-service";
import { mockClaimResearchService } from "@/src/services/mock-claim-research-service";
import type { ClaimResearchService } from "@/src/services/types";

const MAX_CLUSTER_EVIDENCE_ITEMS = 6;

function selectClusterEvidenceItems(params: {
  cluster: EvidenceClusterSnapshot;
  normalizedEvidenceById: Map<string, NormalizedEvidenceItem>;
}) {
  return [...params.cluster.items]
    .sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0))
    .map((item) => params.normalizedEvidenceById.get(item.evidenceItemId) ?? null)
    .filter((item): item is NormalizedEvidenceItem => Boolean(item))
    .slice(0, MAX_CLUSTER_EVIDENCE_ITEMS);
}

const bedrockClaimResearchService: ClaimResearchService = {
  async generate({ workItem, evidenceItems, clusters }) {
    const rejectedClaimGuidance = buildRejectedGuidance(evidenceItems);
    const includedEvidenceItems = evidenceItems.filter((item) => !isRejectedGuidanceSource(item));

    if (!clusters.length) {
      throw new Error("No persisted evidence clusters are available for claim generation.");
    }

    const normalizedEvidenceById = new Map(
      includedEvidenceItems.map((item) => [item.id, item] as const),
    );
    const clusterResearchResults = await Promise.all(
      clusters.map(async (cluster) => {
        const clusterEvidenceItems = selectClusterEvidenceItems({
          cluster,
          normalizedEvidenceById,
        });

        if (!clusterEvidenceItems.length) {
          return {
            clusterId: cluster.id,
            clusterTitle: cluster.title,
            clusterTheme: cluster.theme,
            clusterConfidence: cluster.confidence,
            claims: [],
            generationRunId: null as string | null,
          };
        }

        const result = await clusterClaimResearchService.generate({
          workItem,
          cluster,
          evidenceItems: clusterEvidenceItems,
          rejectedClaimGuidance,
        });

        return {
          clusterId: cluster.id,
          clusterTitle: cluster.title,
          clusterTheme: cluster.theme,
          clusterConfidence: cluster.confidence,
          claims: result.claims,
          generationRunId: result.generationRunId,
        };
      }),
    );

    const populatedClusterClaims = clusterResearchResults.filter(
      (cluster) => cluster.claims.length > 0,
    );

    if (!populatedClusterClaims.length) {
      throw new Error("No defensible cluster-local claims could be generated.");
    }

    const mergedClaims = await claimMergeService.merge({
      workItem,
      clusters,
      clusterClaims: populatedClusterClaims,
      rejectedClaimGuidance,
    });

    return {
      claims: mergedClaims.claims,
      generationRunIds: {
        clusterResearch: clusterResearchResults
          .map((cluster) => cluster.generationRunId)
          .filter((generationRunId): generationRunId is string => Boolean(generationRunId)),
        merge: mergedClaims.generationRunId,
      },
    };
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
