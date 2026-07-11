import type {
  ProjectKnowledgeAuthority,
  ProjectKnowledgeCitation,
  ProjectKnowledgeHit,
  ProjectKnowledgePurpose,
} from "@/src/domain/project-chat";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import {
  buildHighlightEmbeddingText,
  ensureHighlightEmbeddings,
} from "@/src/services/highlight-embedding-service";
import {
  ensureProjectKnowledgeEmbeddings,
  findNearestProjectKnowledge,
} from "@/src/services/knowledge-embedding-service";
import type { ProjectKnowledgeRetrievalService } from "@/src/services/types";

const defaultLimits = {
  highlights: 6,
  projectFacts: 6,
  evidence: 8,
  artifacts: 3,
} as const;
const broadProjectQueryPattern =
  /\b(summarize|overview|strongest|accomplishments?|achievements?|tell me about|what did (?:i|we)|project context)\b/i;

function tokenize(value: string) {
  return Array.from(
    new Set(
      normalizeWhitespace(value.toLowerCase())
        .split(/[^a-z0-9_./-]+/)
        .filter((term) => term.length > 2),
    ),
  ).slice(0, 32);
}

function lexicalScore(query: string, content: string) {
  const normalizedQuery = normalizeWhitespace(query.toLowerCase());
  const normalizedContent = normalizeWhitespace(content.toLowerCase());
  const terms = tokenize(query);
  let score = terms.reduce((total, term) => {
    const exactIdentifier = /[._/-]/.test(term);
    return total + (normalizedContent.includes(term) ? (exactIdentifier ? 1.8 : 1) : 0);
  }, 0);

  if (normalizedQuery.length > 4 && normalizedContent.includes(normalizedQuery)) {
    score += 4;
  }

  return score;
}

function highlightAuthority(status: string): ProjectKnowledgeAuthority {
  if (status === "approved") {
    return "verified_highlight";
  }

  if (status === "rejected") {
    return "rejected_guidance";
  }

  return "candidate_highlight";
}

function authorityWeight(authority: ProjectKnowledgeAuthority) {
  if (authority === "verified_highlight") return 6;
  if (authority === "verified_project_fact") return 5.5;
  if (authority === "included_evidence") return 2.5;
  if (authority === "prior_artifact") return 1.5;
  if (authority === "candidate_highlight") return 0.5;
  return -4;
}

function recencyScore(updatedAt: Date) {
  const ageInDays = Math.max(0, (Date.now() - updatedAt.getTime()) / 86_400_000);
  return Math.max(0, 1.25 - ageInDays / 365);
}

async function loadPostgresLexicalScores(input: {
  userId: string;
  workItemId: string;
  query: string;
}) {
  type RankedRow = { id: string; score: number };

  try {
    const [highlights, projectFacts, evidence, artifacts] = await Promise.all([
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${input.query}) AS value)
        SELECT claim."id", ts_rank_cd(
          to_tsvector('english', coalesce(claim."searchText", '')),
          query.value
        )::double precision AS score
        FROM "Claim" claim, query
        WHERE claim."workItemId" = ${input.workItemId}
          AND to_tsvector('english', coalesce(claim."searchText", '')) @@ query.value
        ORDER BY score DESC
        LIMIT 40
      `,
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${input.query}) AS value)
        SELECT fact."id", ts_rank_cd(
          to_tsvector('english', coalesce(fact."searchText", '')),
          query.value
        )::double precision AS score
        FROM "ProjectFact" fact, query
        WHERE fact."workItemId" = ${input.workItemId}
          AND fact."status" = 'approved'
          AND to_tsvector('english', coalesce(fact."searchText", '')) @@ query.value
        ORDER BY score DESC
        LIMIT 40
      `,
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${input.query}) AS value)
        SELECT evidence."id", ts_rank_cd(
          to_tsvector('english', coalesce(evidence."searchText", '')),
          query.value
        )::double precision AS score
        FROM "EvidenceItem" evidence, query
        WHERE evidence."workItemId" = ${input.workItemId}
          AND evidence."included" = true
          AND to_tsvector('english', coalesce(evidence."searchText", '')) @@ query.value
        ORDER BY score DESC
        LIMIT 40
      `,
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${input.query}) AS value)
        SELECT artifact."id", ts_rank_cd(
          to_tsvector('english', coalesce(artifact."searchText", '')),
          query.value
        )::double precision AS score
        FROM "Artifact" artifact, query
        WHERE artifact."workItemId" = ${input.workItemId}
          AND artifact."userId" = ${input.userId}
          AND to_tsvector('english', coalesce(artifact."searchText", '')) @@ query.value
        ORDER BY score DESC
        LIMIT 40
      `,
    ]);

    return {
      highlights: new Map(highlights.map((row) => [row.id, Number(row.score)])),
      projectFacts: new Map(projectFacts.map((row) => [row.id, Number(row.score)])),
      evidence: new Map(evidence.map((row) => [row.id, Number(row.score)])),
      artifacts: new Map(artifacts.map((row) => [row.id, Number(row.score)])),
    };
  } catch {
    // Lexical ranking is additive. In-memory token matching remains available
    // during migrations or database feature outages.
    return {
      highlights: new Map<string, number>(),
      projectFacts: new Map<string, number>(),
      evidence: new Map<string, number>(),
      artifacts: new Map<string, number>(),
    };
  }
}

function isHighlightEligible(
  highlight: {
    verificationStatus: string;
    sensitivityFlag: boolean;
    visibility: string;
  },
  purpose: ProjectKnowledgePurpose,
) {
  if (purpose !== "public_artifact") {
    return true;
  }

  return (
    highlight.verificationStatus === "approved" &&
    !highlight.sensitivityFlag &&
    highlight.visibility !== "private"
  );
}

export const projectKnowledgeScoring = {
  lexicalScore,
  authorityWeight,
  isHighlightEligible,
};

export const projectKnowledgeRetrievalService: ProjectKnowledgeRetrievalService = {
  async retrieve({ userId, workItemId, query, purpose, limits }) {
    const workItem = await prisma.workItem.findFirstOrThrow({
      where: {
        id: workItemId,
        userId,
      },
      include: {
        highlights: {
          include: {
            evidence: {
              include: {
                evidenceItem: {
                  include: {
                    source: true,
                  },
                },
              },
            },
            tags: true,
          },
        },
        projectFacts: {
          where: { status: "approved" },
          include: {
            evidence: {
              include: {
                evidenceItem: { include: { source: true } },
              },
            },
          },
        },
        evidenceItems: {
          where: {
            included: true,
          },
          include: {
            source: true,
            tags: true,
          },
        },
        artifacts: {
          include: {
            highlightProvenance: {
              include: {
                highlight: true,
              },
              orderBy: { rank: "asc" },
            },
            evidenceProvenance: {
              include: {
                evidenceItem: {
                  include: { source: true },
                },
              },
              orderBy: { rank: "asc" },
            },
          },
        },
      },
    });
    const selectedLimits = {
      highlights: limits?.highlights ?? defaultLimits.highlights,
      projectFacts: limits?.projectFacts ?? defaultLimits.projectFacts,
      evidence: limits?.evidence ?? defaultLimits.evidence,
      artifacts: limits?.artifacts ?? defaultLimits.artifacts,
    };

    await Promise.allSettled([
      ensureHighlightEmbeddings(
        workItem.highlights.map((highlight) => ({
          id: highlight.id,
          workItemId: highlight.workItemId,
          text: highlight.text,
          summary: highlight.summary,
          confidence: highlight.confidence,
          ownershipClarity: highlight.ownershipClarity,
          sensitivityFlag: highlight.sensitivityFlag,
          verificationStatus: highlight.verificationStatus,
          visibility: highlight.visibility,
          risksSummary: highlight.risksSummary,
          missingInfo: highlight.missingInfo,
          rejectionReason: highlight.rejectionReason,
          verificationNotes: highlight.verificationNotes,
          metadata: highlight.metadata as never,
          evidence: {
            summary: highlight.summary,
            verificationNotes: highlight.verificationNotes,
            sourceRefs: highlight.evidence.map((entry) => ({
              evidenceItemId: entry.evidenceItemId,
              sourceId: entry.evidenceItem.sourceId,
              sourceLabel: entry.evidenceItem.source.label,
              sourceType: entry.evidenceItem.source.type,
              title: entry.evidenceItem.title,
              excerpt: entry.evidenceItem.content,
            })),
          },
          tags: highlight.tags.map((tag) => ({
            dimension: tag.dimension,
            tag: tag.tag as never,
            score: tag.score,
          })),
          createdAt: highlight.createdAt,
          updatedAt: highlight.updatedAt,
        })),
      ),
      ensureProjectKnowledgeEmbeddings({
        projectFacts: workItem.projectFacts,
        evidenceItems: workItem.evidenceItems,
        artifacts: workItem.artifacts,
      }),
    ]);

    const vectorRanks = await findNearestProjectKnowledge({
      workItemId,
      query,
      limit: 40,
    }).catch(() => ({
      highlights: new Map<string, number>(),
      projectFacts: new Map<string, number>(),
      evidence: new Map<string, number>(),
      artifacts: new Map<string, number>(),
    }));
    const lexicalRanks = await loadPostgresLexicalScores({ userId, workItemId, query });

    const highlightHits = workItem.highlights
      .filter((highlight) => isHighlightEligible(highlight, purpose))
      .map((highlight): ProjectKnowledgeHit => {
        const authority = highlightAuthority(highlight.verificationStatus);
        const content = [
          highlight.text,
          highlight.summary,
          highlight.verificationNotes ?? "",
          highlight.tags.map((tag) => `${tag.dimension}:${tag.tag}`).join(" "),
        ].join(" ");
        const citations: ProjectKnowledgeCitation[] = [
          {
            kind: "highlight",
            label: highlight.text,
            excerpt: highlight.summary,
            highlightId: highlight.id,
          },
          ...highlight.evidence.slice(0, 4).map((entry) => ({
            kind: "evidence" as const,
            label: entry.evidenceItem.title,
            excerpt: entry.evidenceItem.content,
            evidenceItemId: entry.evidenceItemId,
            sourceId: entry.evidenceItem.sourceId,
          })).filter((_, index) => highlight.evidence[index]?.evidenceItem.included),
        ];

        return {
          id: highlight.id,
          kind: "highlight",
          authority,
          title: highlight.text,
          content: highlight.summary,
          status: highlight.verificationStatus,
          visibility: highlight.visibility,
          sensitivityFlag: highlight.sensitivityFlag,
          score:
            authorityWeight(authority) +
            lexicalScore(query, content) +
            (lexicalRanks.highlights.get(highlight.id) ?? 0) * 10 +
            (vectorRanks.highlights.get(highlight.id) ?? 0) * 8 +
            (highlight.confidence === "high" ? 1.5 : highlight.confidence === "medium" ? 0.75 : 0) +
            (highlight.ownershipClarity === "clear" ? 1 : 0) +
            recencyScore(highlight.updatedAt),
          citations,
        };
      })
      .filter(
        (hit) =>
          broadProjectQueryPattern.test(query) ||
          lexicalScore(query, `${hit.title} ${hit.content}`) > 0 ||
          (lexicalRanks.highlights.get(hit.id) ?? 0) > 0 ||
          (vectorRanks.highlights.get(hit.id) ?? 0) >= 0.16,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, selectedLimits.highlights);

    const projectFactHits = purpose === "public_artifact"
      ? []
      : workItem.projectFacts
          .map((fact): ProjectKnowledgeHit => {
            const content = [fact.statement, fact.category, fact.reviewNotes ?? ""].join(" ");

            return {
              id: fact.id,
              kind: "project_fact",
              authority: "verified_project_fact",
              title: fact.statement,
              content: fact.statement,
              status: "approved",
              sensitivityFlag: fact.sensitivityFlag,
              score:
                authorityWeight("verified_project_fact") +
                lexicalScore(query, content) +
                (lexicalRanks.projectFacts.get(fact.id) ?? 0) * 10 +
                (vectorRanks.projectFacts.get(fact.id) ?? 0) * 8 +
                (fact.confidence === "high" ? 1.5 : fact.confidence === "medium" ? 0.75 : 0) +
                recencyScore(fact.updatedAt),
              citations: [
                {
                  kind: "project_fact",
                  label: fact.statement,
                  excerpt: fact.statement,
                  projectFactId: fact.id,
                },
              ],
            };
          })
          .filter(
            (hit) =>
              broadProjectQueryPattern.test(query) ||
              lexicalScore(query, `${hit.title} ${hit.content}`) > 0 ||
              (lexicalRanks.projectFacts.get(hit.id) ?? 0) > 0 ||
              (vectorRanks.projectFacts.get(hit.id) ?? 0) >= 0.16,
          )
          .sort((left, right) => right.score - left.score)
          .slice(0, selectedLimits.projectFacts);

    const linkedEvidenceIds = new Set(
      [...highlightHits, ...projectFactHits].flatMap((hit) =>
        hit.citations.flatMap((citation) =>
          citation.evidenceItemId ? [citation.evidenceItemId] : [],
        ),
      ),
    );
    const evidenceHits = workItem.evidenceItems
      .filter((item) => item.type !== "github_file_excerpt")
      .filter((item) => purpose !== "public_artifact" || linkedEvidenceIds.has(item.id))
      .map((item): ProjectKnowledgeHit => {
        const tagText = item.tags.map((tag) => `${tag.dimension}:${tag.tag}`).join(" ");
        const content = [item.title, item.content, item.searchText, tagText].join(" ");
        const linkedBonus = linkedEvidenceIds.has(item.id) ? 5 : 0;

        return {
          id: item.id,
          kind: "evidence",
          authority: "included_evidence",
          title: item.title,
          content: item.content,
          score:
            authorityWeight("included_evidence") +
            linkedBonus +
            lexicalScore(query, content) +
            (lexicalRanks.evidence.get(item.id) ?? 0) * 10 +
            (vectorRanks.evidence.get(item.id) ?? 0) * 7 +
            recencyScore(item.updatedAt),
          citations: [
            {
              kind: "evidence",
              label: item.title,
              excerpt: item.content,
              evidenceItemId: item.id,
              sourceId: item.sourceId,
              ...(item.type === "github_file_excerpt" &&
              item.metadata &&
              typeof item.metadata === "object" &&
              !Array.isArray(item.metadata)
                ? {
                    kind: "github_file" as const,
                    repository:
                      typeof item.metadata.repository === "string"
                        ? item.metadata.repository
                        : undefined,
                    commitSha:
                      typeof item.metadata.commitSha === "string"
                        ? item.metadata.commitSha
                        : undefined,
                    blobSha:
                      typeof item.metadata.blobSha === "string" ? item.metadata.blobSha : undefined,
                    path: typeof item.metadata.path === "string" ? item.metadata.path : undefined,
                    startLine:
                      typeof item.metadata.startLine === "number"
                        ? item.metadata.startLine
                        : undefined,
                    endLine:
                      typeof item.metadata.endLine === "number" ? item.metadata.endLine : undefined,
                    url: typeof item.metadata.url === "string" ? item.metadata.url : undefined,
                  }
                : {}),
            },
          ],
        };
      })
      .filter(
        (hit) =>
          broadProjectQueryPattern.test(query) ||
          lexicalScore(query, `${hit.title} ${hit.content}`) > 0 ||
          (lexicalRanks.evidence.get(hit.id) ?? 0) > 0 ||
          (vectorRanks.evidence.get(hit.id) ?? 0) >= 0.16,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, selectedLimits.evidence);

    const artifactHits = workItem.artifacts
      .filter((artifact) =>
        purpose !== "public_artifact"
          ? true
          : artifact.highlightProvenance.length > 0 &&
            artifact.highlightProvenance.every(
              (entry) => entry.highlight && isHighlightEligible(entry.highlight, purpose),
            ),
      )
      .map((artifact): ProjectKnowledgeHit => {
        const content = [
          artifact.requestBrief ?? "",
          artifact.type,
          artifact.targetAngle,
          artifact.tone,
          artifact.content,
        ].join(" ");

        return {
          id: artifact.id,
          kind: "artifact",
          authority: "prior_artifact",
          title: `${artifact.type.replace(/_/g, " ")} · ${artifact.targetAngle.replace(/_/g, " ")}`,
          content: artifact.content,
          score:
            authorityWeight("prior_artifact") +
            lexicalScore(query, content) +
            (lexicalRanks.artifacts.get(artifact.id) ?? 0) * 10 +
            (vectorRanks.artifacts.get(artifact.id) ?? 0) * 6 +
            recencyScore(artifact.updatedAt),
          citations: [
            {
              kind: "artifact",
              label: `${artifact.type.replace(/_/g, " ")} artifact`,
              excerpt: artifact.content,
              artifactId: artifact.id,
            },
            ...artifact.highlightProvenance.flatMap((entry) =>
              entry.highlight
                ? [
                    {
                      kind: "highlight" as const,
                      label: entry.highlight.text,
                      excerpt: entry.highlight.summary,
                      highlightId: entry.highlight.id,
                    },
                  ]
                : [],
            ),
            ...artifact.evidenceProvenance.flatMap((entry) =>
              entry.evidenceItem
                ? [
                    {
                      kind: "evidence" as const,
                      label: entry.evidenceItem.title,
                      excerpt: entry.evidenceItem.content,
                      evidenceItemId: entry.evidenceItem.id,
                      sourceId: entry.evidenceItem.sourceId,
                    },
                  ]
                : [],
            ),
          ],
        };
      })
      .filter(
        (hit) =>
          broadProjectQueryPattern.test(query) ||
          lexicalScore(query, `${hit.title} ${hit.content}`) > 0 ||
          (lexicalRanks.artifacts.get(hit.id) ?? 0) > 0 ||
          (vectorRanks.artifacts.get(hit.id) ?? 0) >= 0.16,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, selectedLimits.artifacts);

    const hits = [...highlightHits, ...projectFactHits, ...evidenceHits, ...artifactHits].sort(
      (left, right) => right.score - left.score,
    );
    const warnings = [
      ...(artifactHits.length
        ? [
          "Prior artifacts are derivative context. Re-ground their factual content in highlight and evidence citations before reuse.",
          ]
        : []),
      ...(highlightHits.some((hit) => hit.sensitivityFlag)
        ? ["Sensitive project context is present in this private retrieval result."]
        : []),
    ];

    return {
      query,
      purpose,
      hits,
      selectedHighlightIds: highlightHits.map((hit) => hit.id),
      selectedProjectFactIds: projectFactHits.map((hit) => hit.id),
      selectedEvidenceItemIds: evidenceHits.map((hit) => hit.id),
      selectedArtifactIds: artifactHits.map((hit) => hit.id),
      warnings,
    };
  },
};

export { buildHighlightEmbeddingText };
