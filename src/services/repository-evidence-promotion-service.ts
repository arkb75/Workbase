import { createHash } from "node:crypto";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import { buildEvidenceSearchText, inferEvidenceTags } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";

export async function promoteRepositoryCitations(input: {
  workItemId: string;
  citations: readonly ProjectKnowledgeCitation[];
}) {
  const promotedIds: string[] = [];
  const newIds: string[] = [];
  const evidenceIdByCitationIndex = new Map<number, string>();

  for (const [citationIndex, citation] of input.citations.entries()) {
    if (
      citation.kind !== "github_file" ||
      !citation.sourceId ||
      !citation.repository ||
      !citation.commitSha ||
      !citation.blobSha ||
      !citation.path ||
      !citation.startLine ||
      !citation.endLine
    ) continue;

    const source = await prisma.source.findFirst({
      where: { id: citation.sourceId, workItemId: input.workItemId, type: "github_repo" },
    });
    if (!source) continue;

    const excerptHash = createHash("sha256").update(citation.excerpt).digest("hex");
    const externalId = [
      "file",
      citation.commitSha,
      citation.path,
      citation.startLine,
      citation.endLine,
      excerptHash.slice(0, 12),
    ].join(":");
    const metadata = {
      managedBy: "project_research",
      repository: citation.repository,
      commitSha: citation.commitSha,
      blobSha: citation.blobSha,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      excerptHash,
      url: citation.url ?? null,
      fetchedAt: new Date().toISOString(),
      contentSafety: "untrusted_repository_content",
      redacted: citation.redacted ?? false,
      redactionCategories: citation.redactionCategories ?? [],
    };
    const existing = await prisma.evidenceItem.findUnique({
      where: { sourceId_externalId: { sourceId: source.id, externalId } },
      select: { id: true },
    });
    const evidence = await prisma.evidenceItem.upsert({
      where: { sourceId_externalId: { sourceId: source.id, externalId } },
      create: {
        workItemId: input.workItemId,
        sourceId: source.id,
        externalId,
        type: "github_file_excerpt",
        title: `${citation.path}:${citation.startLine}-${citation.endLine}`,
        content: citation.excerpt,
        searchText: buildEvidenceSearchText({ title: citation.path, content: citation.excerpt, metadata }),
        parentKind: "github_file",
        parentKey: `${citation.commitSha}:${citation.path}`,
        included: false,
        metadata,
      },
      update: { content: citation.excerpt, searchText: buildEvidenceSearchText({ title: citation.path, content: citation.excerpt, metadata }), metadata },
    });
    const tags = inferEvidenceTags({
      title: evidence.title,
      content: evidence.content,
      sourceType: "github_repo",
      evidenceType: "github_file_excerpt",
    });
    await prisma.evidenceTag.deleteMany({ where: { evidenceItemId: evidence.id } });
    if (tags.length) {
      await prisma.evidenceTag.createMany({
        data: tags.map((tag) => ({
          evidenceItemId: evidence.id,
          dimension: tag.dimension,
          tag: tag.tag,
          score: tag.score ?? null,
        })),
        skipDuplicates: true,
      });
    }
    promotedIds.push(evidence.id);
    evidenceIdByCitationIndex.set(citationIndex, evidence.id);
    if (!existing) newIds.push(evidence.id);
  }

  return { promotedIds, newIds, evidenceIdByCitationIndex };
}
