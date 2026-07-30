import type {
  FinalizedChatAnswer,
  GroundedAnswerBlock,
  ProjectKnowledgeCitation,
  ProjectResearchDossier,
} from "@/src/domain/project-chat";
import type { JsonValue } from "@/src/domain/types";
import {
  finalizeGroundedAnswer,
} from "@/src/services/chat-citation-service";
import {
  addSourceBoundedEditorialContext,
  buildExactSourceEditorialFallbackBlocks,
  selectProjectAnswerEditorialThemes,
  type ProjectAnswerComparisonContext,
  type ProjectAnswerEditorialSelection,
} from "@/src/services/project-answer-editorial-service";
import {
  detectGroundingContractIssues,
  groundProjectAnswer,
  type ProjectAnswerGroundingEntry,
  type ProjectAnswerGroundingMode,
} from "@/src/services/project-answer-grounding-service";

const authoritativeExactSourceAuthorities = new Set([
  "verified_project_fact",
  "verified_highlight",
  "included_evidence",
]);

const citationMarkerPattern = /\[citation:([^\]]*)\]/gi;

export type ProjectAnswerRecoveryOutcome =
  | "verified"
  | "verified_safe_subset"
  | "hybrid_recovery"
  | "source_exact_fallback"
  | "insufficient_context";

export interface ProjectAnswerRecoveryTelemetry {
  outcome: ProjectAnswerRecoveryOutcome;
  verifier: {
    status: "accepted" | "partial" | "empty" | "failed";
    returnedBlockCount: number;
    acceptedBlockCount: number;
    rejectedBlockCount: number;
    trimmedForItemLimit: number;
    issueCount: number;
    durationMs: number;
    tokenUsage: JsonValue | null;
    failure: {
      name: string;
      code: string | null;
    } | null;
  };
  fallback: {
    attempted: boolean;
    candidateBlockCount: number;
    acceptedBlockCount: number;
  };
  finalBlockCount: number;
  finalCitationCount: number;
  requestedBlockCount: {
    minimum: number;
    maximum: number;
  } | null;
  requestedBlockCountSatisfied: boolean;
}

export type ProjectAnswerRecoveryResult =
  | {
      status: "answered";
      finalized: FinalizedChatAnswer;
      blocks: GroundedAnswerBlock[];
      telemetry: ProjectAnswerRecoveryTelemetry;
      warnings: string[];
    }
  | {
      status: "insufficient_context";
      message: string;
      telemetry: ProjectAnswerRecoveryTelemetry;
      warnings: string[];
    };

type GroundingVerifier = typeof groundProjectAnswer;

function normalizedText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
}

const recoverySemanticStopWords = new Set([
  "and", "are", "as", "at", "be", "been", "being", "by", "for", "from",
  "has", "have", "in", "into", "is", "it", "its", "of", "on", "or", "that",
  "the", "their", "this", "through", "to", "using", "was", "were", "with",
]);

function recoverySemanticTokens(value: string) {
  return new Set(
    normalizedText(value)
      .split(" ")
      .filter((token) => token.length >= 3 && !recoverySemanticStopWords.has(token)),
  );
}

function semanticOverlap(left: string, right: string) {
  const leftTokens = recoverySemanticTokens(left);
  const rightTokens = recoverySemanticTokens(right);
  if (!leftTokens.size || !rightTokens.size) {
    return { jaccard: 0, containment: 0 };
  }
  const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return {
    jaccard: intersection / new Set([...leftTokens, ...rightTokens]).size,
    containment: intersection / Math.min(leftTokens.size, rightTokens.size),
  };
}

function sanitizeRecoveryHeading(value: string | null | undefined) {
  const sanitized = value
    ?.replace(citationMarkerPattern, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\[(?:\d+)(?:\s*,\s*\d+)*\]/g, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return sanitized || null;
}

/**
 * A grounded block represents one top-level editorial item. Model- or
 * source-authored headings inside its body would otherwise be rendered as
 * additional sections and could make a six-block answer visibly contain seven
 * or more items. Preserve their text as emphasis while keeping the structural
 * item count under application control.
 */
function sanitizeRecoveryBody(value: string, heading: string | null) {
  const lines = value.trim().split("\n");
  let inFence = false;
  return lines
    .flatMap((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return [line];
      }
      if (inFence) return [line];
      const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      const emphasizedHeadingMatch = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
      const nestedHeading = sanitizeRecoveryHeading(
        headingMatch?.[1] ?? emphasizedHeadingMatch?.[1],
      );
      if (!nestedHeading) return [line];
      if (normalizedText(nestedHeading) === normalizedText(heading ?? "")) {
        return [];
      }
      return headingMatch ? [`**${nestedHeading}**`] : [line];
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function uniqueValidIndexes(indexes: readonly number[], catalogLength: number) {
  return Array.from(new Set(indexes.filter((index) =>
    Number.isInteger(index) && index >= 1 && index <= catalogLength
  )));
}

function draftCitationIndexes(answer: string, catalogLength: number) {
  return new Set(
    Array.from(answer.matchAll(citationMarkerPattern))
      .map((match) => Number(match[1]?.trim()))
      .filter((index) =>
        Number.isInteger(index) && index >= 1 && index <= catalogLength
      ),
  );
}

function classifiedFailureIdentifier(candidate: unknown, fallback: string) {
  if (typeof candidate !== "string") return fallback;
  if (/throttl|too.?many.?requests|rate.?limit/i.test(candidate)) return "ThrottlingError";
  if (/timeout|timed.?out/i.test(candidate)) return "TimeoutError";
  if (/abort|cancel/i.test(candidate)) return "AbortError";
  if (/validation|malformed|schema|parse/i.test(candidate)) return "ValidationError";
  if (/access.?denied|unauthori[sz]ed|forbidden/i.test(candidate)) return "AccessDeniedError";
  if (/service.?unavailable|temporar(?:y|ily).?unavailable/i.test(candidate)) {
    return "ServiceUnavailableError";
  }
  if (/output.?limit|max.?tokens?/i.test(candidate)) return "OutputLimitError";
  if (/context.?limit|context.?window/i.test(candidate)) return "ContextLimitError";
  if (/provider|bedrock|model/i.test(candidate)) return "ProviderError";
  return fallback;
}

/**
 * Reduces provider and verifier failures to a fixed operational taxonomy.
 * Error names and codes are not trusted metadata: SDKs and intermediate
 * wrappers can copy raw provider details into either field.
 */
export function sanitizeProjectAnswerFailure(error: unknown) {
  const value = error as { name?: unknown; code?: unknown };
  return {
    name: classifiedFailureIdentifier(value?.name, "Error"),
    code: typeof value?.code === "string"
      ? classifiedFailureIdentifier(value.code, "ProviderError")
      : null,
  };
}

function serializeBlockForContract(block: GroundedAnswerBlock) {
  const markers = block.citationIndexes.map((index) => `[citation:${index}]`).join("");
  return [
    block.heading ? `### ${block.heading}` : null,
    `${block.bodyMarkdown} ${markers}`,
  ].filter(Boolean).join("\n");
}

function sanitizeCandidateBlocks(input: {
  blocks: readonly GroundedAnswerBlock[];
  entries: readonly ProjectAnswerGroundingEntry[];
  catalog: readonly ProjectKnowledgeCitation[];
  dossier?: ProjectResearchDossier | null;
  allowedCitationIndexes: ReadonlySet<number>;
  maxCitations: number;
}) {
  const accepted: GroundedAnswerBlock[] = [];
  let rejectedBlockCount = 0;
  for (const block of input.blocks) {
    const heading = sanitizeRecoveryHeading(block.heading);
    const bodyMarkdown = block.bodyMarkdown
      ? sanitizeRecoveryBody(block.bodyMarkdown, heading)
      : "";
    const citationIndexes = uniqueValidIndexes(block.citationIndexes ?? [], input.catalog.length);
    const validShape =
      Boolean(bodyMarkdown) &&
      citationIndexes.length >= 1 &&
      citationIndexes.length <= 6 &&
      citationIndexes.length === new Set(block.citationIndexes).size &&
      block.citationIndexes.every((index) => input.allowedCitationIndexes.has(index));
    if (!validShape) {
      rejectedBlockCount += 1;
      continue;
    }
    const candidate = { heading, bodyMarkdown: bodyMarkdown!, citationIndexes };
    const contractIssues = detectGroundingContractIssues({
      answer: serializeBlockForContract(candidate),
      citationCount: input.catalog.length,
      dossier: input.dossier,
      entries: input.entries,
    });
    if (contractIssues.length) {
      rejectedBlockCount += 1;
      continue;
    }
    try {
      finalizeGroundedAnswer({
        blocks: [candidate],
        catalog: input.catalog,
        maxCitations: input.maxCitations,
      });
      accepted.push(candidate);
    } catch {
      rejectedBlockCount += 1;
    }
  }
  return { accepted, rejectedBlockCount };
}

interface PlannedRecoveryTheme {
  key: string;
  label: string;
  order: number;
  citationIndexes: Set<number>;
  semanticText: string;
}

function plannedRecoveryThemes(selection?: ProjectAnswerEditorialSelection) {
  return (selection?.selectedThemes ?? []).map((theme, order) => ({
    key: theme.key,
    label: theme.label,
    order,
    citationIndexes: new Set(
      theme.members.flatMap((member) => member.entry.citationIndexes),
    ),
    semanticText: [
      theme.label,
      ...theme.representativeMembers.flatMap((member) => [
        member.entry.title,
        member.entry.content,
      ]),
    ].join(" "),
  } satisfies PlannedRecoveryTheme));
}

function matchingPlannedTheme(
  block: GroundedAnswerBlock,
  themes: readonly PlannedRecoveryTheme[],
) {
  if (!themes.length) return null;
  const blockText = `${block.heading ?? ""} ${block.bodyMarkdown}`;
  const normalizedHeading = normalizedText(block.heading ?? "");
  const ranked = themes
    .map((theme) => {
      const citationOverlap = block.citationIndexes.filter((index) =>
        theme.citationIndexes.has(index)
      ).length;
      const semantic = semanticOverlap(blockText, theme.semanticText);
      const exactHeading = normalizedHeading === normalizedText(theme.label);
      return {
        theme,
        citationOverlap,
        score:
          Number(exactHeading) * 100 +
          citationOverlap * 20 +
          semantic.containment * 10 +
          semantic.jaccard * 5,
      };
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.citationOverlap - left.citationOverlap ||
      left.theme.order - right.theme.order
    );
  const best = ranked[0];
  if (!best) return null;
  return best.citationOverlap > 0 ||
    normalizedHeading === normalizedText(best.theme.label)
    ? best.theme
    : null;
}

function semanticallyDuplicateBlocks(
  left: GroundedAnswerBlock,
  right: GroundedAnswerBlock,
) {
  const leftBody = normalizedText(left.bodyMarkdown);
  const rightBody = normalizedText(right.bodyMarkdown);
  if (!leftBody || !rightBody) return false;
  if (leftBody === rightBody) return true;
  const bodyOverlap = semanticOverlap(left.bodyMarkdown, right.bodyMarkdown);
  const combinedOverlap = semanticOverlap(
    `${left.heading ?? ""} ${left.bodyMarkdown}`,
    `${right.heading ?? ""} ${right.bodyMarkdown}`,
  );
  return bodyOverlap.jaccard >= 0.58 ||
    bodyOverlap.containment >= 0.78 ||
    combinedOverlap.jaccard >= 0.62;
}

function mergeDistinctBlocks(
  primary: readonly GroundedAnswerBlock[],
  secondary: readonly GroundedAnswerBlock[],
  selection?: ProjectAnswerEditorialSelection,
  normalizePlannedHeadings = false,
) {
  const themes = plannedRecoveryThemes(selection);
  const merged: Array<{
    block: GroundedAnswerBlock;
    theme: PlannedRecoveryTheme | null;
    insertionOrder: number;
  }> = [];
  const representedThemeKeys = new Set<string>();
  const usedCitationIndexes = new Set(primary.flatMap((block) => block.citationIndexes));
  // When filling an incomplete answer, cover unused authoritative sources
  // before adding a second distinct facet from a citation already represented.
  // Equal citation sets remain allowed; they simply do not crowd broader
  // source coverage out of a bounded item count.
  const orderedSecondary = [...secondary].sort((left, right) =>
    Number(right.citationIndexes.some((index) => !usedCitationIndexes.has(index))) -
    Number(left.citationIndexes.some((index) => !usedCitationIndexes.has(index)))
  );
  for (const [insertionOrder, rawBlock] of [...primary, ...orderedSecondary].entries()) {
    const theme = matchingPlannedTheme(rawBlock, themes);
    const heading =
      normalizePlannedHeadings && theme
        ? theme.label
        : sanitizeRecoveryHeading(rawBlock.heading);
    const bodyMarkdown = sanitizeRecoveryBody(rawBlock.bodyMarkdown, heading);
    if (!bodyMarkdown) continue;
    const block = { ...rawBlock, heading, bodyMarkdown };
    // The editorial contract is one independently citable top-level item per
    // selected theme. A verifier block and an exact-source recovery block for
    // the same theme are alternatives, not two accomplishments.
    if (theme && representedThemeKeys.has(theme.key)) continue;
    if (merged.some((candidate) =>
      // Planned themes are already an explicit semantic partition. Similar
      // phrasing across two distinct planned capabilities (for example,
      // "reviewed project knowledge workflow") must not collapse them.
      !candidate.theme &&
      !theme &&
      semanticallyDuplicateBlocks(candidate.block, block)
    )) {
      continue;
    }
    if (theme) representedThemeKeys.add(theme.key);
    for (const index of block.citationIndexes) usedCitationIndexes.add(index);
    merged.push({ block, theme, insertionOrder });
  }
  // Stable planned headings and the selection's ranked theme order take
  // precedence over provider ordering. Unplanned but valid blocks remain
  // eligible after the planned answer.
  return merged
    .sort((left, right) =>
      (left.theme?.order ?? Number.MAX_SAFE_INTEGER) -
        (right.theme?.order ?? Number.MAX_SAFE_INTEGER) ||
      left.insertionOrder - right.insertionOrder
    )
    .map(({ block }) => block);
}

function collectFinalizableBlocks(input: {
  blocks: readonly GroundedAnswerBlock[];
  catalog: readonly ProjectKnowledgeCitation[];
  maximumBlocks: number;
  maxCitations: number;
}) {
  const accepted: GroundedAnswerBlock[] = [];
  for (const block of input.blocks) {
    if (accepted.length >= input.maximumBlocks) break;
    try {
      finalizeGroundedAnswer({
        blocks: [...accepted, block],
        catalog: input.catalog,
        maxCitations: input.maxCitations,
      });
      accepted.push(block);
    } catch {
      // Keep independently valid blocks even when adding this block would
      // exceed the aggregate citation budget or violate the final contract.
    }
  }
  return accepted;
}

function exactEntryFallbackBlocks(input: {
  selection: ProjectAnswerEditorialSelection;
  catalog: readonly ProjectKnowledgeCitation[];
}) {
  const selectedEntries = new Set(
    input.selection.selectedThemes.flatMap((theme) =>
      theme.members.map((member) => member.entry)
    ),
  );
  if (!selectedEntries.size) return [];
  return input.selection.rankedEntries.flatMap(({ entry }) => {
    if (!selectedEntries.has(entry)) return [];
    if (!authoritativeExactSourceAuthorities.has(entry.authority)) return [];
    const bodyMarkdown = entry.content
      .replace(citationMarkerPattern, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
    const heading = entry.title
      .replace(citationMarkerPattern, "")
      .replace(/\[(?:\d+)(?:\s*,\s*\d+)*\]/g, "")
      .replace(/^#{1,6}\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    const citationIndexes = uniqueValidIndexes(entry.citationIndexes, input.catalog.length).slice(0, 6);
    return bodyMarkdown && citationIndexes.length
      ? [{ heading: heading || null, bodyMarkdown, citationIndexes }]
      : [];
  });
}

function requestedCountSatisfied(
  count: number,
  requiredBlockCount: { minimum: number; maximum: number } | null,
) {
  return !requiredBlockCount ||
    (count >= requiredBlockCount.minimum && count <= requiredBlockCount.maximum);
}

function insufficientContextMessage(input: {
  question: string;
  entries: readonly ProjectAnswerGroundingEntry[];
  catalog: readonly ProjectKnowledgeCitation[];
}) {
  const topic = input.question.replace(/\s+/g, " ").trim().slice(0, 220);
  if (!input.entries.length || !input.catalog.length) {
    return `I could not find active approved Project Facts, Highlights, or included evidence for “${topic}”. Refresh the project knowledge or add supporting project context, then try again.`;
  }
  return `The active project memory did not contain citation-valid support for “${topic}”. Refresh the project knowledge or add a reviewed Project Fact or Highlight for that specific area, then try again.`;
}

function visibleCoverageLimit(input: {
  supportedCount: number;
  requiredBlockCount: { minimum: number; maximum: number };
  selection: ProjectAnswerEditorialSelection;
}) {
  const requested = input.requiredBlockCount.minimum === input.requiredBlockCount.maximum
    ? String(input.requiredBlockCount.minimum)
    : `${input.requiredBlockCount.minimum}–${input.requiredBlockCount.maximum}`;
  const omitted = input.selection.omittedThemes
    .slice(0, 3)
    .map((theme) => theme.label);
  return [
    `> **Coverage limit:** Current approved project memory supports ${input.supportedCount} of the requested ${requested} independently cited items.`,
    omitted.length ? `Missing or lower-confidence areas: ${omitted.join(", ")}.` : null,
    "I kept the supported subset instead of inventing the remainder.",
  ].filter(Boolean).join(" ");
}

/**
 * Verifies a drafted answer without making semantic verification a terminal
 * dependency. The service preserves valid verifier blocks, supplements them
 * from exact approved memory when necessary, and returns a specific evidence
 * gap only when no citation-valid block can be published.
 */
export async function verifyProjectAnswerWithRecovery(input: {
  question: string;
  draftAnswer: string;
  entries: ProjectAnswerGroundingEntry[];
  catalog: ProjectKnowledgeCitation[];
  dossier?: ProjectResearchDossier | null;
  freshness?: FinalizedChatAnswer["freshness"];
  selection?: ProjectAnswerEditorialSelection;
  requiredBlockCount?: { minimum: number; maximum: number };
  maxCitations?: number;
  verifier?: GroundingVerifier;
  forceExactFallback?: boolean;
  verificationMode?: ProjectAnswerGroundingMode;
  comparisonContext?: ProjectAnswerComparisonContext;
}): Promise<ProjectAnswerRecoveryResult> {
  const maxCitations = Math.max(1, Math.min(20, input.maxCitations ?? 20));
  const verifier = input.verifier ?? groundProjectAnswer;
  const selection = input.selection ?? selectProjectAnswerEditorialThemes({
    question: input.question,
    entries: input.entries,
  });
  const requiredBlockCount = input.requiredBlockCount ?? selection.profile.targetItemCount;
  const referencedDraftIndexes = draftCitationIndexes(input.draftAnswer, input.catalog.length);
  let verifierReturnedBlockCount = 0;
  let verifierRejectedBlockCount = 0;
  let verifierIssueCount = 0;
  let verifierDurationMs = 0;
  let verifierTokenUsage: JsonValue | null = null;
  let verifierFailure: ProjectAnswerRecoveryTelemetry["verifier"]["failure"] = null;
  let safeVerifierBlocks: GroundedAnswerBlock[] = [];

  if (!input.forceExactFallback) {
    const verifierStartedAt = Date.now();
    try {
      const verified = await verifier({
        answer: input.draftAnswer,
        entries: input.entries,
        citationCount: input.catalog.length,
        dossier: input.dossier,
        requiredBlockCount,
        singleAttempt: true,
        verificationMode: input.verificationMode,
        requestContext: {
          question: input.question,
          comparisonContract: selection.profile.comparisonContract,
          conversation: input.comparisonContext ?? null,
        },
      });
      verifierReturnedBlockCount = verified.blocks.length;
      verifierIssueCount = verified.issues.length;
      verifierTokenUsage = verified.tokenUsage;
      const sanitized = sanitizeCandidateBlocks({
        blocks: verified.blocks,
        entries: input.entries,
        catalog: input.catalog,
        dossier: input.dossier,
        allowedCitationIndexes: referencedDraftIndexes,
        maxCitations,
      });
      safeVerifierBlocks = sanitized.accepted;
      verifierRejectedBlockCount = sanitized.rejectedBlockCount;
    } catch (error) {
      verifierFailure = sanitizeProjectAnswerFailure(error);
    } finally {
      verifierDurationMs = Math.max(0, Date.now() - verifierStartedAt);
    }
  }

  const maximumBlocks = Math.max(1, requiredBlockCount.maximum);
  const distinctVerifierBlocks = mergeDistinctBlocks(
    safeVerifierBlocks,
    [],
    selection,
  );
  const limitedVerifierBlocks = collectFinalizableBlocks({
    blocks: distinctVerifierBlocks,
    catalog: input.catalog,
    maximumBlocks,
    maxCitations,
  });
  const trimmedForItemLimit = Math.max(
    0,
    distinctVerifierBlocks.length - limitedVerifierBlocks.length,
  );
  const verifierSatisfiesCount = requestedCountSatisfied(
    limitedVerifierBlocks.length,
    requiredBlockCount,
  );

  let fallbackAttempted = false;
  let fallbackCandidateBlockCount = 0;
  let acceptedFallbackBlockCount = 0;
  let finalBlocks = limitedVerifierBlocks;
  if (!verifierSatisfiesCount) {
    fallbackAttempted = true;
    const exactCitationIndexes = new Set(
      input.entries
        .filter((entry) => authoritativeExactSourceAuthorities.has(entry.authority))
        .flatMap((entry) => entry.citationIndexes)
        .filter((index) =>
          Number.isInteger(index) && index >= 1 && index <= input.catalog.length
        ),
    );
    // Emergency recovery is deliberately source-exact. Editorial value and
    // assessment prose is useful in the normal drafting path, but appending it
    // after semantic verification failed would make the fallback less strict
    // than the verifier it replaces.
    const themeFallback = buildExactSourceEditorialFallbackBlocks(selection);
    const directFallback = exactEntryFallbackBlocks({ selection, catalog: input.catalog });
    const fallbackCandidates = mergeDistinctBlocks(
      themeFallback,
      directFallback,
      selection,
      true,
    );
    fallbackCandidateBlockCount = fallbackCandidates.length;
    const sanitizedFallback = sanitizeCandidateBlocks({
      blocks: fallbackCandidates,
      entries: input.entries,
      catalog: input.catalog,
      dossier: input.dossier,
      allowedCitationIndexes: exactCitationIndexes,
      maxCitations,
    }).accepted;
    const combined = mergeDistinctBlocks(
      limitedVerifierBlocks,
      sanitizedFallback,
      selection,
      true,
    );
    finalBlocks = collectFinalizableBlocks({
      blocks: combined,
      catalog: input.catalog,
      maximumBlocks,
      maxCitations,
    });
    // collectFinalizableBlocks is already bounded, but keep the publication
    // boundary explicit so later recovery changes cannot accidentally bypass
    // the user's hard editorial maximum.
    finalBlocks = finalBlocks.slice(0, maximumBlocks);
    acceptedFallbackBlockCount = Math.max(0, finalBlocks.length - limitedVerifierBlocks.length);
  }

  if (!finalBlocks.length) {
    const telemetry: ProjectAnswerRecoveryTelemetry = {
      outcome: "insufficient_context",
      verifier: {
        status: verifierFailure
          ? "failed"
          : verifierReturnedBlockCount
            ? "partial"
            : "empty",
        returnedBlockCount: verifierReturnedBlockCount,
        acceptedBlockCount: 0,
        rejectedBlockCount: verifierRejectedBlockCount,
        trimmedForItemLimit,
        issueCount: verifierIssueCount,
        durationMs: verifierDurationMs,
        tokenUsage: verifierTokenUsage,
        failure: verifierFailure,
      },
      fallback: {
        attempted: fallbackAttempted,
        candidateBlockCount: fallbackCandidateBlockCount,
        acceptedBlockCount: 0,
      },
      finalBlockCount: 0,
      finalCitationCount: 0,
      requestedBlockCount: requiredBlockCount,
      requestedBlockCountSatisfied: false,
    };
    return {
      status: "insufficient_context",
      message: insufficientContextMessage({
        question: input.question,
        entries: input.entries,
        catalog: input.catalog,
      }),
      telemetry,
      warnings: verifierFailure
        ? ["Semantic verification was unavailable and no citation-valid approved memory could recover the answer."]
        : ["No citation-valid approved memory supported the requested answer."],
    };
  }

  // Exact recovery may preserve ordering and user-visible comparison labels,
  // but it cannot append canned analytical claims after the verifier failed.
  // Assessment prose must either survive entailment or fail closed upstream.
  if (selection.profile.kind === "comparison") {
    finalBlocks = addSourceBoundedEditorialContext(finalBlocks, selection);
  }

  const countSatisfied = requestedCountSatisfied(finalBlocks.length, requiredBlockCount);
  const grounded = finalizeGroundedAnswer({
    blocks: finalBlocks,
    catalog: input.catalog,
    maxCitations,
    freshness: input.freshness,
  });
  const finalized = countSatisfied
    ? grounded
    : {
        ...grounded,
        markdown: [
          grounded.markdown,
          visibleCoverageLimit({
            supportedCount: finalBlocks.length,
            requiredBlockCount,
            selection,
          }),
        ].join("\n\n"),
      };
  const verifierStatus: ProjectAnswerRecoveryTelemetry["verifier"]["status"] =
    verifierFailure
      ? "failed"
      : verifierReturnedBlockCount === 0
        ? "empty"
        : verifierRejectedBlockCount || limitedVerifierBlocks.length < verifierReturnedBlockCount
          ? "partial"
          : "accepted";
  const outcome: ProjectAnswerRecoveryOutcome =
    acceptedFallbackBlockCount > 0 && limitedVerifierBlocks.length > 0
      ? "hybrid_recovery"
      : acceptedFallbackBlockCount > 0
        ? "source_exact_fallback"
        : verifierStatus === "accepted"
          ? "verified"
          : "verified_safe_subset";
  const telemetry: ProjectAnswerRecoveryTelemetry = {
    outcome,
    verifier: {
      status: verifierStatus,
      returnedBlockCount: verifierReturnedBlockCount,
      acceptedBlockCount: limitedVerifierBlocks.length,
      rejectedBlockCount: verifierRejectedBlockCount,
      trimmedForItemLimit,
      issueCount: verifierIssueCount,
      durationMs: verifierDurationMs,
      tokenUsage: verifierTokenUsage,
      failure: verifierFailure,
    },
    fallback: {
      attempted: fallbackAttempted,
      candidateBlockCount: fallbackCandidateBlockCount,
      acceptedBlockCount: acceptedFallbackBlockCount,
    },
    finalBlockCount: finalBlocks.length,
    finalCitationCount: finalized.citations.length,
    requestedBlockCount: requiredBlockCount,
    requestedBlockCountSatisfied: countSatisfied,
  };
  const warnings = [
    verifierFailure
      ? "Semantic verification was unavailable; the answer was recovered from citation-valid approved project memory."
      : null,
    verifierRejectedBlockCount
      ? "Unsupported or citation-invalid drafted claims were omitted."
      : null,
    !countSatisfied
      ? `Only ${finalBlocks.length} citation-valid item${finalBlocks.length === 1 ? "" : "s"} were available for the requested ${requiredBlockCount.minimum === requiredBlockCount.maximum ? requiredBlockCount.minimum : `${requiredBlockCount.minimum}–${requiredBlockCount.maximum}`}.`
      : null,
  ].filter((warning): warning is string => Boolean(warning));
  return {
    status: "answered",
    finalized,
    blocks: finalBlocks,
    telemetry,
    warnings,
  };
}
