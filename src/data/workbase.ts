import type { Prisma } from "@/src/generated/prisma/client";
import {
  KNOWLEDGE_REVIEW_CARD_LIMIT,
  PROVENANCE_REVIEW_CARD_LIMIT,
} from "@/src/lib/knowledge-review-inbox";
import { pendingHighlightBulkApprovalWhere } from "@/src/lib/highlight-bulk-approval";
import {
  ACTIVE_REPOSITORY_REFRESH_STATUSES,
  readRepositoryImportState,
} from "@/src/lib/github-repository-import-state";
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
      agentRuns: {
        where: { kind: "manual_evidence_highlights" },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 10,
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

  const reviewInbox = await loadKnowledgeReviewInbox(workItemId);

  return {
    ...workItem,
    ...reviewInbox,
  };
}

type WorkItemForUser = Awaited<ReturnType<typeof getWorkItemForUser>>;
type WorkspaceTab = "sources" | "highlights" | "chat" | "artifacts";
const EVIDENCE_PAGE_SIZE = 30;
const KNOWLEDGE_PAGE_SIZE = 20;

type WorkspacePagination = {
  page: number;
  totalItems: number;
  pageSize: number;
  totalPages: number;
};

function buildPagination(page: number, totalItems: number, pageSize: number): WorkspacePagination {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    page: Math.min(Math.max(1, page), totalPages),
    totalItems,
    pageSize,
    totalPages,
  };
}

const emptyHighlightCounts = {
  approved: 0,
  pending: 0,
  rejected: 0,
  lifecycle: 0,
  sensitive: 0,
  bulkApprovable: 0,
};

const emptyPagination = buildPagination(1, 0, 1);

const emptyKnowledgeChangeCounts = {
  totalKnowledgeCount: 0,
  totalProvenanceCount: 0,
  newOrUpdatedKnowledgeCount: 0,
  needsAttentionCount: 0,
};

function buildWorkspaceWorkItem(
  workItem: Record<string, unknown>,
  relations: Partial<Pick<
    WorkItemForUser,
    | "sources"
    | "highlights"
    | "projectFacts"
    | "highlightSuggestions"
    | "evidenceItems"
    | "generationRuns"
    | "agentRuns"
    | "artifacts"
    | "knowledgeRefreshRuns"
    | "knowledgeChanges"
  >> & {
    knowledgeChangeCounts?: WorkItemForUser["knowledgeChangeCounts"];
  } = {},
) {
  return {
    ...workItem,
    sources: [],
    highlights: [],
    projectFacts: [],
    highlightSuggestions: [],
    evidenceItems: [],
    generationRuns: [],
    agentRuns: [],
    artifacts: [],
    knowledgeRefreshRuns: [],
    knowledgeChanges: [],
    knowledgeChangeCounts: emptyKnowledgeChangeCounts,
    ...relations,
  } as WorkItemForUser;
}

async function loadKnowledgeReviewInbox(workItemId: string, userId?: string) {
  if (userId) {
    await prisma.workItem.findFirstOrThrow({
      where: { id: workItemId, userId },
      select: { id: true },
    });
  }

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
    knowledgeChanges: [...attentionChanges, ...routineChanges, ...provenanceChanges],
    knowledgeChangeCounts: {
      totalKnowledgeCount,
      totalProvenanceCount,
      newOrUpdatedKnowledgeCount,
      needsAttentionCount,
    },
  };
}

export async function getWorkItemChatShellForUser(
  userId: string,
  workItemId: string,
): Promise<{
  workItem: WorkItemForUser;
  sensitiveContextAvailable: boolean;
}> {
  const result = await prisma.workItem.findFirstOrThrow({
    where: {
      id: workItemId,
      userId,
    },
    include: {
      highlights: {
        where: {
          lifecycleStatus: "active",
          sensitivityFlag: true,
        },
        select: {
          id: true,
        },
        take: 1,
      },
      projectFacts: {
        where: {
          lifecycleStatus: "active",
          sensitivityFlag: true,
        },
        select: {
          id: true,
        },
        take: 1,
      },
      agentRuns: {
        where: { kind: "manual_evidence_highlights" },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 1,
      },
    },
  });
  const {
    highlights,
    projectFacts,
    agentRuns,
    ...workItem
  } = result;

  return {
    // The chat page needs only the Work Item header. Empty relation arrays keep
    // the shared page rendering contract intact without hydrating the full
    // project knowledge graph or review inbox.
    workItem: {
      ...workItem,
      sources: [],
      highlights: [],
      projectFacts: [],
      highlightSuggestions: [],
      evidenceItems: [],
      generationRuns: [],
      agentRuns,
      artifacts: [],
      knowledgeRefreshRuns: [],
      knowledgeChanges: [],
      knowledgeChangeCounts: {
        totalKnowledgeCount: 0,
        totalProvenanceCount: 0,
        newOrUpdatedKnowledgeCount: 0,
        needsAttentionCount: 0,
      },
    },
    sensitiveContextAvailable: highlights.length > 0 || projectFacts.length > 0,
  };
}

export async function getWorkItemWorkspaceForUser(
  userId: string,
  workItemId: string,
  tab: WorkspaceTab,
  options: {
    evidencePage?: number;
    knowledgePage?: number;
  } = {},
): Promise<{
  workItem: WorkItemForUser;
  sensitiveContextAvailable: boolean;
  visibleSourceCount: number;
  includedEvidenceCount: number;
  evidenceTypeCounts: Record<string, number>;
  highlightCounts: typeof emptyHighlightCounts;
  highlightCount: number;
  pendingHighlightSuggestionCount: number;
  approvedProjectFactCount: number;
  projectFactCount: number;
  pagination: {
    evidence: WorkspacePagination;
    knowledge: WorkspacePagination;
  };
}> {
  if (tab === "chat") {
    const result = await getWorkItemChatShellForUser(userId, workItemId);
    return {
      ...result,
      visibleSourceCount: 0,
      includedEvidenceCount: 0,
      evidenceTypeCounts: {},
      highlightCounts: emptyHighlightCounts,
      highlightCount: 0,
      pendingHighlightSuggestionCount: 0,
      approvedProjectFactCount: 0,
      projectFactCount: 0,
      pagination: {
        evidence: emptyPagination,
        knowledge: emptyPagination,
      },
    };
  }

  if (tab === "sources") {
    const result = await prisma.workItem.findFirstOrThrow({
      where: { id: workItemId, userId },
      include: {
        sources: { orderBy: { createdAt: "asc" } },
        agentRuns: {
          where: { kind: "manual_evidence_highlights" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 10,
        },
      },
    });
    const { sources, agentRuns, ...workItem } = result;
    const linkedRefreshRunIds = sources.flatMap((source) => {
      const refreshRunId = readRepositoryImportState(source.metadata)?.refreshRunId;
      return refreshRunId ? [refreshRunId] : [];
    });
    const [totalEvidenceCount, includedEvidenceCount, evidenceGroups] = await Promise.all([
      prisma.evidenceItem.count({ where: { workItemId } }),
      prisma.evidenceItem.count({ where: { workItemId, included: true } }),
      prisma.evidenceItem.groupBy({
        by: ["type"],
        where: { workItemId },
        _count: { _all: true },
      }),
    ]);
    const evidencePagination = buildPagination(
      options.evidencePage ?? 1,
      totalEvidenceCount,
      EVIDENCE_PAGE_SIZE,
    );
    const [evidenceItems, knowledgeRefreshRuns] = await Promise.all([
      prisma.evidenceItem.findMany({
        where: { workItemId },
        include: { source: true, tags: true },
        orderBy: [{ included: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
        skip: (evidencePagination.page - 1) * EVIDENCE_PAGE_SIZE,
        take: EVIDENCE_PAGE_SIZE,
      }),
      prisma.knowledgeRefreshRun.findMany({
        where: {
          workItemId,
          OR: [
            { status: { in: [...ACTIVE_REPOSITORY_REFRESH_STATUSES] } },
            ...(linkedRefreshRunIds.length
              ? [{ id: { in: linkedRefreshRunIds } }]
              : []),
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    ]);
    return {
      workItem: buildWorkspaceWorkItem(workItem, {
        sources,
        agentRuns,
        evidenceItems,
        knowledgeRefreshRuns: knowledgeRefreshRuns.map((run) => ({
          ...run,
          // Snapshot file counts are not rendered by the Sources workspace.
          snapshots: [],
        })),
      }),
      sensitiveContextAvailable: false,
      visibleSourceCount: sources.filter(
        (source) =>
          !(
            source.metadata &&
            typeof source.metadata === "object" &&
            !Array.isArray(source.metadata) &&
            (source.metadata as Record<string, unknown>).kind === "work_item_description"
          ),
      ).length,
      includedEvidenceCount,
      evidenceTypeCounts: Object.fromEntries(
        evidenceGroups.map((group) => [group.type, group._count._all]),
      ),
      highlightCounts: emptyHighlightCounts,
      highlightCount: 0,
      pendingHighlightSuggestionCount: 0,
      approvedProjectFactCount: 0,
      projectFactCount: 0,
      pagination: {
        evidence: evidencePagination,
        knowledge: emptyPagination,
      },
    };
  }

  if (tab === "artifacts") {
    const result = await prisma.workItem.findFirstOrThrow({
      where: { id: workItemId, userId },
      include: {
        highlights: {
          include: {
            evidence: {
              include: { evidenceItem: { include: { source: true } } },
            },
            tags: true,
          },
          orderBy: [{ verificationStatus: "asc" }, { updatedAt: "desc" }],
        },
        evidenceItems: {
          include: { source: true, tags: true },
          orderBy: [{ included: "desc" }, { updatedAt: "desc" }],
        },
        generationRuns: {
          where: {
            kind: { in: ["artifact_retrieval", "artifact_generation"] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 30,
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
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        },
        agentRuns: {
          where: { kind: "manual_evidence_highlights" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
    });
    const {
      highlights,
      evidenceItems,
      generationRuns,
      artifacts,
      agentRuns,
      ...workItem
    } = result;
    return {
      workItem: buildWorkspaceWorkItem(workItem, {
        highlights,
        evidenceItems,
        generationRuns,
        artifacts,
        agentRuns,
      }),
      sensitiveContextAvailable: false,
      visibleSourceCount: 0,
      includedEvidenceCount: 0,
      evidenceTypeCounts: {},
      highlightCounts: emptyHighlightCounts,
      highlightCount: 0,
      pendingHighlightSuggestionCount: 0,
      approvedProjectFactCount: 0,
      projectFactCount: 0,
      pagination: {
        evidence: emptyPagination,
        knowledge: emptyPagination,
      },
    };
  }

  await prisma.workItem.findFirstOrThrow({
    where: { id: workItemId, userId },
    select: { id: true },
  });
  const [
    result,
    reviewInbox,
    totalHighlightCount,
    totalProjectFactCount,
    approvedProjectFactCount,
    bulkApprovableHighlightCount,
    sensitiveHighlightCount,
    highlightGroups,
  ] = await Promise.all([
    prisma.workItem.findFirstOrThrow({
      where: { id: workItemId, userId },
      include: {
        sources: { orderBy: { createdAt: "asc" } },
        highlightSuggestions: {
          where: { status: "pending" },
          include: {
            sourceHighlight: {
              include: {
                evidence: {
                  include: { evidenceItem: { include: { source: true } } },
                },
                tags: true,
              },
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
        },
        generationRuns: {
          where: {
            kind: {
              in: [
                "highlight_generation",
                "highlight_verification",
                "artifact_retrieval",
                "artifact_generation",
              ],
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 30,
        },
        knowledgeRefreshRuns: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 10,
        },
        agentRuns: {
          where: { kind: "manual_evidence_highlights" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 10,
        },
        _count: {
          select: {
            evidenceItems: { where: { included: true } },
            highlightSuggestions: { where: { status: "pending" } },
          },
        },
      },
    }),
    loadKnowledgeReviewInbox(workItemId),
    prisma.highlight.count({ where: { workItemId } }),
    prisma.projectFact.count({ where: { workItemId } }),
    prisma.projectFact.count({
      where: {
        workItemId,
        status: "approved",
        lifecycleStatus: "active",
      },
    }),
    prisma.highlight.count({
      where: pendingHighlightBulkApprovalWhere(workItemId),
    }),
    prisma.highlight.count({
      where: {
        workItemId,
        lifecycleStatus: "active",
        sensitivityFlag: true,
      },
    }),
    prisma.highlight.groupBy({
      by: ["lifecycleStatus", "verificationStatus"],
      where: { workItemId },
      _count: { _all: true },
    }),
  ]);
  const knowledgePagination = buildPagination(
    options.knowledgePage ?? 1,
    Math.max(totalHighlightCount, totalProjectFactCount),
    KNOWLEDGE_PAGE_SIZE,
  );
  const [highlights, projectFacts] = await Promise.all([
    prisma.highlight.findMany({
      where: { workItemId },
      include: {
        evidence: {
          include: { evidenceItem: { include: { source: true } } },
        },
        tags: true,
      },
      orderBy: [
        { lifecycleStatus: "asc" },
        { verificationStatus: "asc" },
        { updatedAt: "desc" },
        { id: "asc" },
      ],
      skip: (knowledgePagination.page - 1) * KNOWLEDGE_PAGE_SIZE,
      take: KNOWLEDGE_PAGE_SIZE,
    }),
    prisma.projectFact.findMany({
      where: { workItemId },
      include: {
        evidence: {
          include: { evidenceItem: { include: { source: true } } },
        },
        supersedesProjectFact: true,
      },
      orderBy: [
        { lifecycleStatus: "asc" },
        { status: "asc" },
        { updatedAt: "desc" },
        { id: "asc" },
      ],
      skip: (knowledgePagination.page - 1) * KNOWLEDGE_PAGE_SIZE,
      take: KNOWLEDGE_PAGE_SIZE,
    }),
  ]);
  const {
    sources,
    highlightSuggestions,
    generationRuns,
    knowledgeRefreshRuns,
    agentRuns,
    _count,
    ...workItem
  } = result;
  const countHighlights = (
    lifecycleStatus: string,
    verificationStatuses?: string[],
  ) => highlightGroups
    .filter((group) =>
      group.lifecycleStatus === lifecycleStatus &&
      (!verificationStatuses || verificationStatuses.includes(group.verificationStatus)))
    .reduce((total, group) => total + group._count._all, 0);
  const lifecycleHighlightCount = highlightGroups
    .filter((group) => group.lifecycleStatus !== "active")
    .reduce((total, group) => total + group._count._all, 0);
  return {
    workItem: buildWorkspaceWorkItem(workItem, {
      sources,
      highlights,
      projectFacts,
      highlightSuggestions,
      generationRuns,
      knowledgeRefreshRuns: knowledgeRefreshRuns.map((run) => ({
        ...run,
        // Snapshot file counts are not rendered by the workspace inbox.
        snapshots: [],
      })),
      agentRuns,
      ...reviewInbox,
    }),
    sensitiveContextAvailable: false,
    visibleSourceCount: sources.filter(
      (source) =>
        !(
          source.metadata &&
          typeof source.metadata === "object" &&
          !Array.isArray(source.metadata) &&
          (source.metadata as Record<string, unknown>).kind === "work_item_description"
        ),
    ).length,
    includedEvidenceCount: _count.evidenceItems,
    evidenceTypeCounts: {},
    highlightCounts: {
      approved: countHighlights("active", ["approved"]),
      pending: countHighlights("active", ["draft", "flagged"]),
      rejected: countHighlights("active", ["rejected"]),
      lifecycle: lifecycleHighlightCount,
      sensitive: sensitiveHighlightCount,
      bulkApprovable: bulkApprovableHighlightCount,
    },
    highlightCount: totalHighlightCount,
    pendingHighlightSuggestionCount: _count.highlightSuggestions,
    approvedProjectFactCount,
    projectFactCount: totalProjectFactCount,
    pagination: {
      evidence: emptyPagination,
      knowledge: knowledgePagination,
    },
  };
}
