import type {
  HighlightTagAssignment,
} from "@/src/domain/types";
import {
  competencyKeywordMap,
  domainKeywordMap,
  emphasisKeywordMap,
  highlightAudienceFitTags as audienceFitTags,
  highlightTagVocabulary,
  type HighlightTagDimension,
  type HighlightTagValue,
} from "@/src/lib/highlight-taxonomy";
import { normalizeWhitespace } from "@/src/lib/utils";

function countKeywordMatches(content: string, keywords: readonly string[]) {
  return keywords.reduce((count, keyword) => {
    const normalizedKeyword = keyword.toLowerCase();
    return content.includes(normalizedKeyword) ? count + 1 : count;
  }, 0);
}

function toScore(matchCount: number, scale = 4) {
  if (!matchCount) {
    return null;
  }

  return Math.min(1, Number((matchCount / scale).toFixed(2)));
}

function buildDimensionAssignments<T extends string>(params: {
  content: string;
  vocabulary: Record<T, readonly string[]>;
  dimension: HighlightTagDimension;
}) {
  return (Object.entries(params.vocabulary) as Array<[T, readonly string[]]>).flatMap(
    ([tag, keywords]) => {
    const matches = countKeywordMatches(params.content, keywords);

    if (!matches) {
      return [];
    }

      return [
        {
          dimension: params.dimension,
          tag: tag as HighlightTagValue,
          score: toScore(matches, keywords.length),
        } satisfies HighlightTagAssignment,
      ];
    },
  );
}

export function buildEvidenceSearchText(params: {
  title: string;
  content: string;
  metadata: unknown;
}) {
  const metadataText =
    params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
      ? Object.values(params.metadata)
          .flatMap((value) => {
            if (typeof value === "string") {
              return [value];
            }

            if (Array.isArray(value)) {
              return value.filter((entry): entry is string => typeof entry === "string");
            }

            return [];
          })
          .join(" ")
      : "";

  return normalizeWhitespace(
    [params.title, params.content, metadataText].filter(Boolean).join(" "),
  );
}

export function inferEvidenceTags(params: {
  title: string;
  content: string;
  sourceType: "manual_note" | "github_repo";
  evidenceType:
    | "manual_note_excerpt"
    | "github_readme"
    | "github_commit"
    | "github_pull_request"
    | "github_issue"
    | "github_release";
}) {
  const content = normalizeWhitespace(
    [params.title, params.content, params.sourceType, params.evidenceType].join(" ").toLowerCase(),
  );
  const assignments: HighlightTagAssignment[] = [
    ...buildDimensionAssignments({
      content,
      vocabulary: domainKeywordMap,
      dimension: "domain",
    }),
    ...buildDimensionAssignments({
      content,
      vocabulary: competencyKeywordMap,
      dimension: "competency",
    }),
    ...buildDimensionAssignments({
      content,
      vocabulary: emphasisKeywordMap,
      dimension: "emphasis",
    }),
  ];

  const audienceFit = new Set<(typeof audienceFitTags)[number]>();
  audienceFit.add("resume_safe");

  if (/linkedin|profile|experience/i.test(content)) {
    audienceFit.add("linkedin_safe");
  }

  if (/summary|overview|readme|project/i.test(content)) {
    audienceFit.add("project_summary");
  }

  if (/api|model|architecture|training|database|dynamodb|typescript|next\.js/i.test(content)) {
    audienceFit.add("technical_interview");
  }

  for (const tag of audienceFit) {
    assignments.push({
      dimension: "audience_fit",
      tag,
      score: tag === "resume_safe" ? 1 : 0.7,
    });
  }

  if (!assignments.some((assignment) => assignment.dimension === "domain")) {
    assignments.push({
      dimension: "domain",
      tag: "general",
      score: 0.4,
    });
  }

  if (!assignments.some((assignment) => assignment.dimension === "competency")) {
    assignments.push({
      dimension: "competency",
      tag: "technology",
      score: 0.4,
    });
  }

  if (!assignments.some((assignment) => assignment.dimension === "emphasis")) {
    assignments.push({
      dimension: "emphasis",
      tag: "implementation",
      score: 0.4,
    });
  }

  return dedupeTagAssignments(assignments);
}

export function inferHighlightTags(params: {
  text: string;
  summary: string;
  verificationNotes?: string | null;
}) {
  return inferEvidenceTags({
    title: params.text,
    content: [params.summary, params.verificationNotes ?? ""].join(" "),
    sourceType: "manual_note",
    evidenceType: "manual_note_excerpt",
  });
}

export function dedupeTagAssignments(tags: HighlightTagAssignment[]) {
  const seen = new Set<string>();

  return tags.filter((tag) => {
    const key = `${tag.dimension}:${tag.tag}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function coerceHighlightTagAssignments(
  tags: Array<{
    dimension: string;
    tag: string;
    score?: number | null;
  }>,
): HighlightTagAssignment[] {
  return dedupeTagAssignments(
    tags.flatMap((tag) => {
      if (!(tag.dimension in highlightTagVocabulary)) {
        return [];
      }

      const dimension = tag.dimension as HighlightTagDimension;
      const allowedValues = highlightTagVocabulary[dimension] as readonly string[];

      if (!allowedValues.includes(tag.tag)) {
        return [];
      }

      return [
        {
          dimension,
          tag: tag.tag as HighlightTagValue,
          score: tag.score ?? null,
        },
      ];
    }),
  );
}
