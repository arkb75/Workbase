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
  return prisma.workItem.findFirstOrThrow({
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
    },
  });
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
