import type { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import { buildClaimGenerationDrafts } from "@/src/domain/workbase-workflows";
import {
  createHighlightWithRelations,
  syncManualEvidenceItemsForWorkItem,
  syncWorkItemDescriptionEvidenceForWorkItem,
} from "@/src/lib/evidence-persistence";
import { updateGenerationRunResultRefs } from "@/src/lib/generation-runs";
import { coerceHighlightTagAssignments } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import { buildHighlightEmbeddingText, upsertHighlightEmbedding } from "@/src/services/highlight-embedding-service";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";

const BOOTSTRAP_RETRY_WINDOW_MS = 10 * 60 * 1000;

function mapWorkItemSnapshot(workItem: {
  id: string;
  userId: string;
  title: string;
  type: "project" | "experience";
  description: string;
  startDate: Date | null;
  endDate: Date | null;
}) {
  return {
    id: workItem.id,
    userId: workItem.userId,
    title: workItem.title,
    type: workItem.type,
    description: workItem.description,
    startDate: workItem.startDate,
    endDate: workItem.endDate,
  };
}

function mapSourceSnapshot(source: {
  id: string;
  workItemId: string;
  type: "manual_note" | "github_repo" | "chat_context";
  label: string;
  externalId: string | null;
  rawContent: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: source.id,
    workItemId: source.workItemId,
    type: source.type,
    label: source.label,
    externalId: source.externalId,
    rawContent: source.rawContent,
    metadata: (source.metadata as JsonValue | null) ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function mapEvidenceItemSnapshot(item: {
  id: string;
  workItemId: string;
  sourceId: string;
  externalId: string;
  type:
    | "manual_note_excerpt"
    | "github_readme"
    | "github_commit"
    | "github_pull_request"
    | "github_issue"
    | "github_release"
    | "chat_user_statement"
    | "github_file_excerpt";
  title: string;
  content: string;
  searchText: string;
  parentKind: string | null;
  parentKey: string | null;
  included: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  source: {
    id: string;
    label: string;
    type: "manual_note" | "github_repo" | "chat_context";
    externalId: string | null;
  };
  tags?: Array<{
    dimension: "domain" | "competency" | "emphasis" | "audience_fit";
    tag: string;
    score: number | null;
  }>;
}) {
  return {
    id: item.id,
    workItemId: item.workItemId,
    sourceId: item.sourceId,
    externalId: item.externalId,
    type: item.type,
    title: item.title,
    content: item.content,
    searchText: item.searchText,
    parentKind: item.parentKind,
    parentKey: item.parentKey,
    included: item.included,
    metadata: (item.metadata as JsonValue | null) ?? null,
    source: {
      id: item.source.id,
      label: item.source.label,
      type: item.source.type,
      externalId: item.source.externalId,
    },
    tags: coerceHighlightTagAssignments(
      item.tags?.map((tag) => ({
        dimension: tag.dimension,
        tag: tag.tag,
        score: tag.score,
      })) ?? [],
    ),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

type BootstrapDbClient = typeof prisma | Prisma.TransactionClient;

async function getBootstrapGenerationContext(
  db: BootstrapDbClient,
  userId: string,
  workItemId: string,
) {
  return db.workItem.findFirstOrThrow({
    where: {
      id: workItemId,
      userId,
    },
    include: {
      sources: {
        orderBy: {
          createdAt: "asc",
        },
      },
      evidenceItems: {
        include: {
          source: true,
          tags: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      },
      highlights: true,
      generationRuns: {
        where: {
          kind: {
            in: ["highlight_generation", "highlight_verification"],
          },
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      },
    },
  });
}

function hasRecentFailedBootstrapAttempt(
  workItem: Awaited<ReturnType<typeof getBootstrapGenerationContext>>,
) {
  const latestRun = workItem.generationRuns[0];

  if (!latestRun || latestRun.status === "success") {
    return false;
  }

  return Date.now() - latestRun.createdAt.getTime() < BOOTSTRAP_RETRY_WINDOW_MS;
}

async function persistBootstrapPlan(params: {
  tx: Prisma.TransactionClient;
  workItemId: string;
  claimPlan: Awaited<ReturnType<typeof buildClaimGenerationDrafts>>;
}) {
  const createdHighlights: Array<{
    id: string;
    draft: Awaited<ReturnType<typeof buildClaimGenerationDrafts>>["drafts"][number];
  }> = [];

  for (const draft of params.claimPlan.drafts) {
    const createdHighlight = await createHighlightWithRelations({
      tx: params.tx,
      workItemId: params.workItemId,
      draft,
    });

    createdHighlights.push({
      id: createdHighlight.id,
      draft,
    });
  }

  return createdHighlights;
}

export async function ensureHighlightsForWorkItem(input: {
  userId: string;
  workItemId: string;
}) {
  await syncManualEvidenceItemsForWorkItem(input.workItemId);
  await syncWorkItemDescriptionEvidenceForWorkItem(input.workItemId);

  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
      SELECT "id"
      FROM "WorkItem"
      WHERE "id" = ${input.workItemId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;

      const workItem = await getBootstrapGenerationContext(
        tx,
        input.userId,
        input.workItemId,
      );

      if (
        workItem.highlights.length ||
        hasRecentFailedBootstrapAttempt(workItem)
      ) {
        return {
          attempted: false,
          createdHighlights: [],
          generationRunIds: [] as string[],
        };
      }

      const includedEvidenceItems = workItem.evidenceItems
        .map(mapEvidenceItemSnapshot)
        .filter((item) => item.included);

      if (!includedEvidenceItems.length) {
        return {
          attempted: false,
          createdHighlights: [],
          generationRunIds: [] as string[],
        };
      }

      const claimPlan = await buildClaimGenerationDrafts({
        workItem: mapWorkItemSnapshot(workItem),
        sources: workItem.sources.map(mapSourceSnapshot),
        evidenceItems: includedEvidenceItems,
        existingClaims: [],
        sourceIngestionService,
        claimResearchService,
        claimVerificationService,
      });
      const createdHighlights = await persistBootstrapPlan({
        tx,
        workItemId: workItem.id,
        claimPlan,
      });

      return {
        attempted: true,
        createdHighlights,
        generationRunIds: [
          ...claimPlan.generationRunIds.generation,
          claimPlan.generationRunIds.verification,
        ].filter((generationRunId): generationRunId is string =>
          Boolean(generationRunId),
        ),
      };
    },
    {
      maxWait: 120_000,
      timeout: 120_000,
    },
  );

  await Promise.all(
    result.createdHighlights.map((highlight) =>
      upsertHighlightEmbedding({
        highlightId: highlight.id,
        inputText: buildHighlightEmbeddingText(highlight.draft),
      }),
    ),
  );

  await Promise.allSettled(
    result.generationRunIds.map((generationRunId) =>
      updateGenerationRunResultRefs(generationRunId, {
        persistedHighlightIds: result.createdHighlights.map(
          (highlight) => highlight.id,
        ),
        bootstrapBackfill: true,
      } as Prisma.InputJsonValue),
    ),
  );

  return {
    attempted: result.attempted,
    created: result.createdHighlights.length,
  };
}

export async function ensureHighlightsForZeroHighlightWorkItems(userId: string) {
  const workItems = await prisma.workItem.findMany({
    where: {
      userId,
      highlights: {
        none: {},
      },
      evidenceItems: {
        some: {
          included: true,
        },
      },
    },
    select: {
      id: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });
  const results = [];

  for (const workItem of workItems) {
    try {
      results.push(
        await ensureHighlightsForWorkItem({
          userId,
          workItemId: workItem.id,
        }),
      );
    } catch (error) {
      console.error("Automatic highlight bootstrap failed", {
        workItemId: workItem.id,
        error,
      });
      results.push({
        attempted: true,
        created: 0,
      });
    }
  }

  return {
    checked: workItems.length,
    attempted: results.filter((result) => result.attempted).length,
    created: results.reduce((sum, result) => sum + result.created, 0),
  };
}
