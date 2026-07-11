import { prisma } from "../src/lib/prisma";

const markerPattern = /\[citation:(\d+)\]/gi;

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
    where: { role: "assistant", citations: { some: {} } },
    include: { citations: { orderBy: { ordinal: "asc" } } },
  });
  let removed = 0;
  let updatedMessages = 0;

  for (const message of messages) {
    const referencedOrdinals = Array.from(
      new Set(
        Array.from(message.content.matchAll(markerPattern))
          .map((match) => Number(match[1]))
          .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0),
      ),
    );
    const selected = referencedOrdinals.flatMap((ordinal) => {
      const citation = message.citations.find((entry) => entry.ordinal === ordinal);
      return citation ? [{ ordinal, citation }] : [];
    });
    const remap = new Map(selected.map((entry, index) => [entry.ordinal, index + 1]));
    const nextContent = removeLegacyUncitedContext(
      message.content
        .replace(markerPattern, (_marker, rawOrdinal: string) => {
          const ordinal = remap.get(Number(rawOrdinal));
          return ordinal ? `[citation:${ordinal}]` : "";
        })
        .replace(/[ \t]+\n/g, "\n")
        .trim(),
    );
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
      if (nextContent !== message.content) {
        await tx.chatMessage.update({ where: { id: message.id }, data: { content: nextContent } });
      }
    });
    removed += deleteIds.length;
    if (deleteIds.length || nextContent !== message.content) updatedMessages += 1;
  }

  console.info(`Backfilled ${updatedMessages} chat messages and removed ${removed} unused citations.`);
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
