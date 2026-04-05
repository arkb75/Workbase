import { prisma } from "@/src/lib/prisma";

export async function listWorkItemsForUser(userId: string) {
  return prisma.workItem.findMany({
    where: {
      userId,
    },
    include: {
      claims: true,
      sources: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });
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
      claims: {
        include: {
          evidenceCard: true,
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
      evidenceItems: {
        include: {
          source: true,
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
      evidenceClusters: {
        include: {
          items: {
            orderBy: {
              createdAt: "asc",
            },
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      },
      generationRuns: {
        orderBy: {
          createdAt: "desc",
        },
      },
      artifacts: {
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
