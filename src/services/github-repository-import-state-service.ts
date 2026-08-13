import { prisma } from "@/src/lib/prisma";
import {
  mergeRepositoryImportMetadata,
  readRepositoryImportState,
  type RepositoryImportState,
} from "@/src/lib/github-repository-import-state";

export async function updateRepositoryImportStateForRequest(input: {
  sourceId: string;
  requestId: string;
  patch: Partial<Omit<RepositoryImportState, "requestId" | "requestedAt">>;
  additionalMetadata?: Record<string, unknown>;
}) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Source" WHERE "id" = ${input.sourceId} FOR UPDATE
    `;
    if (!locked.length) return null;

    const source = await tx.source.findUnique({
      where: { id: input.sourceId },
      select: { id: true, metadata: true },
    });
    const current = readRepositoryImportState(source?.metadata);
    if (!source || !current || current.requestId !== input.requestId) return null;

    const next: RepositoryImportState = {
      ...current,
      ...input.patch,
      requestId: current.requestId,
      requestedAt: current.requestedAt,
    };
    await tx.source.update({
      where: { id: source.id },
      data: {
        metadata: mergeRepositoryImportMetadata(
          source.metadata,
          next,
          input.additionalMetadata,
        ),
      },
    });
    return next;
  });
}
