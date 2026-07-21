import type {
  AnswerCitationPolicy,
  ProjectKnowledgeCitation,
  ProjectResearchDossier,
  ProjectResearchFinding,
  ProjectResearchResult,
} from "@/src/domain/project-chat";
import {
  evaluateDeterministicAnswerGrounding,
  type ProjectAnswerGroundingEntry,
} from "@/src/services/project-answer-grounding-service";
import {
  CitationIntegrityError,
  finalizeGroundedAnswer,
} from "@/src/services/chat-citation-service";

const modelAuthoredCitationPattern =
  /\[citation:[^\]]*\]|\[(?:\d+)(?:\s*,\s*\d+)*\]/i;
const MAX_VISIBLE_RESEARCH_BLOCKS = 8;
const MAX_VISIBLE_RESEARCH_CITATIONS = 20;
const internalFailureDetailPattern =
  /\b(?:validationexception|accessdeniedexception|throttlingexception|serviceunavailableexception|the answer could not be verified against its sources|grounding verifier|citation integrity|stack trace)\b|(?:^|\s)at\s+\S+\s*\(/i;

type NormalizedResearchStatus =
  | "answered"
  | "awaiting_review"
  | "insufficient_context";

function answerCitationIndexes(answer: string, citationCount: number) {
  const markers = Array.from(answer.matchAll(/\[citation:([^\]]*)\]/gi));
  return {
    hasMarkers: markers.length > 0,
    indexes: new Set(
      markers
        .map((marker) => Number(marker[1]?.trim()) - 1)
        .filter((index) =>
          Number.isInteger(index) && index >= 0 && index < citationCount
        ),
    ),
  };
}

export interface NormalizedProjectResearchResult {
  status: NormalizedResearchStatus;
  answer: string;
  citations: ProjectKnowledgeCitation[];
  citationPolicy: AnswerCitationPolicy;
  groundedClaims: Array<{
    claim: string;
    citationIndexes: number[];
  }>;
  research: ProjectResearchResult;
  diagnostics: {
    inputStatus: ProjectResearchResult["status"];
    fallbackUsed: boolean;
    discardedCitationCount: number;
    discardedFindingCount: number;
    reason:
      | "normalized_supported_findings"
      | "normalized_supported_answer_blocks"
      | "awaiting_review"
      | "research_failed"
      | "research_insufficient"
      | "empty_answer"
      | "no_durable_supported_claim";
  };
}

function durableCitationIdentity(citation: ProjectKnowledgeCitation) {
  if (citation.kind === "project_fact") return citation.projectFactId;
  if (citation.kind === "highlight") return citation.highlightId;
  if (citation.kind === "evidence") return citation.evidenceItemId;
  return null;
}

function isDurablePeerCitation(citation: ProjectKnowledgeCitation) {
  return Boolean(
    durableCitationIdentity(citation) &&
    citation.label.trim() &&
    citation.excerpt.trim(),
  );
}

function authorityForCitation(
  citation: ProjectKnowledgeCitation,
): ProjectAnswerGroundingEntry["authority"] {
  if (citation.kind === "project_fact") return "verified_project_fact";
  if (citation.kind === "highlight") return "verified_highlight";
  return "included_evidence";
}

function groundingEntries(
  citations: readonly ProjectKnowledgeCitation[],
): ProjectAnswerGroundingEntry[] {
  return citations.flatMap((citation, index) => {
    if (!isDurablePeerCitation(citation)) return [];
    return [{
      kind: citation.kind,
      authority: authorityForCitation(citation),
      title: citation.label,
      content: citation.excerpt,
      currentRun: citation.kind === "project_fact",
      citationIndexes: [index + 1],
      supportingSources: citation.provenance?.map((source) => ({
        type: "evidence",
        title: source.title,
        path: source.path,
        commitSha: source.commitSha,
      })) ?? [],
    }];
  });
}

function findingCandidateBlocks(input: {
  result: ProjectResearchResult;
  entries: ProjectAnswerGroundingEntry[];
  referencedIndexes: ReadonlySet<number>;
  restrictToAnswerCitations: boolean;
  dossier?: ProjectResearchDossier | null;
}) {
  const blocks: Array<{
    bodyMarkdown: string;
    citationIndexes: number[];
  }> = [];
  const seen = new Set<string>();
  let discardedFindingCount = 0;

  for (const finding of input.result.findings) {
    const statement = finding.statement.trim();
    const sourceIndexes = Array.from(new Set(finding.citationIndexes));
    const validIndexes = sourceIndexes.filter((index) =>
      Number.isInteger(index) &&
      index >= 0 &&
      index < input.result.citations.length &&
      isDurablePeerCitation(input.result.citations[index]!)
    );
    const key = statement.toLowerCase().replace(/\s+/g, " ");
    const wasReferenced =
      !input.restrictToAnswerCitations ||
      validIndexes.every((index) => input.referencedIndexes.has(index));

    if (
      !statement ||
      statement.length > 2_000 ||
      modelAuthoredCitationPattern.test(statement) ||
      !sourceIndexes.length ||
      validIndexes.length !== sourceIndexes.length ||
      !wasReferenced ||
      seen.has(key)
    ) {
      discardedFindingCount += 1;
      continue;
    }

    const citationIndexes = validIndexes.map((index) => index + 1);
    const candidate = `${statement} ${citationIndexes
      .map((index) => `[citation:${index}]`)
      .join("")}`;
    const grounding = evaluateDeterministicAnswerGrounding({
      answer: candidate,
      entries: input.entries,
      citationCount: input.result.citations.length,
      dossier: input.dossier,
      requiredBlockCount: { minimum: 1, maximum: 1 },
    });
    if (grounding.safeBlocks.length !== 1) {
      discardedFindingCount += 1;
      continue;
    }
    seen.add(key);
    blocks.push({
      bodyMarkdown: grounding.safeBlocks[0]!.bodyMarkdown,
      citationIndexes: grounding.safeBlocks[0]!.citationIndexes,
    });
    if (blocks.length >= MAX_VISIBLE_RESEARCH_BLOCKS) break;
  }

  return { blocks, discardedFindingCount };
}

function exactAnswerCandidateBlocks(input: {
  result: ProjectResearchResult;
  entries: ProjectAnswerGroundingEntry[];
  dossier?: ProjectResearchDossier | null;
}) {
  const grounding = evaluateDeterministicAnswerGrounding({
    answer: input.result.answer,
    entries: input.entries,
    citationCount: input.result.citations.length,
    dossier: input.dossier,
  });
  return grounding.safeBlocks.slice(0, MAX_VISIBLE_RESEARCH_BLOCKS);
}

function firstCoverageGap(result: ProjectResearchResult) {
  return result.coverageGaps
    .map((gap) => gap.trim())
    .find((gap) =>
      Boolean(gap) &&
      gap.length <= 500 &&
      !internalFailureDetailPattern.test(gap)
    ) ?? null;
}

function userRelevantCoverageGaps(result: ProjectResearchResult) {
  const safe = result.coverageGaps
    .map((gap) => gap.trim())
    .filter((gap) =>
      gap &&
      gap.length <= 500 &&
      !internalFailureDetailPattern.test(gap)
    );
  return Array.from(new Set(safe.filter((gap) =>
    /\b(?:did not|does not|could not|unable|missing|unknown|not established|not inspected|not found|incomplete|stopped)\b/i.test(gap) &&
    !/^\d+\s+additional safe candidate paths?\b/i.test(gap)
  ))).slice(0, 3);
}

function safeWarnings(warnings: readonly string[]) {
  return warnings.filter((warning) =>
    warning.trim() &&
    warning.length <= 500 &&
    !internalFailureDetailPattern.test(warning)
  );
}

function insufficientAnswer(
  result: ProjectResearchResult,
  reason: "research_failed" | "research_insufficient" | "empty_answer" | "no_durable_supported_claim",
) {
  const prefix = reason === "research_failed"
    ? "Repository research stopped before it could produce a supported answer."
    : reason === "research_insufficient"
      ? "Repository research did not find enough supported project evidence to answer this question."
      : reason === "empty_answer"
        ? "Repository research completed, but it did not produce a user-facing answer."
        : "Repository research completed, but no durable Project Fact, Highlight, or included evidence supported a user-facing answer.";
  const gap = firstCoverageGap(result);
  return gap ? `${prefix} Remaining evidence gap: ${gap}` : prefix;
}

function insufficientResult(input: {
  result: ProjectResearchResult;
  reason: "research_failed" | "research_insufficient" | "empty_answer" | "no_durable_supported_claim";
  discardedFindingCount?: number;
}): NormalizedProjectResearchResult {
  const answer = insufficientAnswer(input.result, input.reason);
  const research: ProjectResearchResult = {
    ...input.result,
    status: "insufficient_context",
    answer,
    findings: [],
    citations: [],
    groundedClaims: [],
    warnings: safeWarnings(input.result.warnings),
  };
  return {
    status: "insufficient_context",
    answer,
    citations: [],
    citationPolicy: "none",
    groundedClaims: [],
    research,
    diagnostics: {
      inputStatus: input.result.status,
      fallbackUsed: input.result.status === "answered",
      discardedCitationCount: input.result.citations.length,
      discardedFindingCount:
        input.discardedFindingCount ?? input.result.findings.length,
      reason: input.reason,
    },
  };
}

function awaitingReviewResult(
  result: ProjectResearchResult,
): NormalizedProjectResearchResult {
  const candidateCount = result.candidateIds.length;
  const answer = candidateCount
    ? `Repository research produced ${candidateCount} Project Fact candidate${candidateCount === 1 ? "" : "s"} that must be reviewed before they can support an answer.`
    : "Repository research produced a Project Fact candidate that must be reviewed before it can support an answer.";
  return {
    status: "awaiting_review",
    answer,
    citations: [],
    citationPolicy: "none",
    groundedClaims: [],
    research: {
      ...result,
      answer,
      findings: [],
      citations: [],
      groundedClaims: [],
      warnings: safeWarnings(result.warnings),
    },
    diagnostics: {
      inputStatus: result.status,
      fallbackUsed: false,
      discardedCitationCount: result.citations.length,
      discardedFindingCount: result.findings.length,
      reason: "awaiting_review",
    },
  };
}

/**
 * Converts a repository-research result into the only form chat may persist or
 * display. Project Fact finding indexes are zero-based (the research service's
 * internal convention); rendered citation markers are one-based.
 *
 * Newly explored GitHub excerpts remain in `research.exploredEvidence` for the
 * audit trail. They are never eligible as peer citations here.
 */
export function normalizeProjectResearchResultForChat(input: {
  result: ProjectResearchResult;
  dossier?: ProjectResearchDossier | null;
}): NormalizedProjectResearchResult {
  const { result } = input;
  if (result.status === "awaiting_review") {
    return awaitingReviewResult(result);
  }
  if (!result.answer.trim() && !result.findings.length) {
    return insufficientResult({
      result,
      reason: result.status === "failed"
        ? "research_failed"
        : result.status === "insufficient_context"
          ? "research_insufficient"
          : "empty_answer",
    });
  }

  const entries = groundingEntries(result.citations);
  const referenced = answerCitationIndexes(
    result.answer,
    result.citations.length,
  );
  const recoveredFromIncompleteRun =
    result.status === "failed" || result.status === "insufficient_context";
  const findings = findingCandidateBlocks({
    result,
    entries,
    referencedIndexes: referenced.indexes,
    restrictToAnswerCitations:
      !recoveredFromIncompleteRun && referenced.hasMarkers,
    dossier: input.dossier,
  });
  const answerBlocks = exactAnswerCandidateBlocks({
    result,
    entries,
    dossier: input.dossier,
  });
  const seenBlocks = new Set<string>();
  // Structured findings are already the source-bounded, independently
  // citable representation of a successful research answer. Appending the
  // prose answer as another block often repeats the same facts beneath an
  // introductory sentence. Only union both channels when recovering a safe
  // subset from an incomplete run, where either channel may contain a unique
  // supported fact that would otherwise be lost.
  const candidateBlocks = recoveredFromIncompleteRun
    ? [...findings.blocks, ...answerBlocks]
    : findings.blocks.length
      ? findings.blocks
      : answerBlocks;
  const blocks = candidateBlocks
    .filter((block) => {
      const key = `${block.bodyMarkdown.toLowerCase().replace(/\s+/g, " ")}::${block.citationIndexes.join(",")}`;
      if (seenBlocks.has(key)) return false;
      seenBlocks.add(key);
      return true;
    })
    .slice(0, MAX_VISIBLE_RESEARCH_BLOCKS);

  if (!blocks.length) {
    return insufficientResult({
      result,
      reason: result.status === "failed"
        ? "research_failed"
        : result.status === "insufficient_context"
          ? "research_insufficient"
          : "no_durable_supported_claim",
      discardedFindingCount: findings.discardedFindingCount,
    });
  }

  try {
    const finalized = finalizeGroundedAnswer({
      blocks,
      catalog: result.citations,
      maxCitations: MAX_VISIBLE_RESEARCH_CITATIONS,
    });
    const usedCitationIds = new Set(finalized.citations.map(durableCitationIdentity));
    const normalizedFindings: ProjectResearchFinding[] = finalized.groundedClaims.map((claim) => ({
      statement: claim.claim,
      confidence: "medium",
      isInference: false,
      citationIndexes: claim.citationIndexes.map((index) => index - 1),
    }));
    // A bounded pass can successfully recover several supported facts while
    // still failing to establish another behavior the user explicitly asked
    // about (for example, retry/backoff alongside loop exits). That boundary is
    // useful even when the overall pass is not marked partial: omitting it
    // makes a complete-looking answer silently dodge part of the question.
    const recoveryGap =
      "Repository research stopped before complete coverage; this answer contains only the supported subset recovered before the stop.";
    const relevantGaps = userRelevantCoverageGaps({
      ...result,
      coverageGaps: recoveredFromIncompleteRun
        ? [...result.coverageGaps, recoveryGap]
        : result.coverageGaps,
    });
    const evidenceBoundary = relevantGaps.length === 1
      ? `> **Evidence gap:** ${relevantGaps[0]}`
      : relevantGaps.length > 1
        ? [
            "> **Evidence gaps:**",
            ...relevantGaps.map((gap) => `> - ${gap}`),
          ].join("\n")
        : null;
    const answer = evidenceBoundary
      ? `${finalized.markdown}\n\n${evidenceBoundary}`
      : finalized.markdown;
    const research: ProjectResearchResult = {
      ...result,
      status: "answered",
      partial: result.partial || recoveredFromIncompleteRun,
      coverageGaps: recoveredFromIncompleteRun
        ? Array.from(new Set([...result.coverageGaps, recoveryGap]))
        : result.coverageGaps,
      answer,
      findings: normalizedFindings,
      citations: finalized.citations,
      groundedClaims: finalized.groundedClaims,
      warnings: safeWarnings(result.warnings),
    };
    return {
      status: "answered",
      answer,
      citations: finalized.citations,
      citationPolicy: finalized.citationPolicy,
      groundedClaims: finalized.groundedClaims,
      research,
      diagnostics: {
        inputStatus: result.status,
        fallbackUsed:
          recoveredFromIncompleteRun ||
          answer.trim() !== result.answer.trim(),
        discardedCitationCount: result.citations.filter((citation) =>
          !usedCitationIds.has(durableCitationIdentity(citation))
        ).length,
        discardedFindingCount: findings.discardedFindingCount,
        reason: findings.blocks.length
          ? "normalized_supported_findings"
          : "normalized_supported_answer_blocks",
      },
    };
  } catch (error) {
    // Citation integrity is a recoverable boundary failure. The chat caller
    // receives a specific evidence-gap result rather than a terminal verifier
    // exception or an ungrounded answer.
    if (error instanceof CitationIntegrityError || error instanceof Error) {
      return insufficientResult({
        result,
        reason: "no_durable_supported_claim",
        discardedFindingCount: findings.discardedFindingCount,
      });
    }
    return insufficientResult({
      result,
      reason: "no_durable_supported_claim",
      discardedFindingCount: findings.discardedFindingCount,
    });
  }
}
