import type {
  AnswerCitationPolicy,
  FinalizedChatAnswer,
  GroundedAnswerBlock,
  ProjectKnowledgeCitation,
} from "@/src/domain/project-chat";

const citationMarkerPattern = /\[citation:(\d+)\]/gi;
const bareCitationPattern = /\[(?:\d+)(?:\s*,\s*\d+)*\](?:\s*\[(?:\d+)(?:\s*,\s*\d+)*\])*/;

export class CitationIntegrityError extends Error {
  readonly code = "citation_integrity_failed";

  constructor(message: string) {
    super(message);
    this.name = "CitationIntegrityError";
  }
}

export function selectReferencedCitations(
  answer: string,
  catalog: readonly ProjectKnowledgeCitation[],
  maxCitations = 20,
) {
  const referenced = Array.from(answer.matchAll(citationMarkerPattern))
    .map((match) => Number(match[1]) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < catalog.length);
  const uniqueIndexes = Array.from(new Set(referenced)).slice(0, maxCitations);
  const remap = new Map(uniqueIndexes.map((index, compactIndex) => [index, compactIndex + 1]));
  const content = answer
    .replace(citationMarkerPattern, (_marker, rawOrdinal: string) => {
      const compactOrdinal = remap.get(Number(rawOrdinal) - 1);
      return compactOrdinal ? `[citation:${compactOrdinal}]` : "";
    })
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return {
    content,
    citations: uniqueIndexes.map((index) => catalog[index]!),
    referencedIndexes: uniqueIndexes,
  };
}

export type CitationTextSegment =
  | { kind: "text"; text: string }
  | { kind: "citations"; ordinals: number[] };

export function splitCitationText(content: string): CitationTextSegment[] {
  return content
    .split(/((?:\[citation:\d+\])+)/gi)
    .filter(Boolean)
    .map((part) => {
      const ordinals = Array.from(part.matchAll(citationMarkerPattern)).map((match) =>
        Number(match[1]),
      );
      return ordinals.length
        ? { kind: "citations" as const, ordinals }
        : { kind: "text" as const, text: part };
    });
}

export function citationCatalogKey(citation: ProjectKnowledgeCitation) {
  return [
    citation.kind,
    citation.highlightId,
    citation.projectFactId,
    citation.evidenceItemId,
    citation.artifactId,
    citation.repository,
    citation.commitSha,
    citation.path,
    citation.startLine,
    citation.endLine,
  ].join(":");
}

export function dedupeCitationCatalog(citations: readonly ProjectKnowledgeCitation[]) {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citationCatalogKey(citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateModelMarkdown(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new CitationIntegrityError(`${label} is empty.`);
  if (/\[citation:\d+\]/i.test(normalized) || bareCitationPattern.test(normalized)) {
    throw new CitationIntegrityError(`${label} contains model-authored citation syntax.`);
  }
  return normalized;
}

function markerOrdinals(content: string) {
  return Array.from(content.matchAll(citationMarkerPattern)).map((match) => Number(match[1]));
}

function appendCanonicalMarkers(body: string, marker: string) {
  const lines = body.split("\n");
  const listItemPattern = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
  const fencePattern = /^\s*(?:```|~~~)/;
  let inFence = false;
  let sawContent = false;
  let pureList = true;
  for (const line of lines) {
    if (fencePattern.test(line)) {
      inFence = !inFence;
      pureList = false;
      continue;
    }
    if (!line.trim()) continue;
    sawContent = true;
    if (inFence || !listItemPattern.test(line)) pureList = false;
  }
  if (!sawContent || !pureList) {
    return fencePattern.test(lines.at(-1) ?? "")
      ? `${body}\n\n${marker}`
      : `${body} ${marker}`;
  }
  // A structured block can contain several independently phrased list items,
  // while its citationIndexes apply to the complete block. Repeat the
  // canonical marker set on each item so the rendered source relationship and
  // post-persistence claim audit do not accidentally apply only to the final
  // bullet.
  return lines
    .map((line) => listItemPattern.test(line) ? `${line} ${marker}` : line)
    .join("\n");
}

export function assertAnswerCitationContract(input: {
  content: string;
  citations: readonly ProjectKnowledgeCitation[];
  policy: AnswerCitationPolicy;
  groundedClaims?: Array<{ claim: string; citationIndexes: number[] }>;
}) {
  const ordinals = markerOrdinals(input.content);
  const invalid = ordinals.filter((ordinal) => !Number.isInteger(ordinal) || ordinal < 1 || ordinal > input.citations.length);
  if (invalid.length) {
    throw new CitationIntegrityError(`The answer references unavailable citation ordinals: ${Array.from(new Set(invalid)).join(", ")}.`);
  }
  if (input.policy === "none") {
    if (ordinals.length || input.citations.length) {
      throw new CitationIntegrityError("A citation-free answer cannot include citation markers or attached sources.");
    }
    return;
  }
  if (input.policy === "attached") {
    if (ordinals.length) {
      throw new CitationIntegrityError("An attached-provenance answer cannot include inline citation markers.");
    }
    return;
  }
  if (!input.citations.length || !ordinals.length) {
    throw new CitationIntegrityError("A grounded project answer must include at least one persisted inline citation.");
  }
  const used = new Set(ordinals);
  for (let ordinal = 1; ordinal <= input.citations.length; ordinal += 1) {
    if (!used.has(ordinal)) throw new CitationIntegrityError(`Persisted citation ${ordinal} is not referenced by the answer.`);
  }
  if (!input.groundedClaims?.length) {
    throw new CitationIntegrityError("A grounded project answer must include verified claim mappings.");
  }
  for (const claim of input.groundedClaims) {
    if (!claim.claim.trim() || !claim.citationIndexes.length) {
      throw new CitationIntegrityError("Every grounded claim must contain text and at least one citation.");
    }
    if (claim.citationIndexes.some((ordinal) => ordinal < 1 || ordinal > input.citations.length)) {
      throw new CitationIntegrityError("A grounded claim references a citation outside the persisted catalog.");
    }
  }
}

export function finalizeGroundedAnswer(input: {
  blocks: readonly GroundedAnswerBlock[];
  catalog: readonly ProjectKnowledgeCitation[];
  maxCitations?: number;
  freshness?: FinalizedChatAnswer["freshness"];
}): FinalizedChatAnswer {
  if (!input.blocks.length) throw new CitationIntegrityError("The grounding verifier returned no supported answer blocks.");
  const maxCitations = input.maxCitations ?? 20;
  const compactCitations: ProjectKnowledgeCitation[] = [];
  const compactByKey = new Map<string, number>();
  const serializedBlocks: string[] = [];
  const groundedClaims: FinalizedChatAnswer["groundedClaims"] = [];

  for (const [blockIndex, block] of input.blocks.entries()) {
    const body = validateModelMarkdown(block.bodyMarkdown, `Grounded block ${blockIndex + 1}`);
    const heading = block.heading ? validateModelMarkdown(block.heading.replace(/^#{1,6}\s*/, ""), `Grounded heading ${blockIndex + 1}`) : null;
    const originalIndexes = Array.from(new Set(block.citationIndexes));
    if (!originalIndexes.length || originalIndexes.length > 6) {
      throw new CitationIntegrityError(`Grounded block ${blockIndex + 1} must reference between one and six sources.`);
    }
    const compactIndexes = originalIndexes.map((ordinal) => {
      if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > input.catalog.length) {
        throw new CitationIntegrityError(`Grounded block ${blockIndex + 1} references unavailable source ${ordinal}.`);
      }
      const citation = input.catalog[ordinal - 1]!;
      const key = citationCatalogKey(citation);
      const existing = compactByKey.get(key);
      if (existing) return existing;
      if (compactCitations.length >= maxCitations) {
        throw new CitationIntegrityError(`The grounded answer exceeds the ${maxCitations}-source limit.`);
      }
      compactCitations.push(citation);
      const compactOrdinal = compactCitations.length;
      compactByKey.set(key, compactOrdinal);
      return compactOrdinal;
    });
    const uniqueCompactIndexes = Array.from(new Set(compactIndexes));
    const marker = uniqueCompactIndexes.map((ordinal) => `[citation:${ordinal}]`).join("");
    serializedBlocks.push([
      heading ? `### ${heading}` : null,
      appendCanonicalMarkers(body, marker),
    ].filter(Boolean).join("\n"));
    groundedClaims.push({ claim: body, citationIndexes: uniqueCompactIndexes });
  }

  const markdown = serializedBlocks.join("\n\n").trim();
  assertAnswerCitationContract({
    content: markdown,
    citations: compactCitations,
    policy: "required_inline",
    groundedClaims,
  });
  return {
    answerKind: "project_grounded",
    citationPolicy: "required_inline",
    markdown,
    citations: compactCitations,
    groundedClaims,
    freshness: input.freshness ?? null,
  };
}
