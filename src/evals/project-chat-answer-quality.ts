import { projectChatAnswerExposesInternalProtocol } from "@/src/lib/project-chat-publication-safety";

export type ProjectChatAnswerFormat = "markdown" | "paragraphs" | "table";

export type ProjectChatReaderTheme =
  | "product_outcome"
  | "repository_intelligence"
  | "grounded_agent"
  | "knowledge_governance"
  | "durable_ai_platform"
  | "engineering_foundation";

export interface ProjectChatAnswerQualityContract {
  minCharacters?: number;
  maxCharacters?: number;
  minReaderThemes?: number;
  minPrimaryItems?: number;
  maxPrimaryItems?: number;
  exactPrimaryItems?: number;
  minDevelopedItems?: number;
  minMechanismValueItems?: number;
  minCitedItems?: number;
  forbidInternalInventory?: boolean;
  requirePrioritizedOpening?: boolean;
  format?: ProjectChatAnswerFormat;
  requiredPatterns?: readonly string[];
  forbiddenPatterns?: readonly string[];
}

export interface ProjectChatAnswerQualityCheck {
  name: string;
  passed: boolean;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

export interface ProjectChatAnswerCitationMetadata {
  ordinal: number;
  type: string;
  title: string;
  excerpt?: string | null;
  statement?: string | null;
}

const GENERIC_FAILURE_PATTERNS = [
  /the answer could not be verified against its sources/i,
  /(?:unable|could(?: not|n't)|can(?: not|'t)) (?:to )?verif(?:y|ied) (?:the |this )?(?:answer|response|claim)/i,
  /the durable agent run failed unexpectedly/i,
  /the (?:agent|answer|response) (?:run )?failed unexpectedly/i,
  /grounding contract (?:failed|violation|error)/i,
  /verification (?:step|stage|pass) (?:failed|errored)/i,
  /\bno supported blocks?\b/i,
  /\b(?:ValidationException|ThrottlingException|ServiceUnavailableException)\b/,
  /\b(?:Error|Exception):\s+.*\n\s+at\s+/i,
  /\bat\s+(?:async\s+)?[\w$.<>]+\s*\([^)\n]+:\d+:\d+\)/i,
] as const;

const INTERNAL_INVENTORY_PATTERNS = [
  /\bcoverage note:/i,
  /\bwithin the \d+[- ]item (?:and|\/) \d+[- ]source answer limits?\b/i,
  /\b\d+ additional (?:capability areas?|supported facets?)\b/i,
  /\bRepositoryCapabilityLedger\b/,
  /\bRepositoryFileSnapshot\b/,
  /\b(?:analyzerVersion|policyVersion|semanticAnalysisVersion|staticAnalysisVersion)\b/,
] as const;

const readerThemePatterns: Record<ProjectChatReaderTheme, readonly RegExp[]> = {
  product_outcome: [
    /career[- ]content|resume bullet|linkedin|project[- ]summar/i,
    /artifact (?:generation|pipeline|workflow)|turns? .{0,80} into/i,
  ],
  repository_intelligence: [
    /repository (?:knowledge|refresh|analysis|research|snapshot|intelligence|lifecycle)/i,
    /github (?:oauth|ingestion|integration|repository)|semantic (?:analys|refresh)|stale knowledge/i,
  ],
  grounded_agent: [
    /project chat|multi[- ]turn|conversation history/i,
    /retriev|citation|provenance|ground(?:ed|ing)|bounded research/i,
  ],
  knowledge_governance: [
    /project fact|highlight (?:generation|review|lifecycle)|knowledge review/i,
    /approv|reconcil|supersed|stale|quarantin|human[- ]in[- ]the[- ]loop/i,
  ],
  durable_ai_platform: [
    /openrouter|bedrock|model provider|structured generation|schema[- ]constrained|tool use/i,
    /durable workflow|workflow orchestrat|retry[- ]safe|progress event/i,
  ],
  engineering_foundation: [
    /prisma|postgres|data model|database schema/i,
    /automated test|test coverage|vitest|security|oauth|workspace (?:review )?ui/i,
  ],
};

const mechanismPattern =
  /\b(?:by|through|use[sd]?|using|via|builds?|combines?|connects?|creates?|decides?|defines?|classifies?|edits?|fetches?|favors?|merges?|reuses?|re-?grounds?|reviews?|selects?|starts?|coordinates?|orchestrates?|enforces?|persists?|retrieves?|ingests?|refreshes?|reconciles?|validates?|routes?|delegates?|pins?|filters?|separates?|promotes?|applies?|generates?|quarantines?|records?|wraps?|divides?|executes?|consolidates?|prun(?:e|es|ing)|verif(?:y|ies|ication))\b/i;
const valuePattern =
  /\b(?:so that|which (?:lets|allows|enables|keeps|ensures|prevents)|enabl(?:e|es|ing)|allow(?:s|ing)?|ensur(?:e|es|ing)|prevent(?:s|ing)?|protect(?:s|ing)?|reduce(?:s|ing)?|avoid(?:s|ing)?|preserv(?:e|es|ing)|keeps?|supports?|turns?|rather than|without|result(?:s|ing)?)\b/i;
const claimPredicatePattern =
  /\b(?:analy[sz]es?|applies?|builds?|built|combines?|connects?|creates?|created|depends?|designed?|enforces?|generates?|implemented?|inspects?|keeps?|marks?|persists?|pins?|preserves?|prevents?|protects?|reconciles?|rejects?|retains?|retrieves?|routes?|runs?|selects?|starts?|stores?|supports?|supersedes?|synthesizes?|turns?|uses?|validates?|works?)\b/i;

const LOW_PRIORITY_OPENING_PATTERN =
  /\b(?:database schema|data model|prisma|test(?:ing)?|vitest|workspace ui|routes?|utilities|type definitions?|dependencies|configuration fields?)\b/i;

const MEANING_TOKEN_STOP_WORDS = new Set([
  "a",
  "about",
  "across",
  "after",
  "again",
  "against",
  "all",
  "also",
  "an",
  "and",
  "another",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "each",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "more",
  "most",
  "of",
  "on",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "same",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "up",
  "use",
  "used",
  "uses",
  "using",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "within",
  "without",
  "workbase",
  "would",
  "you",
  "your",
]);

const GENERIC_CLAIM_TOKENS = new Set([
  "application",
  "architecture",
  "build",
  "built",
  "capability",
  "created",
  "designed",
  "developed",
  "engineering",
  "implemented",
  "platform",
  "project",
  "service",
  "system",
]);

function matches(value: string, pattern: string) {
  return new RegExp(pattern, "iu").test(value);
}

function stripCitationMarkers(value: string) {
  return value
    .replace(/\[citation:\d+\]/giu, "")
    .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/gu, "")
    .trim();
}

function meaningfulHeading(value: string) {
  const normalized = value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim()
    .toLocaleLowerCase();
  return normalized.length > 0
    && !/^(?:workbase|summary|overview|answer|sources?|coverage note|strongest accomplishments(?: on workbase)?|top (?:three|\d+) accomplishments|(?:three|\d+) design trade-?offs?)$/.test(normalized);
}

export function projectChatPrimaryAnswerItems(answer: string) {
  const markdownHeadings = Array.from(answer.matchAll(/^#{2,4}\s+(.+)$/gmu))
    .filter((match) => meaningfulHeading(match[1] ?? ""));
  const numberedItems = Array.from(answer.matchAll(/^\s*\d+[.)]\s+(.+)$/gmu));
  const boldHeadings = Array.from(answer.matchAll(/^\s*\*\*([^*\n]{3,120})\*\*\s*$/gmu))
    .filter((match) => meaningfulHeading(match[1] ?? ""));
  const titledBullets = Array.from(
    answer.matchAll(/^\s*[-*+]\s+\*\*([^*\n]{3,120})\*\*(?::|\.)?/gmu),
  ).filter((match) => meaningfulHeading(match[1] ?? ""));
  return Math.max(markdownHeadings.length, numberedItems.length, boldHeadings.length, titledBullets.length);
}

export function splitProjectChatPrimaryAnswerItems(answer: string) {
  const headingStarts = Array.from(answer.matchAll(/^#{2,4}\s+.+$/gmu))
    .filter((match) => meaningfulHeading(match[0]))
    .map((match) => match.index ?? 0);
  const numberedStarts = Array.from(answer.matchAll(/^\s*\d+[.)]\s+.+$/gmu))
    .map((match) => match.index ?? 0);
  const boldStarts = Array.from(answer.matchAll(/^\s*\*\*[^*\n]{3,120}\*\*\s*$/gmu))
    .filter((match) => meaningfulHeading(match[0]))
    .map((match) => match.index ?? 0);
  const titledBulletStarts = Array.from(
    answer.matchAll(/^\s*[-*+]\s+\*\*[^*\n]{3,120}\*\*(?::|\.)?/gmu),
  )
    .filter((match) => meaningfulHeading(match[0]))
    .map((match) => match.index ?? 0);
  const starts = [headingStarts, numberedStarts, boldStarts, titledBulletStarts]
    .sort((left, right) => right.length - left.length)[0] ?? [];
  if (!starts.length) {
    return answer
      .split(/\n\s*\n/gu)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return starts.map((start, index) =>
    answer.slice(start, starts[index + 1] ?? answer.length).trim(),
  );
}

export function projectChatReaderThemes(answer: string) {
  return (Object.entries(readerThemePatterns) as Array<[ProjectChatReaderTheme, readonly RegExp[]]>)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(answer)))
    .map(([theme]) => theme);
}

function hasMarkdown(value: string) {
  return /(^|\n)(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|\|.+\|)/mu.test(value)
    || /\[[^\]]+\]\([^)]+\)/u.test(value)
    || /\*\*[^*]+\*\*/u.test(value);
}

function hasMarkdownTable(value: string) {
  return /^\s*\|.+\|\s*$/mu.test(value)
    && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/mu.test(value);
}

function paragraphCount(value: string) {
  return stripCitationMarkers(value)
    .split(/\n\s*\n/gu)
    .map((entry) => entry.trim())
    .filter(Boolean).length;
}

function blockProse(value: string) {
  return stripCitationMarkers(value)
    .replace(/^#{1,6}\s+.+(?:\n+|$)/u, "")
    .replace(/^\s*\*\*[^*\n]{3,120}\*\*\s*(?:\n+|$)/u, "")
    .replace(/^\s*\d+[.)]\s+(?:\*\*[^*\n]{3,160}\*\*\s*)?/u, "")
    .replace(/^\s*[-*+]\s+\*\*[^*\n]{3,160}\*\*(?::|\.)?\s*/u, "")
    .trim();
}

function normalizedMeaningTokens(value: string, omitGenericClaimTokens = false) {
  return Array.from(
    stripCitationMarkers(value)
      .toLocaleLowerCase()
      .matchAll(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu),
    (match) => match[0],
  )
    .map((token) => token.replace(/^[._-]+|[._-]+$/gu, ""))
    .filter((token) =>
      token.length >= 3
      && !MEANING_TOKEN_STOP_WORDS.has(token)
      && (!omitGenericClaimTokens || !GENERIC_CLAIM_TOKENS.has(token)),
    );
}

function blockHasClaimProse(value: string) {
  const prose = blockProse(value);
  const tokens = normalizedMeaningTokens(prose);
  const uniqueTokens = new Set(tokens);
  const sentenceWordCounts = prose
    .split(/(?<=[.!?])(?:\s+|$)|\n+/gu)
    .map((sentence) => normalizedMeaningTokens(sentence).length)
    .filter((count) => count > 0);
  return prose.length >= 100
    && uniqueTokens.size >= 14
    && sentenceWordCounts.some((count) => count >= 8)
    && claimPredicatePattern.test(prose);
}

function blockThemes(value: string) {
  return (Object.entries(readerThemePatterns) as Array<[ProjectChatReaderTheme, readonly RegExp[]]>)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(value)))
    .map(([theme]) => theme);
}

function setSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function primaryItemTokenSet(value: string) {
  return new Set(normalizedMeaningTokens(blockProse(value), true));
}

function distinctPrimaryItemCount(blocks: readonly string[], maximumSimilarity = 0.62) {
  const distinct: Set<string>[] = [];
  for (const block of blocks) {
    const tokens = primaryItemTokenSet(block);
    if (
      tokens.size > 0
      && distinct.every((prior) => setSimilarity(tokens, prior) < maximumSimilarity)
    ) {
      distinct.push(tokens);
    }
  }
  return distinct.length;
}

function citationOrdinals(value: string) {
  return Array.from(value.matchAll(/\[citation:(\d+)\]/giu), (match) => Number(match[1]))
    .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0);
}

function citationSupportBlocks(blocks: readonly string[]) {
  return blocks.flatMap((block, index) => {
    if (!citationOrdinals(block).length) return [];
    if (stripCitationMarkers(block).trim()) return [block];
    const prior = blocks.slice(0, index).reverse()
      .find((candidate) => stripCitationMarkers(candidate).trim());
    return prior ? [`${prior}\n${block}`] : [block];
  });
}

function prioritizedOpening(answer: string, blocks: readonly string[]) {
  const openingBlock = blocks[0] ?? answer;
  const opening = blockProse(openingBlock).slice(0, 700);
  const openingLine = openingBlock.split("\n", 1)[0] ?? "";
  // Numbered and bulleted items often put a bold title and prose on the same
  // line. Treat only the title as the heading; otherwise implementation verbs
  // in sound prose (for example "routes reviewed evidence") can be mistaken
  // for a low-value "Routes" inventory heading.
  const inlineTitle = openingLine.match(
    /^\s*(?:\d+[.)]|[-*+])\s+\*\*([^*\n]{3,160})\*\*/u,
  )?.[1];
  const openingHeading = (inlineTitle ?? openingLine)
    .replace(/^#{1,6}\s+/u, "")
    .replace(/[#*]/gu, "")
    .trim();
  const hasHighValueTheme = [
    ...readerThemePatterns.product_outcome,
    ...readerThemePatterns.repository_intelligence,
    ...readerThemePatterns.grounded_agent,
  ].some((pattern) => pattern.test(opening));
  return blockHasClaimProse(openingBlock)
    && mechanismPattern.test(opening)
    && valuePattern.test(opening)
    && hasHighValueTheme
    && !LOW_PRIORITY_OPENING_PATTERN.test(openingHeading);
}

export function evaluateProjectChatAnswerQuality(input: {
  answer: string;
  contract: ProjectChatAnswerQualityContract;
  citationMetadata?: readonly ProjectChatAnswerCitationMetadata[];
}): ProjectChatAnswerQualityCheck[] {
  const checks: ProjectChatAnswerQualityCheck[] = [];
  const answer = input.answer.trim();
  const contract = input.contract;
  const primaryItems = projectChatPrimaryAnswerItems(answer);
  const blocks = splitProjectChatPrimaryAnswerItems(answer);
  const developedBlocks = blocks.filter(blockHasClaimProse);
  const developedItems = developedBlocks.length;
  const mechanismValueItems = blocks.filter((block) =>
    mechanismPattern.test(block) && valuePattern.test(block),
  ).length;
  const citedItems = blocks.filter((block) => /\[citation:\d+\]/iu.test(block)).length;
  const themes = projectChatReaderThemes(answer);
  const developedThemes = new Set(developedBlocks.flatMap(blockThemes));
  const broadAnswerContract = (contract.minReaderThemes ?? 0) >= 3
    && Math.max(
      contract.exactPrimaryItems ?? 0,
      contract.minPrimaryItems ?? 0,
      contract.minDevelopedItems ?? 0,
    ) >= 3;
  const add = (
    name: string,
    passed: boolean,
    actual?: ProjectChatAnswerQualityCheck["actual"],
    expected?: ProjectChatAnswerQualityCheck["expected"],
  ) => checks.push({ name, passed, actual, expected });

  add(
    "answer does not expose an internal verification or agent failure",
    !GENERIC_FAILURE_PATTERNS.some((pattern) => pattern.test(answer)),
    GENERIC_FAILURE_PATTERNS.some((pattern) => pattern.test(answer)),
    false,
  );
  add(
    "answer does not expose internal conversation or provenance transport syntax",
    !projectChatAnswerExposesInternalProtocol(answer),
    projectChatAnswerExposesInternalProtocol(answer),
    false,
  );
  if (contract.forbidInternalInventory) {
    add(
      "answer does not expose internal coverage bookkeeping or schema inventory",
      !INTERNAL_INVENTORY_PATTERNS.some((pattern) => pattern.test(answer)),
      INTERNAL_INVENTORY_PATTERNS.some((pattern) => pattern.test(answer)),
      false,
    );
  }

  if (contract.minCharacters !== undefined) {
    add("answer has sufficient substance", answer.length >= contract.minCharacters, answer.length, contract.minCharacters);
  }
  if (contract.maxCharacters !== undefined) {
    add("answer respects the requested concision", answer.length <= contract.maxCharacters, answer.length, contract.maxCharacters);
  }
  if (contract.minReaderThemes !== undefined) {
    const coveredThemes = broadAnswerContract ? developedThemes.size : themes.length;
    add(
      "answer covers enough reader-facing project themes in developed claims",
      coveredThemes >= contract.minReaderThemes,
      coveredThemes,
      contract.minReaderThemes,
    );
  }
  if (contract.exactPrimaryItems !== undefined) {
    add("answer contains the exact requested number of primary items", primaryItems === contract.exactPrimaryItems, primaryItems, contract.exactPrimaryItems);
  } else {
    if (contract.minPrimaryItems !== undefined) {
      add("answer contains enough primary items", primaryItems >= contract.minPrimaryItems, primaryItems, contract.minPrimaryItems);
    }
    if (contract.maxPrimaryItems !== undefined) {
      add("answer avoids an exhaustive subsystem inventory", primaryItems <= contract.maxPrimaryItems, primaryItems, contract.maxPrimaryItems);
    }
  }
  if (contract.minDevelopedItems !== undefined) {
    add("answer develops its major points", developedItems >= contract.minDevelopedItems, developedItems, contract.minDevelopedItems);
  }
  if (contract.minMechanismValueItems !== undefined) {
    add(
      "answer connects implementation mechanisms to their value",
      mechanismValueItems >= contract.minMechanismValueItems,
      mechanismValueItems,
      contract.minMechanismValueItems,
    );
  }
  if (contract.minCitedItems !== undefined) {
    add(
      "answer grounds its major points with claim-local citations",
      citedItems >= contract.minCitedItems,
      citedItems,
      contract.minCitedItems,
    );
  }
  if (broadAnswerContract) {
    const expectedDistinctItems = Math.min(
      blocks.length,
      Math.max(3, contract.minDevelopedItems ?? 0),
    );
    const distinctItems = distinctPrimaryItemCount(developedBlocks);
    add(
      "answer presents substantively distinct major points",
      distinctItems >= expectedDistinctItems,
      distinctItems,
      expectedDistinctItems,
    );
    if (contract.minCitedItems !== undefined) {
      const distinctCitations = new Set(blocks.flatMap(citationOrdinals)).size;
      const expectedDistinctCitations = Math.min(
        contract.minCitedItems,
        Math.max(2, Math.ceil(contract.minCitedItems / 2)),
      );
      add(
        "answer uses enough distinct sources for a broad synthesis",
        distinctCitations >= expectedDistinctCitations,
        distinctCitations,
        expectedDistinctCitations,
      );
    }
  }
  if (input.citationMetadata) {
    const citedBlocks = citationSupportBlocks(blocks);
    const knownOrdinals = new Set(input.citationMetadata.map((source) => source.ordinal));
    const referencedOrdinals = new Set(citedBlocks.flatMap(citationOrdinals));
    const resolvedOrdinals = [...referencedOrdinals].filter((ordinal) => knownOrdinals.has(ordinal));
    add(
      "all citation markers resolve to supplied source metadata",
      resolvedOrdinals.length === referencedOrdinals.size,
      resolvedOrdinals.length,
      referencedOrdinals.size,
    );
  }
  if (contract.requirePrioritizedOpening) {
    const openingIsPrioritized = prioritizedOpening(answer, blocks);
    add(
      "answer opens with a developed, high-value capability and explains why it matters",
      openingIsPrioritized,
      openingIsPrioritized,
      true,
    );
  }
  if (contract.format === "markdown") {
    add("answer uses renderable Markdown", hasMarkdown(answer), hasMarkdown(answer), true);
  }
  if (contract.format === "table") {
    add("answer uses a valid Markdown table", hasMarkdownTable(answer), hasMarkdownTable(answer), true);
  }
  if (contract.format === "paragraphs") {
    const count = paragraphCount(answer);
    const hasStructuralMarkdown = /^#{1,6}\s+|^\s*(?:[-*+]|\d+[.)])\s+/mu.test(answer) || hasMarkdownTable(answer);
    add("answer uses prose paragraphs rather than a list or section inventory", !hasStructuralMarkdown, hasStructuralMarkdown, false);
    add("answer uses one to three concise paragraphs", count >= 1 && count <= 3, count, "1..3");
  }
  for (const pattern of contract.requiredPatterns ?? []) {
    add(`answer matches /${pattern}/iu`, matches(answer, pattern), matches(answer, pattern), true);
  }
  for (const pattern of contract.forbiddenPatterns ?? []) {
    add(`answer does not match /${pattern}/iu`, !matches(answer, pattern), matches(answer, pattern), false);
  }

  return checks;
}
