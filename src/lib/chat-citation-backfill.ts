const canonicalMarkerPattern = /\[citation:(\d+)\]/gi;
const plainMarkerPattern = /\[(\d+)\]/g;
const fencedBlockPattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const indentedCodePattern = /^(?: {4,}|\t)/;
const listItemPattern = /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/;
const exactLegacyVerificationFailures = new Set([
  "the answer could not be verified against its sources",
  "grounding verifier returned no supported claims",
  "citation integrity failed",
]);

export function isExactLegacyVerificationFailure(input: {
  content: string;
  status: string;
  citationCount: number;
}) {
  if (input.status !== "failed" || input.citationCount !== 0) return false;
  const normalized = input.content
    .trim()
    .replace(/[.!?]+$/, "")
    .trim()
    .toLowerCase();
  return exactLegacyVerificationFailures.has(normalized);
}

interface MarkdownFence {
  character: string;
  length: number;
}

function fenceMarker(line: string) {
  const match = line.match(fencedBlockPattern);
  if (!match) return null;
  return {
    marker: match[2]!,
    trailing: match[3] ?? "",
  };
}

function opensMarkdownFence(marker: string, trailing: string) {
  // CommonMark forbids backticks in the info string of a backtick fence.
  return marker[0] !== "`" || !trailing.includes("`");
}

function closesMarkdownFence(
  marker: string,
  trailing: string,
  activeFence: MarkdownFence,
) {
  return marker[0] === activeFence.character &&
    marker.length >= activeFence.length &&
    trailing.trim().length === 0;
}

function maskedInlineCode(line: string) {
  const characters = line.split("");
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.slice(cursor).match(/`+/);
    if (!opening || opening.index === undefined) break;
    const start = cursor + opening.index;
    const marker = opening[0];
    const end = line.indexOf(marker, start + marker.length);
    if (end < 0) {
      for (let index = start; index < characters.length; index += 1) characters[index] = " ";
      break;
    }
    for (let index = start; index < end + marker.length; index += 1) characters[index] = " ";
    cursor = end + marker.length;
  }
  return characters.join("");
}

function mapMarkdownProseLines(
  markdown: string,
  transform: (line: string, maskedLine: string) => string,
  transformCode: (line: string) => string = (line) => line,
) {
  let activeFence: MarkdownFence | null = null;
  return markdown.split("\n").map((line) => {
    const fence = fenceMarker(line);
    if (activeFence) {
      if (
        fence &&
        closesMarkdownFence(fence.marker, fence.trailing, activeFence)
      ) {
        activeFence = null;
      }
      return transformCode(line);
    }
    if (
      fence &&
      opensMarkdownFence(fence.marker, fence.trailing)
    ) {
      activeFence = {
        character: fence.marker[0]!,
        length: fence.marker.length,
      };
      return transformCode(line);
    }
    if (indentedCodePattern.test(line)) return transformCode(line);
    return transform(line, maskedInlineCode(line));
  }).join("\n");
}

export function canonicalCitationOrdinalsOutsideCode(markdown: string) {
  const ordinals: number[] = [];
  mapMarkdownProseLines(markdown, (line, maskedLine) => {
    for (const match of maskedLine.matchAll(canonicalMarkerPattern)) {
      ordinals.push(Number(match[1]));
    }
    return line;
  });
  return ordinals;
}

/**
 * Old Workbase answers rendered citations as `[N]`. Only convert a contiguous
 * citation cluster at the end of a prose line. Array indexes, tuple literals,
 * Markdown links, and anything inside inline or fenced code remain untouched.
 */
export function normalizeLegacyPlainCitationMarkers(
  markdown: string,
  availableOrdinals: ReadonlySet<number>,
) {
  let invalidLegacyCluster = false;
  let convertedClusterCount = 0;
  const content = mapMarkdownProseLines(markdown, (line, maskedLine) => {
    const match = maskedLine.match(/((?:\[\d+\][ \t]*)+)([.,;:!?]?[ \t]*)$/);
    if (!match || match.index === undefined) return line;
    const prefix = maskedLine.slice(0, match.index);
    if (
      !/[A-Za-z0-9]/.test(prefix) ||
      // `[label][1]` is a reference-style Markdown link, not a citation.
      prefix.endsWith("]") ||
      !/(?:\s|[.!?:;,)\]}])$/.test(prefix)
    ) {
      return line;
    }
    const ordinals = Array.from(match[1]!.matchAll(plainMarkerPattern))
      .map((entry) => Number(entry[1]));
    if (
      !ordinals.length ||
      ordinals.some((ordinal) =>
        !Number.isInteger(ordinal) ||
        ordinal < 1 ||
        !availableOrdinals.has(ordinal)
      )
    ) {
      invalidLegacyCluster = true;
      return line;
    }
    convertedClusterCount += 1;
    const replacement = ordinals
      .map((ordinal) => `[citation:${ordinal}]`)
      .join("");
    return `${line.slice(0, match.index)}${replacement}${line.slice(
      match.index + match[1]!.length,
    )}`;
  });
  return { content, convertedClusterCount, invalidLegacyCluster };
}

export function remapCanonicalCitationMarkers(
  markdown: string,
  remap: ReadonlyMap<number, number>,
) {
  return mapMarkdownProseLines(markdown, (line, maskedLine) => {
    let cursor = 0;
    let output = "";
    for (const match of maskedLine.matchAll(canonicalMarkerPattern)) {
      const start = match.index ?? 0;
      output += line.slice(cursor, start);
      const ordinal = remap.get(Number(match[1]));
      output += ordinal ? `[citation:${ordinal}]` : match[0];
      cursor = start + match[0].length;
    }
    return `${output}${line.slice(cursor)}`;
  });
}

function maskedMarkdownProse(markdown: string) {
  return mapMarkdownProseLines(
    markdown,
    (_line, maskedLine) => maskedLine,
    (line) => " ".repeat(line.length),
  );
}

function proseWithoutCode(markdown: string) {
  return maskedMarkdownProse(markdown)
    .replace(canonicalMarkerPattern, " ")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, " ")
    .replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, " ")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_~>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function historicalProseBlocks(markdown: string) {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.some((line) => line.trim())) blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of maskedMarkdownProse(markdown).split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (listItemPattern.test(line)) {
      // Each list item can make an independent factual claim. A citation on a
      // sibling item must never authorize the rest of the list.
      flush();
      current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * A historical message is safe to compact only when every prose block that
 * contains a factual sentence also carries at least one canonical marker.
 * Ambiguous messages keep their original text and sources and are flagged for
 * regeneration instead of being mislabeled as verified.
 */
export function uncitedHistoricalProseBlockCount(markdown: string) {
  return historicalProseBlocks(markdown).reduce((count, block) => {
    const prose = proseWithoutCode(block);
    if (!prose || prose.split(/\s+/).length < 3) return count;
    return canonicalCitationOrdinalsOutsideCode(block).length ? count : count + 1;
  }, 0);
}
