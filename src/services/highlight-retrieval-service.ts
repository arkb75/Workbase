import { Prisma } from "@/src/generated/prisma/client";
import type {
  ArtifactRequest,
  ClaimSnapshot,
  EvidenceItemSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import { createGenerationRun } from "@/src/lib/generation-runs";
import {
  audienceFitDefaultsByArtifactType,
} from "@/src/lib/highlight-taxonomy";
import { publicArtifactVisibilityRules, targetAngleKeywordMap } from "@/src/lib/options";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import type { HighlightRetrievalService } from "@/src/services/types";

const genericBriefTerms = new Set([
  "write", "generate", "create", "artifact", "resume", "bullet", "bullets",
  "linkedin", "experience", "project", "summary", "concise", "technical",
  "recruiter", "friendly", "tone", "angle", "emphasizing", "emphasize",
  "using", "from", "with", "that", "this", "three", "some", "general",
  "backend", "full", "stack", "data", "engineering", "ai", "ml",
]);

function assessContextAdequacy(input: {
  request: ArtifactRequest;
  highlights: ClaimSnapshot[];
}) {
  if (!input.highlights.length) {
    return {
      status: "needs_research" as const,
      score: 0,
      reasons: [],
      coverageGaps: ["No approved, visibility-compatible highlight is available."],
    };
  }

  const briefTerms = Array.from(
    new Set(
      normalizeWhitespace(input.request.brief ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/)
        .filter((term) => term.length > 2 && !genericBriefTerms.has(term)),
    ),
  ).slice(0, 24);
  const corpus = input.highlights
    .map((highlight) =>
      [
        highlight.text,
        highlight.summary,
        highlight.tags.map((tag) => tag.tag).join(" "),
      ].join(" ").toLowerCase(),
    )
    .join(" ");
  const coveredTerms = briefTerms.filter((term) => corpus.includes(term));
  const coverageRatio = briefTerms.length ? coveredTerms.length / briefTerms.length : 1;
  const angleCovered =
    input.request.targetAngle === "general" ||
    input.highlights.some((highlight) =>
      highlight.tags.some(
        (tag) => tag.dimension === "domain" && tag.tag === input.request.targetAngle,
      ),
    );
  const minimumCoverage = briefTerms.length <= 2 ? 0.5 : 0.3;
  const sufficient = coverageRatio >= minimumCoverage && angleCovered;
  const coverageGaps = [
    ...(!angleCovered
      ? [`No approved highlight supports the ${input.request.targetAngle.replace(/_/g, " ")} angle.`]
      : []),
    ...(coverageRatio < minimumCoverage
      ? [
          `Approved highlights cover ${coveredTerms.length} of ${briefTerms.length} specific brief terms.`,
        ]
      : []),
  ];

  return {
    status: sufficient ? ("sufficient" as const) : ("needs_research" as const),
    score: Number(((coverageRatio * 0.7 + (angleCovered ? 0.3 : 0)).toFixed(4))),
    reasons: [
      `${input.highlights.length} approved highlight${input.highlights.length === 1 ? "" : "s"} passed visibility checks.`,
      `${coveredTerms.length}/${briefTerms.length || 0} specific brief terms are grounded.`,
    ],
    coverageGaps,
  };
}

export const artifactContextAdequacy = assessContextAdequacy;

function buildArtifactQueryText(params: {
  workItem: WorkItemSnapshot;
  request: ArtifactRequest;
}) {
  const targetAngleTerms = targetAngleKeywordMap[params.request.targetAngle];
  const toneTerms =
    params.request.tone === "technical"
      ? ["architecture", "implementation", "system", "api", "model"]
      : params.request.tone === "recruiter_friendly"
        ? ["impact", "teamwork", "ownership", "delivery"]
        : ["concise", "implementation"];

  return normalizeWhitespace(
    [
      params.workItem.title,
      params.workItem.description,
      params.request.type.replace(/_/g, " "),
      params.request.targetAngle.replace(/_/g, " "),
      params.request.tone.replace(/_/g, " "),
      params.request.brief ?? "",
      ...targetAngleTerms,
      ...toneTerms,
    ].join(" "),
  );
}

function scoreHighlightHeuristics(params: {
  highlight: ClaimSnapshot;
  request: ArtifactRequest;
}) {
  let score = 0;
  const tags = params.highlight.tags ?? [];
  const matchingDomain = tags.some(
    (tag) =>
      tag.dimension === "domain" && tag.tag === params.request.targetAngle,
  );

  if (matchingDomain) {
    score += 8;
  } else if (
    params.request.targetAngle === "general" &&
    tags.some((tag) => tag.dimension === "domain" && tag.tag === "general")
  ) {
    score += 4;
  }

  const preferredAudience =
    audienceFitDefaultsByArtifactType[params.request.type] ?? [];

  score += tags.filter(
    (tag) =>
      tag.dimension === "audience_fit" &&
      preferredAudience.includes(tag.tag as never),
  ).length * 3;

  if (params.request.tone === "technical") {
    score += tags.filter(
      (tag) =>
        tag.dimension === "emphasis" &&
        ["implementation", "architecture", "optimization", "reliability"].includes(
          tag.tag,
        ),
    ).length * 2;
  }

  if (params.request.tone === "recruiter_friendly") {
    score += tags.filter(
      (tag) =>
        tag.dimension === "competency" &&
        ["ownership", "teamwork", "communication", "execution"].includes(tag.tag),
    ).length * 2;
  }

  if (params.highlight.confidence === "high") {
    score += 2;
  } else if (params.highlight.confidence === "medium") {
    score += 1;
  }

  if (params.highlight.ownershipClarity === "clear") {
    score += 1.5;
  }

  return score;
}

async function getLexicalRanks(params: {
  workItemId: string;
  queryText: string;
  allowedVisibilities: string[];
}) {
  if (!params.queryText.trim().length) {
    return [];
  }

  return prisma.$queryRaw<Array<{ id: string; lexical_rank: number }>>(Prisma.sql`
    SELECT
      "id",
      ts_rank_cd(
        to_tsvector('english', COALESCE("searchText", '')),
        websearch_to_tsquery('english', ${params.queryText})
      ) AS lexical_rank
    FROM "Claim"
    WHERE "workItemId" = ${params.workItemId}
      AND "verificationStatus" = 'approved'::"VerificationStatus"
      AND "sensitivityFlag" = false
      AND "visibility" IN (${Prisma.join(
        params.allowedVisibilities.map((visibility) => Prisma.sql`${visibility}::"VisibilityLevel"`),
      )})
    ORDER BY lexical_rank DESC, "updatedAt" DESC
    LIMIT 40
  `);
}

function selectSupportingEvidence(params: {
  selectedHighlights: ClaimSnapshot[];
  evidenceItems: EvidenceItemSnapshot[];
  queryText: string;
}) {
  const evidenceById = new Map(
    params.evidenceItems.map((item) => [item.id, item] as const),
  );
  const supporting = new Map<string, EvidenceItemSnapshot>();
  const parentKeys = new Set<string>();

  for (const highlight of params.selectedHighlights) {
    for (const ref of highlight.evidence.sourceRefs) {
      if (ref.evidenceItemId) {
        const evidenceItem = evidenceById.get(ref.evidenceItemId);

        if (evidenceItem?.included) {
          supporting.set(evidenceItem.id, evidenceItem);
          if (evidenceItem.parentKey) {
            parentKeys.add(`${evidenceItem.parentKind ?? "parent"}:${evidenceItem.parentKey}`);
          }
        }
      }
    }
  }

  const queryTerms = params.queryText.toLowerCase().split(/\W+/).filter(Boolean);

  const siblingCandidates = params.evidenceItems
    .filter((item) => item.included)
    .filter((item) => !supporting.has(item.id))
    .filter((item) =>
      item.parentKey
        ? parentKeys.has(`${item.parentKind ?? "parent"}:${item.parentKey}`)
        : false,
    )
    .map((item) => ({
      item,
      score: queryTerms.reduce(
        (score, term) => score + (item.searchText.toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  for (const candidate of siblingCandidates) {
    supporting.set(candidate.item.id, candidate.item);
  }

  return Array.from(supporting.values()).slice(0, 12);
}

export const highlightRetrievalService: HighlightRetrievalService = {
  async retrieve({ workItem, request, highlights, evidenceItems }) {
    const allowedVisibilities = publicArtifactVisibilityRules[request.type];
    const eligibleHighlights = highlights.filter(
      (highlight) =>
        highlight.verificationStatus === "approved" &&
        !highlight.sensitivityFlag &&
        allowedVisibilities.includes(highlight.visibility),
    );

    if (!eligibleHighlights.length) {
      const generationRun = await createGenerationRun({
        workItemId: workItem.id,
        kind: "artifact_retrieval",
        status: "success",
        provider: "workbase",
        modelId: "heuristic-retrieval",
        inputSummary:
          {
            workItemId: workItem.id,
            request,
            queryText: "",
            eligibleHighlightCount: 0,
          } as unknown as Prisma.InputJsonValue,
        rawOutput: null,
        parsedOutput: {
          selectedHighlightIds: [],
          supportingEvidenceItemIds: [],
        } as Prisma.InputJsonValue,
        validationErrors: null,
        resultRefs: {
          usedHighlightIds: [],
          supportingEvidenceItemIds: [],
        } as Prisma.InputJsonValue,
        tokenUsage: null,
        estimatedCostUsd: null,
      });

      return {
        highlights: [],
        supportingEvidence: [],
        generationRunId: generationRun.id,
        adequacy: assessContextAdequacy({ request, highlights: [] }),
      };
    }

    const queryText = buildArtifactQueryText({ workItem, request });
    const lexicalRows = await getLexicalRanks({
      workItemId: workItem.id,
      queryText,
      allowedVisibilities,
    });
    const lexicalRankById = new Map(
      lexicalRows.map((row) => [row.id, Number(row.lexical_rank ?? 0)] as const),
    );

    const rankedHighlights = [...eligibleHighlights]
      .map((highlight) => ({
        highlight,
        score:
          (lexicalRankById.get(highlight.id) ?? 0) * 12 +
          scoreHighlightHeuristics({ highlight, request }),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          (right.highlight.updatedAt?.getTime() ?? 0) -
            (left.highlight.updatedAt?.getTime() ?? 0),
      )
      .slice(0, 8)
      .map((entry) => entry.highlight);

    const supportingEvidence = selectSupportingEvidence({
      selectedHighlights: rankedHighlights,
      evidenceItems,
      queryText,
    });
    const adequacy = assessContextAdequacy({
      request,
      highlights: rankedHighlights,
    });

    const generationRun = await createGenerationRun({
      workItemId: workItem.id,
      kind: "artifact_retrieval",
      status: "success",
      provider: "workbase",
      modelId: "postgres-lexical+heuristic",
      inputSummary:
        {
          workItemId: workItem.id,
          request,
          queryText,
          eligibleHighlightCount: eligibleHighlights.length,
        } as unknown as Prisma.InputJsonValue,
      rawOutput: null,
      parsedOutput: {
        lexicalRanks: Object.fromEntries(lexicalRankById),
        adequacy,
      } as Prisma.InputJsonValue,
      validationErrors: null,
      resultRefs: {
        usedHighlightIds: rankedHighlights.map((highlight) => highlight.id),
        supportingEvidenceItemIds: supportingEvidence.map((item) => item.id),
      } as Prisma.InputJsonValue,
      tokenUsage: null,
      estimatedCostUsd: null,
    });

    return {
      highlights: rankedHighlights,
      supportingEvidence,
      generationRunId: generationRun.id,
      adequacy,
    };
  },
};
