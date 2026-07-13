import type { Prisma } from "@/src/generated/prisma/client";
import {
  KNOWLEDGE_REVIEW_CARD_LIMIT,
  PROVENANCE_REVIEW_CARD_LIMIT,
} from "@/src/lib/knowledge-review-inbox";
import { prisma } from "@/src/lib/prisma";

function toSortTime(value: Date | null) {
  return value?.getTime() ?? Number.NEGATIVE_INFINITY;
}

function compareWorkItemsByTimeline<
  T extends {
    startDate: Date | null;
    endDate: Date | null;
    updatedAt: Date;
  },
>(left: T, right: T) {
  const leftIsCurrent = left.startDate && !left.endDate ? 1 : 0;
  const rightIsCurrent = right.startDate && !right.endDate ? 1 : 0;

  if (leftIsCurrent !== rightIsCurrent) {
    return rightIsCurrent - leftIsCurrent;
  }

  const startDelta = toSortTime(right.startDate) - toSortTime(left.startDate);

  if (startDelta !== 0) {
    return startDelta;
  }

  const endDelta = toSortTime(right.endDate) - toSortTime(left.endDate);

  if (endDelta !== 0) {
    return endDelta;
  }

  return right.updatedAt.getTime() - left.updatedAt.getTime();
}

export async function listWorkItemsForUser(userId: string) {
  const workItems = await prisma.workItem.findMany({
    where: {
      userId,
    },
    include: {
      highlights: true,
      sources: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  return workItems.sort(compareWorkItemsByTimeline);
}

export async function getWorkItemForUser(userId: string, workItemId: string) {
  const workItem = await prisma.workItem.findFirstOrThrow({
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
      highlights: {
        include: {
          evidence: {
            include: {
              evidenceItem: {
                include: {
                  source: true,
                },
              },
            },
          },
          tags: true,
        },
        orderBy: [
          {
            verificationStatus: "asc",
          },
          {
            updatedAt: "desc",
          },
        ],
      },
      projectFacts: {
        include: {
          evidence: {
            include: { evidenceItem: { include: { source: true } } },
          },
          supersedesProjectFact: true,
        },
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      },
      highlightSuggestions: {
        where: {
          status: "pending",
        },
        include: {
          sourceHighlight: {
            include: {
              evidence: {
                include: {
                  evidenceItem: {
                    include: {
                      source: true,
                    },
                  },
                },
              },
              tags: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      },
      evidenceItems: {
        include: {
          source: true,
          tags: true,
        },
        orderBy: [
          {
            included: "desc",
          },
          {
            updatedAt: "desc",
          },
        ],
      },
      generationRuns: {
        orderBy: {
          createdAt: "desc",
        },
      },
      artifacts: {
        include: {
          highlightProvenance: {
            include: { highlight: true },
            orderBy: { rank: "asc" },
          },
          evidenceProvenance: {
            include: { evidenceItem: { include: { source: true } } },
            orderBy: { rank: "asc" },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      },
      knowledgeRefreshRuns: {
        include: {
          snapshots: {
            include: { _count: { select: { files: true } } },
            orderBy: { resolvedAt: "desc" },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });

  const pendingWhere = {
    workItemId,
    decision: "pending",
  } satisfies Prisma.KnowledgeChangeWhereInput;
  const attentionPredicate = {
    OR: [
      { action: { in: ["quarantined", "retired"] } },
      { evidenceItem: { lifecycleStatus: { in: ["quarantined", "stale", "needs_validation"] } } },
      { highlight: { lifecycleStatus: { in: ["quarantined", "stale", "needs_validation"] } } },
      { projectFact: { lifecycleStatus: { in: ["quarantined", "stale", "needs_validation"] } } },
      { artifact: { lifecycleStatus: { in: ["quarantined", "stale", "needs_validation"] } } },
      { evidenceItemId: { not: null }, evidenceItem: null },
      { highlightId: { not: null }, highlight: null },
      { projectFactId: { not: null }, projectFact: null },
      { artifactId: { not: null }, artifact: null },
      {
        evidenceItemId: null,
        highlightId: null,
        projectFactId: null,
        artifactId: null,
      },
    ],
  } satisfies Prisma.KnowledgeChangeWhereInput;
  const relationInclude = {
    evidenceItem: true,
    highlight: true,
    projectFact: true,
    artifact: true,
    refreshRun: true,
  } satisfies Prisma.KnowledgeChangeInclude;
  const pendingKnowledgeWhere = {
    ...pendingWhere,
    entityKind: { not: "evidence" },
  } satisfies Prisma.KnowledgeChangeWhereInput;
  const attentionWhere = {
    ...pendingKnowledgeWhere,
    ...attentionPredicate,
  } satisfies Prisma.KnowledgeChangeWhereInput;
  const routineWhere = {
    ...pendingKnowledgeWhere,
    NOT: attentionPredicate,
  } satisfies Prisma.KnowledgeChangeWhereInput;

  const [
    attentionChanges,
    routineChanges,
    provenanceChanges,
    totalKnowledgeCount,
    totalProvenanceCount,
    newOrUpdatedKnowledgeCount,
    needsAttentionCount,
  ] = await prisma.$transaction([
    prisma.knowledgeChange.findMany({
      where: attentionWhere,
      include: relationInclude,
      orderBy: { createdAt: "desc" },
      take: KNOWLEDGE_REVIEW_CARD_LIMIT,
    }),
    prisma.knowledgeChange.findMany({
      where: routineWhere,
      include: relationInclude,
      orderBy: { createdAt: "desc" },
      take: KNOWLEDGE_REVIEW_CARD_LIMIT,
    }),
    prisma.knowledgeChange.findMany({
      where: { ...pendingWhere, entityKind: "evidence" },
      include: relationInclude,
      orderBy: { createdAt: "desc" },
      take: PROVENANCE_REVIEW_CARD_LIMIT,
    }),
    prisma.knowledgeChange.count({ where: pendingKnowledgeWhere }),
    prisma.knowledgeChange.count({ where: { ...pendingWhere, entityKind: "evidence" } }),
    prisma.knowledgeChange.count({
      where: {
        ...pendingKnowledgeWhere,
        action: { in: ["created", "updated", "revalidated"] },
      },
    }),
    prisma.knowledgeChange.count({ where: attentionWhere }),
  ]);

  return {
    ...workItem,
    // The UI needs at most one balanced page of full review records. Counts
    // remain exact without materializing every pending relation and snapshot.
    knowledgeChanges: [...attentionChanges, ...routineChanges, ...provenanceChanges],
    knowledgeChangeCounts: {
      totalKnowledgeCount,
      totalProvenanceCount,
      newOrUpdatedKnowledgeCount,
      needsAttentionCount,
    },
  };
}

export async function getArtifactForUser(
  userId: string,
  artifactId: string | null | undefined,
) {
  if (!artifactId) {
    return null;
  }

  return prisma.artifact.findFirst({
    where: {
      id: artifactId,
      userId,
    },
  });
}
