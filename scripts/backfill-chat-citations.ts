import { prisma } from "../src/lib/prisma";
import {
  canonicalCitationOrdinalsOutsideCode,
  isExactLegacyVerificationFailure,
  normalizeLegacyPlainCitationMarkers,
  remapCanonicalCitationMarkers,
  uncitedHistoricalProseBlockCount,
} from "../src/lib/chat-citation-backfill";

const repairedLegacyFailure =
  "This historical run did not retain enough supported source metadata to reconstruct its answer safely. Regenerate it with current project sources.";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function removeLegacyUncitedContext(content: string) {
  return content
    .split(/\n{2,}/)
    .filter(
      (paragraph) =>
        !/^Related context also points to\b/i.test(paragraph.trim()) ||
        /\[citation:\d+\]/i.test(paragraph),
    )
    .join("\n\n");
}

async function main() {
  const messages = await prisma.chatMessage.findMany({
    where: { role: "assistant", status: { in: ["completed", "failed"] } },
    include: { citations: { orderBy: { ordinal: "asc" } } },
  });
  let removed = 0;
  let updatedMessages = 0;
  let unverifiableMessages = 0;

  for (const message of messages) {
    if (isExactLegacyVerificationFailure({
      content: message.content,
      status: message.status,
      citationCount: message.citations.length,
    })) {
      await prisma.chatMessage.update({
        where: { id: message.id },
        data: {
          content: repairedLegacyFailure,
          metadata: {
            ...record(message.metadata),
            citationIntegrity: "legacy_unverifiable",
            citationContractVersion: 1,
            regenerateRecommended: true,
            repairedGenericFailure: true,
          },
        },
      });
      unverifiableMessages += 1;
      updatedMessages += 1;
      continue;
    }
    const availableOrdinals = new Set(message.citations.map((citation) => citation.ordinal));
    const initialCanonicalOrdinals = canonicalCitationOrdinalsOutsideCode(message.content);
    const normalizedLegacy = initialCanonicalOrdinals.length
      ? {
          content: message.content,
          convertedClusterCount: 0,
          invalidLegacyCluster: false,
        }
      : normalizeLegacyPlainCitationMarkers(message.content, availableOrdinals);
    if (!message.citations.length) {
      if (
        initialCanonicalOrdinals.length ||
        normalizedLegacy.convertedClusterCount ||
        normalizedLegacy.invalidLegacyCluster
      ) {
        await prisma.chatMessage.update({
          where: { id: message.id },
          data: {
            metadata: {
              ...record(message.metadata),
              citationIntegrity: "legacy_unverifiable",
              citationContractVersion: 1,
              regenerateRecommended: true,
            },
          },
        });
        unverifiableMessages += 1;
      }
      continue;
    }
    const normalizedContent = normalizedLegacy.content;
    const referencedOrdinals = Array.from(
      new Set(canonicalCitationOrdinalsOutsideCode(normalizedContent)),
    );
    const cleanedContent = removeLegacyUncitedContext(normalizedContent);
    const unsafeLegacyMessage =
      normalizedLegacy.invalidLegacyCluster ||
      !referencedOrdinals.length ||
      referencedOrdinals.some((ordinal) => !availableOrdinals.has(ordinal)) ||
      uncitedHistoricalProseBlockCount(cleanedContent) > 0;
    if (unsafeLegacyMessage) {
      await prisma.chatMessage.update({
        where: { id: message.id },
        data: {
          metadata: {
            ...record(message.metadata),
            citationIntegrity: "legacy_unverifiable",
            citationContractVersion: 1,
            regenerateRecommended: true,
            backfillPreservedOriginalSources: true,
          },
        },
      });
      unverifiableMessages += 1;
      updatedMessages += 1;
      continue;
    }
    const selected = referencedOrdinals.flatMap((ordinal) => {
      const citation = message.citations.find((entry) => entry.ordinal === ordinal);
      return citation ? [{ ordinal, citation }] : [];
    });
    const remap = new Map(selected.map((entry, index) => [entry.ordinal, index + 1]));
    const nextContent = remapCanonicalCitationMarkers(cleanedContent, remap)
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    const selectedIds = new Set(selected.map((entry) => entry.citation.id));
    const deleteIds = message.citations
      .filter((citation) => !selectedIds.has(citation.id))
      .map((citation) => citation.id);

    await prisma.$transaction(async (tx) => {
      if (deleteIds.length) {
        await tx.chatCitation.deleteMany({ where: { id: { in: deleteIds } } });
      }
      for (const [index, entry] of selected.entries()) {
        await tx.chatCitation.update({
          where: { id: entry.citation.id },
          data: { ordinal: 1_000 + index },
        });
      }
      for (const [index, entry] of selected.entries()) {
        await tx.chatCitation.update({
          where: { id: entry.citation.id },
          data: { ordinal: index + 1 },
        });
      }
      if (nextContent !== message.content || normalizedLegacy.convertedClusterCount) {
        await tx.chatMessage.update({
          where: { id: message.id },
          data: {
            content: nextContent,
            metadata: {
              ...record(message.metadata),
              citationIntegrity: "verified",
              citationContractVersion: 2,
              renderVersion: 2,
              verifiedBy: "legacy_marker_coverage_backfill",
            },
          },
        });
      }
    });
    removed += deleteIds.length;
    if (deleteIds.length || nextContent !== message.content) updatedMessages += 1;
  }

  console.info(`Backfilled ${updatedMessages} chat messages, removed ${removed} unused citations, and flagged ${unverifiableMessages} unverifiable historical messages.`);
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
