import { z } from "zod";
import type { GroundedAnswerBlock, ProjectResearchDossier } from "@/src/domain/project-chat";
import type { RepositoryKnowledgeMetadata } from "@/src/domain/repository-knowledge";
import { createStructuredGenerationBudget } from "@/src/lib/bedrock-structured-llm-client";
import type { JsonSchemaObject, StructuredOutputTransportMode } from "@/src/lib/llm-json-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { getStructuredLlmClient } from "@/src/services/bedrock-runtime";
import type {
  ProjectAnswerComparisonContext,
  ProjectAnswerComparisonContract,
} from "@/src/services/project-answer-editorial-service";
import { repositoryFreshnessFromDossier } from "@/src/services/project-research-dossier-service";

const groundingSchema = z.object({
  blocks: z.array(z.object({
    heading: z.string().trim().min(1).max(200).nullable(),
    bodyMarkdown: z.string().trim().min(1).max(2_000),
    citationIndexes: z.array(z.number().int().min(1)).min(1).max(6),
  })).max(40),
  issues: z.array(z.object({
    claim: z.string().trim().min(1).max(500),
    verdict: z.enum(["partially_entailed", "unsupported", "conflicted", "freshness_mismatch", "scope_overclaim"]),
    correction: z.string().trim().min(1).max(800),
  })).max(20),
});

const groundingJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["blocks", "issues"],
  properties: {
    blocks: {
      type: "array",
      minItems: 0,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "bodyMarkdown", "citationIndexes"],
        properties: {
          heading: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "null" }] },
          bodyMarkdown: { type: "string", minLength: 1, maxLength: 2_000 },
          citationIndexes: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    issues: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "verdict", "correction"],
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 500 },
          verdict: {
            type: "string",
            enum: ["partially_entailed", "unsupported", "conflicted", "freshness_mismatch", "scope_overclaim"],
          },
          correction: { type: "string", minLength: 1, maxLength: 800 },
        },
      },
    },
  },
};

export interface ProjectAnswerGroundingEntry {
  kind: string;
  authority: string;
  title: string;
  content: string;
  currentRun: boolean;
  citationIndexes: number[];
  /** Normalized 0–1 relevance from hybrid retrieval for this exact query. */
  retrievalRelevance?: number;
  ownershipAuthority?: number;
  supportingSources: Array<{
    type: string;
    title: string;
    path?: string;
    commitSha?: string;
  }>;
  subsystemKey?: string | null;
  /** Exact repository role/state/operation metadata; null for legacy memory. */
  repositoryKnowledge?: RepositoryKnowledgeMetadata | null;
  accomplishmentRanking?: {
    evidenceStrength: number;
    productImportance: number;
    implementationBreadth: number;
    technicalDifficulty: number;
    ownershipAuthority: number;
    distinctiveness: number;
    freshness: number;
    impactBonus: number;
    uncertainty: string | null;
  } | null;
}

export type ProjectAnswerGroundingMode =
  | "hybrid"
  | "deterministic"
  | "model";

export interface ProjectAnswerGroundingRequestContext {
  question: string;
  comparisonContract: ProjectAnswerComparisonContract | null;
  conversation: ProjectAnswerComparisonContext | null;
}

const personalOwnershipPattern = /(?:\b(?:i|we|you)\s+(?:(?:personally|independently|solely|single-handedly)\s+)?(?:built|implemented|designed|created|developed|architected|shipped|led|owned)\b)|(?:\b(?:solo[- ]built|single-handedly built|solely (?:built|implemented|designed|created|developed|architected|shipped|owned))\b)|(?:^(?:#{1,6}\s+)?(?:\d+[.)]\s+|[-*]\s+)?(?:built|implemented|designed|created|developed|architected|shipped|led|owned)\b)/i;

function hasPersonalOwnershipLanguage(value: string) {
  return value
    .split(/\n+/)
    .some((line) => personalOwnershipPattern.test(line.trim()));
}

function citationSupportsOwnership(
  citationIndexes: readonly number[],
  entries: readonly ProjectAnswerGroundingEntry[],
) {
  return citationIndexes.some((ordinal) => entries.some((entry) =>
    entry.citationIndexes.includes(ordinal) &&
    (entry.authority === "verified_highlight" || entry.authority === "included_evidence") &&
    (entry.ownershipAuthority ?? 0) >= 3
  ));
}

export function findUnsupportedOwnershipClaims(input: {
  answer: string;
  entries: readonly ProjectAnswerGroundingEntry[];
}) {
  return input.answer
    .split(/\n{2,}|\n(?=[-*#]|\d+[.)]\s)/)
    .flatMap((segment) => {
      if (!hasPersonalOwnershipLanguage(segment)) return [];
      const citationIndexes = Array.from(segment.matchAll(/\[citation:(\d+)\]/gi))
        .map((match) => Number(match[1]))
        .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0);
      return citationSupportsOwnership(citationIndexes, input.entries)
        ? []
        : [segment.replace(/\[citation:\d+\]/gi, "").trim()];
    });
}

function dateLabels(value: string | null) {
  if (!value) return [];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return [];
  return [
    value.slice(0, 10),
    new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date),
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date),
  ];
}

function usesStaleSourceImportDate(
  value: string,
  dossier?: ProjectResearchDossier | null,
) {
  const freshness = repositoryFreshnessFromDossier(dossier ?? null);
  if (!freshness.latestRepositoryInspectedAt) return false;
  const normalized = value.toLowerCase();
  return dateLabels(freshness.latestSourceImportedAt).some((label) =>
    normalized.includes(`as of ${label.toLowerCase()}`)
  );
}

const permissiveCitationMarkerPattern = /\[citation:([^\]]*)\]/gi;

export function detectGroundingContractIssues(input: {
  answer: string;
  citationCount: number;
  dossier?: ProjectResearchDossier | null;
  entries?: readonly ProjectAnswerGroundingEntry[];
}) {
  const issues: string[] = [];
  const markers = Array.from(input.answer.matchAll(permissiveCitationMarkerPattern));
  for (const marker of markers) {
    const ordinal = Number(marker[1]?.trim());
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > input.citationCount) {
      issues.push(`The answer references unavailable citation ${marker[0]}.`);
    }
  }

  if (usesStaleSourceImportDate(input.answer, input.dossier)) {
    issues.push("The answer labels the source import date as current even though a newer repository inspection exists.");
  }
  if (input.entries?.length) {
    for (const claim of findUnsupportedOwnershipClaims({ answer: input.answer, entries: input.entries })) {
      issues.push(`Repository-only sources cannot establish personal ownership: ${claim}`);
    }
  }
  return Array.from(new Set(issues));
}

export function extractClaimCitationMap(answer: string) {
  return answer
    .split(/\n{2,}|\n(?=[-*#])/)
    .flatMap((segment) => {
      const citationIndexes = Array.from(segment.matchAll(/\[citation:(\d+)\]/g))
        .map((match) => Number(match[1]))
        .filter((index) => Number.isInteger(index) && index > 0);
      const claim = segment
        .replace(/\[citation:\d+\]/g, "")
        .replace(/^[-*#\s]+/, "")
        .replace(/\s+([,.;:!?])/g, "$1")
        .trim();
      return claim && citationIndexes.length
        ? [{ claim, citationIndexes: Array.from(new Set(citationIndexes)) }]
        : [];
    });
}

export function projectAnswerGroundingExecutionOptions(singleAttempt: boolean) {
  if (!singleAttempt) {
    return {
      transportPreference: undefined,
      budget: undefined,
    };
  }
  return {
    transportPreference: ["json_schema"] as StructuredOutputTransportMode[],
    budget: createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 30_000,
    }),
  };
}

export function parseCitedAnswerBlocks(answer: string, citationCount: number): GroundedAnswerBlock[] {
  return answer
    .split(/\n{2,}/)
    .flatMap((segment) => {
      const citationIndexes = Array.from(segment.matchAll(permissiveCitationMarkerPattern))
        .map((match) => Number(match[1]?.trim()));
      if (citationIndexes.some((index) =>
        !Number.isInteger(index) || index < 1 || index > citationCount
      )) {
        return [];
      }
      const withoutMarkers = segment.replace(permissiveCitationMarkerPattern, "").trim();
      if (!withoutMarkers || !citationIndexes.length) return [];
      const lines = withoutMarkers.split("\n");
      const first = lines[0]?.match(/^#{1,6}\s+(.+)$/);
      return [{
        heading: first?.[1]?.trim() ?? null,
        bodyMarkdown: (first ? lines.slice(1).join("\n") : withoutMarkers).trim(),
        citationIndexes: Array.from(new Set(citationIndexes)),
      }];
    })
    .filter((block) => Boolean(block.bodyMarkdown));
}

const groundingStopWords = new Set([
  "about", "after", "also", "and", "are", "built", "for", "from", "into",
  "project", "that", "the", "their", "this", "through", "using", "with", "workbase",
  "you", "your", "we", "our",
]);

function groundingTerms(value: string) {
  return new Set(value.toLowerCase().split(/[^a-z0-9_]+/).filter((term) =>
    term.length > 2 && !groundingStopWords.has(term)
  ));
}

function blockHasLexicalSupport(block: GroundedAnswerBlock, entries: ProjectAnswerGroundingEntry[]) {
  const cited = entries.filter((entry) =>
    block.citationIndexes.some((index) => entry.citationIndexes.includes(index))
  );
  if (!cited.length) return false;
  const actual = groundingTerms(`${block.heading ?? ""} ${block.bodyMarkdown}`);
  const supported = groundingTerms(cited.map((entry) => `${entry.title} ${entry.content}`).join(" "));
  const overlap = Array.from(actual).filter((term) => supported.has(term)).length;
  if (!actual.size) return false;
  // Two topical words are not entailment. Requiring most meaningful claim
  // terms to occur in the cited material keeps cheap deterministic acceptance
  // for source-shaped answers while sending paraphrases and novel details to
  // the semantic verifier.
  const required = actual.size <= 3
    ? actual.size
    : Math.max(3, Math.ceil(actual.size * 0.65));
  return overlap >= required;
}

function unsupportedHighRiskQualifier(block: GroundedAnswerBlock, entries: ProjectAnswerGroundingEntry[]) {
  const claim = `${block.heading ?? ""} ${block.bodyMarkdown}`;
  const citedText = entries
    .filter((entry) => block.citationIndexes.some((index) => entry.citationIndexes.includes(index)))
    .map((entry) => `${entry.title} ${entry.content}`)
    .join(" ");
  const qualifiers = Array.from(claim.matchAll(/\b(?:always|never|mandatory|guarantee[sd]?|all|every|only|exclusively|production[- ]grade|tamper[- ]evident)\b/gi))
    .map((match) => match[0]!.toLowerCase());
  if (qualifiers.some((qualifier) => !citedText.toLowerCase().includes(qualifier))) return true;
  const numbers = Array.from(claim.matchAll(/\b\d+(?:\.\d+)?%?\b/g)).map((match) => match[0]!);
  return numbers.some((number) => !citedText.includes(number));
}

export function evaluateDeterministicAnswerGrounding(input: {
  answer: string;
  entries: ProjectAnswerGroundingEntry[];
  citationCount: number;
  dossier?: ProjectResearchDossier | null;
  requiredBlockCount?: { minimum: number; maximum: number };
}) {
  const contractIssues = detectGroundingContractIssues(input);
  const parsed = parseCitedAnswerBlocks(input.answer, input.citationCount);
  const blocks = parsed.filter((block) =>
    !hasPersonalOwnershipLanguage([block.heading, block.bodyMarkdown].filter(Boolean).join("\n")) ||
    citationSupportsOwnership(block.citationIndexes, input.entries)
  );
  const countInvalid = Boolean(
    input.requiredBlockCount &&
    (blocks.length < input.requiredBlockCount.minimum || blocks.length > input.requiredBlockCount.maximum)
  );
  const unsupportedBlocks = blocks.filter((block) =>
    !blockHasLexicalSupport(block, input.entries) ||
    unsupportedHighRiskQualifier(block, input.entries) ||
    usesStaleSourceImportDate(
      [block.heading, block.bodyMarkdown].filter(Boolean).join("\n"),
      input.dossier,
    )
  );
  const unsupportedBlockSet = new Set(unsupportedBlocks);
  const safeBlocks = blocks.filter((block) => !unsupportedBlockSet.has(block));
  const safeCountInvalid = Boolean(
    input.requiredBlockCount &&
    (safeBlocks.length < input.requiredBlockCount.minimum ||
      safeBlocks.length > input.requiredBlockCount.maximum)
  );
  return {
    blocks,
    safeBlocks,
    issues: contractIssues,
    requiresModel:
      !safeBlocks.length ||
      countInvalid ||
      safeCountInvalid ||
      contractIssues.length > 0 ||
      unsupportedBlocks.length > 0,
    unsupportedBlockCount: unsupportedBlocks.length,
  };
}

export async function groundProjectAnswer(input: {
  answer: string;
  entries: ProjectAnswerGroundingEntry[];
  citationCount: number;
  dossier?: ProjectResearchDossier | null;
  requiredBlockCount?: { minimum: number; maximum: number };
  singleAttempt?: boolean;
  verificationMode?: ProjectAnswerGroundingMode;
  requestContext?: ProjectAnswerGroundingRequestContext;
}) {
  const deterministic = evaluateDeterministicAnswerGrounding(input);
  const contractIssues = deterministic.issues;
  if (resolveWorkbaseLlmProvider() === "mock") {
    return {
      blocks: deterministic.safeBlocks,
      issues: contractIssues,
      tokenUsage: null,
    };
  }

  const configuredMode = process.env.WORKBASE_ANSWER_GROUNDING_MODE;
  const verifierMode = input.verificationMode ??
    (
      configuredMode === "deterministic" ||
      configuredMode === "model" ||
      configuredMode === "hybrid"
        ? configuredMode
        : "hybrid"
    );
  if (!deterministic.requiresModel && verifierMode !== "model") {
    return {
      blocks: deterministic.safeBlocks,
      issues: deterministic.issues,
      tokenUsage: null,
    };
  }
  if (verifierMode === "deterministic") {
    return {
      blocks: deterministic.safeBlocks,
      issues: deterministic.issues,
      tokenUsage: null,
    };
  }

  const freshness = repositoryFreshnessFromDossier(input.dossier ?? null);
  // Grounding is a verifier, not a drafting loop. A single constrained pass is
  // enough to accept, narrow, or remove claims; retry cascades multiply latency
  // without adding new evidence. Callers may explicitly opt into the legacy
  // repair behavior while the production default stays bounded.
  const executionOptions = projectAnswerGroundingExecutionOptions(input.singleAttempt ?? true);
  const referencedCitationIndexes = new Set(
    Array.from(input.answer.matchAll(permissiveCitationMarkerPattern))
      .map((match) => Number(match[1]?.trim()))
      .filter((index) => Number.isInteger(index) && index > 0 && index <= input.citationCount),
  );
  const verifierEntries = input.entries.filter((entry) =>
    entry.citationIndexes.some((index) => referencedCitationIndexes.has(index))
  );
  const verifierBlockContractErrors = (block: GroundedAnswerBlock, index: number) => {
    const errors: string[] = [];
    if (/\[citation:\d+\]/i.test(block.bodyMarkdown) || /\[\d+\](?:\s*\[\d+\])*/.test(block.bodyMarkdown)) {
      errors.push(`Block ${index + 1} must use citationIndexes instead of citation marker text.`);
    }
    if (block.heading && (/\[citation:\d+\]/i.test(block.heading) || /\[\d+\]/.test(block.heading))) {
      errors.push(`Heading ${index + 1} must not contain citation marker text.`);
    }
    if (block.citationIndexes.some((citationIndex) => !referencedCitationIndexes.has(citationIndex))) {
      errors.push(`Block ${index + 1} references a citation that was not used by the draft.`);
    }
    if (
      hasPersonalOwnershipLanguage([block.heading, block.bodyMarkdown].filter(Boolean).join("\n")) &&
      !citationSupportsOwnership(block.citationIndexes, verifierEntries)
    ) {
      errors.push(`Block ${index + 1} assigns personal ownership using repository-only sources.`);
    }
    return errors;
  };
  const result = await getStructuredLlmClient("verification").generateStructured({
      systemPrompt: [
        "You verify a citation-backed Workbase project answer before it is shown to the user.",
        "Check each factual project claim against only the source entry referenced by a [citation:N] marker in that claim or paragraph.",
        "Topical similarity is not entailment. Narrow configurable defaults, conditional behavior, and inferred intent instead of turning them into universal guarantees.",
        "For an assessment or comparison, retain an explicitly qualified analytical conclusion only when it follows directly from the cited implementation premises. Keep language such as “this suggests,” “this creates a trade-off,” or “this may limit”; do not rewrite the analysis as an observed project fact.",
        "When requestContext contains a comparison contract, preserve its two user-named subjects, their order, requested dimensions, and earlier/current roles. Conversation anchors resolve referential labels; they control framing but do not authorize new factual project claims or new citations.",
        "Repository-only Project Facts establish implementation only when repositoryKnowledge has the single implementationStates value implemented. Preserve partial as incomplete, planned as not yet implemented, bounded_absence as absent within the inspected scope, and mixed or missing state as unknown. Project Facts never establish who personally built the work. Remove or neutralize first-person, second-person, solo-built, sole-owner, and subjectless accomplishment language unless at least one cited verified Highlight or explicit included self-reported evidence item has ownershipAuthority of 3 or greater. A work-item description, explicitly user-authored source-note excerpt, or chat user statement may provide that private-chat ownership authority; included repository evidence may not.",
        "Return supported factual units as structured blocks. Do not include [citation:N], [N], footnotes, or any other citation syntax in heading or bodyMarkdown; use citationIndexes only.",
        "Do not introduce new facts or citation indexes. Remove claims that cannot be supported.",
        "If none of the claims are supported, return an empty blocks array and explain the evidence gap under issues.",
        "Keep useful Markdown such as emphasis, inline code, lists, and short paragraphs inside bodyMarkdown, but each block must remain one independently supported factual unit.",
        "For repository freshness, current-through means the pinned commit or inspection time. Never present an older source-import time as the current-through date.",
        "If research is partial, do not describe representative coverage as exhaustive and retain a concise coverage limitation when material.",
      ].join(" "),
      userPrompt: JSON.stringify({
        answer: input.answer,
        requestContext: input.requestContext ? {
          question: input.requestContext.question.replace(/\s+/g, " ").trim().slice(0, 2_000),
          comparisonContract: input.requestContext.comparisonContract,
          conversationAnchors: input.requestContext.comparisonContract?.subjects
            .filter((subject) => subject.resolvedAnchor)
            .map((subject) => ({
              label: subject.label,
              temporalRole: subject.temporalRole,
              anchor: subject.resolvedAnchor,
            })) ?? [],
        } : null,
        sources: verifierEntries,
        freshness,
        research: input.dossier ? {
          partial: input.dossier.partial,
          coverage: input.dossier.coverage,
          coverageGaps: input.dossier.coverageGaps,
        } : null,
        requiredBlockCount: input.requiredBlockCount ?? null,
        deterministicContractIssues: contractIssues,
      }),
      schema: groundingSchema,
      schemaName: "project_answer_grounding",
      schemaDescription: "Supported Markdown answer blocks whose claims are entailed by their cited project sources.",
      jsonSchema: groundingJsonSchema,
      maxTokens: 4_000,
      temperature: 0,
      effort: "medium",
      transportPreference: executionOptions.transportPreference,
      budget: executionOptions.budget,
      extraValidation: (value) => value.blocks
        .flatMap(verifierBlockContractErrors)
        .concat(
        input.requiredBlockCount && value.blocks.length > input.requiredBlockCount.maximum
          ? [`No more than ${input.requiredBlockCount.maximum} grounded blocks are allowed.`]
          : [],
      ),
    });
  // The structured client applies the same validation before returning. Keep
  // this final filter as defense in depth for alternate runtimes and test
  // doubles: an invalid model block is simply omitted instead of turning an
  // otherwise recoverable answer into a terminal integrity error.
  const postValidationErrors = result.data.blocks.flatMap(verifierBlockContractErrors);
  const blocks = result.data.blocks.filter((block, index) =>
    verifierBlockContractErrors(block, index).length === 0
  );
  return {
    blocks,
    issues: [
      ...contractIssues,
      ...result.data.issues.map((issue) => `${issue.verdict}: ${issue.claim} — ${issue.correction}`),
      ...postValidationErrors.map((issue) => `verifier_contract: ${issue}`),
    ],
    tokenUsage: result.tokenUsage,
  };
}
