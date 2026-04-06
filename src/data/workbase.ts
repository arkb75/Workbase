import { prisma } from "@/src/lib/prisma";

export async function listWorkItemsForUser(userId: string) {
  return prisma.workItem.findMany({
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
