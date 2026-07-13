import type {
  ProjectKnowledgeAuthority,
  ProjectKnowledgeCitation,
  ProjectKnowledgeHit,
  ProjectKnowledgePurpose,
} from "@/src/domain/project-chat";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { syncWorkItemDescriptionEvidenceForWorkItem } from "@/src/lib/evidence-persistence";
import {
  buildHighlightEmbeddingText,
  ensureHighlightEmbeddings,
} from "@/src/services/highlight-embedding-service";
import { explicitSelfReportedOwnershipAuthority } from "@/src/services/evidence-ownership-authority";
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
const currentProjectQueryPattern =
  /\b(?:up[- ]to[- ]date|latest|recent|newest|current(?:ly)?|as of)\b/i;

type LinkedEvidence = {
  evidenceItemId: string;
  evidenceItem: {
    id: string;
    included: boolean;
    title: string;
    content: string;
    metadata: unknown;
  };
};

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function repositoryProvenance(entries: LinkedEvidence[]) {
  return entries
    .filter((entry) => entry.evidenceItem.included)
    .flatMap((entry) => {
      const item = entry.evidenceItem;
      const metadata = objectValue(item.metadata);
      const repository = typeof metadata?.repository === "string" ? metadata.repository : null;
      const commitSha = typeof metadata?.commitSha === "string" ? metadata.commitSha : null;
      const path = typeof metadata?.path === "string" ? metadata.path : null;
      if (!repository || !commitSha || !path) return [];
      return [{
        evidenceItemId: item.id,
        title: item.title,
        excerpt: item.content,
        repository,
        commitSha,
        blobSha: typeof metadata?.blobSha === "string" ? metadata.blobSha : undefined,
        path,
        startLine: typeof metadata?.startLine === "number" ? metadata.startLine : undefined,
        endLine: typeof metadata?.endLine === "number" ? metadata.endLine : undefined,
        url: typeof metadata?.url === "string" ? metadata.url : undefined,
        contentHash: typeof metadata?.excerptHash === "string" ? metadata.excerptHash : undefined,
      }];
    })
    .slice(0, 8);
}

function highlightSubsystemKey(metadata: unknown) {
  const value = objectValue(metadata);
  return typeof value?.subsystemKey === "string" ? value.subsystemKey : null;
}

function artifactSnapshotText(snapshot: unknown, key: string, fallback: string) {
  const value = objectValue(snapshot)?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function hasDirectArtifactProvenance(artifact: {
  highlightProvenance: Array<{ highlightId: string | null }>;
  evidenceProvenance: Array<{
    evidenceItemId: string | null;
    evidenceSnapshot: unknown;
    evidenceItem?: { type: string } | null;
  }>;
}) {
  return artifact.highlightProvenance.some((entry) => Boolean(entry.highlightId)) ||
    artifact.evidenceProvenance.some((entry) =>
      Boolean(entry.evidenceItemId) &&
      (objectValue(entry.evidenceSnapshot)?.type ?? entry.evidenceItem?.type) !== "github_file_excerpt"
    );
}

function requiresRegroundedArtifactSources(query: string, purpose: ProjectKnowledgePurpose) {
  return purpose === "public_artifact" ||
    broadProjectQueryPattern.test(query) ||
    currentProjectQueryPattern.test(query);
}

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

function highlightRanking(highlight: {
  confidence: string;
  ownershipClarity: string;
  validatedThroughSha: string | null;
  metadata: unknown;
  evidence: Array<{ evidenceItem: { type: string } }>;
}) {
  const metadata = highlight.metadata && typeof highlight.metadata === "object" && !Array.isArray(highlight.metadata)
    ? highlight.metadata as Record<string, unknown>
    : null;
  const scores = metadata?.scores && typeof metadata.scores === "object" && !Array.isArray(metadata.scores)
    ? metadata.scores as Record<string, unknown>
    : null;
  const numeric = (key: string, fallback: number) => typeof scores?.[key] === "number" ? Math.max(0, Math.min(5, scores[key] as number)) : fallback;
  return {
    evidenceStrength: highlight.evidence.length ? (highlight.confidence === "high" ? 5 : highlight.confidence === "medium" ? 4 : 2) : 1,
    productImportance: numeric("productImportance", 3),
    implementationBreadth: numeric("implementationBreadth", Math.min(5, 2 + highlight.evidence.length)),
    technicalDifficulty: numeric("technicalDifficulty", 3),
    ownershipAuthority: highlight.ownershipClarity === "clear" ? 5 : highlight.ownershipClarity === "partial" ? 3 : 1,
    distinctiveness: numeric("distinctiveness", 3),
    freshness: highlight.validatedThroughSha ? 5 : 2,
    impactBonus: typeof metadata?.measuredImpact === "boolean" && metadata.measuredImpact ? 10 : 0,
    uncertainty: highlight.ownershipClarity === "unclear" ? "Repository evidence does not establish personal ownership." : null,
  };
}

function factRanking(fact: {
  confidence: string;
  category: string;
  validatedThroughSha: string | null;
  productImportance: number | null;
  implementationBreadth: number | null;
  technicalDifficulty: number | null;
  distinctiveness: number | null;
  evidence: Array<{ evidenceItem: { type: string } }>;
}) {
  const systemCategory = fact.category === "architecture" || fact.category === "data_flow" || fact.category === "behavior";
  return {
    evidenceStrength: fact.evidence.length ? (fact.confidence === "high" ? 5 : fact.confidence === "medium" ? 4 : 2) : 1,
    // Missing scores are uncertainty, not evidence of importance. Broad facts
    // synthesized by the repository refresh carry explicit scores; older or
    // manually-created facts stay eligible without automatically outranking
    // demonstrated cross-file systems.
    productImportance: fact.productImportance ?? 2,
    implementationBreadth: fact.implementationBreadth ?? Math.min(3, 1 + fact.evidence.length),
    technicalDifficulty: fact.technicalDifficulty ?? (systemCategory ? 3 : 2),
    ownershipAuthority: 0,
    distinctiveness: fact.distinctiveness ?? 2,
    freshness: fact.validatedThroughSha ? 5 : 2,
    impactBonus: 0,
    uncertainty: "Technical implementation is verified; personal ownership and impact require Highlight context.",
  };
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
    lifecycleStatus?: string;
    publicSafetyStatus?: string;
  },
  purpose: ProjectKnowledgePurpose,
) {
  if (highlight.lifecycleStatus && highlight.lifecycleStatus !== "active") {
    return false;
  }
  if (purpose !== "public_artifact") {
    return true;
  }

  return (
    highlight.verificationStatus === "approved" &&
    highlight.publicSafetyStatus === "verified" &&
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
  async retrieve({ userId, workItemId, query, purpose, limits, preferredProjectFactIds }) {
    // Authorization must precede the system-owned sync: retrieval cannot use a
    // guessed work-item ID to create or update another user's evidence.
    await prisma.workItem.findFirstOrThrow({
      where: { id: workItemId, userId },
      select: { id: true },
    });
    await syncWorkItemDescriptionEvidenceForWorkItem(workItemId);
    const workItem = await prisma.workItem.findFirstOrThrow({
      where: {
        id: workItemId,
        userId,
      },
      include: {
        highlights: {
          where: { lifecycleStatus: "active" },
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
          where: { status: "approved", lifecycleStatus: "active" },
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
            lifecycleStatus: "active",
          },
          include: {
            source: true,
            tags: true,
          },
        },
        artifacts: {
          where: { lifecycleStatus: "active" },
          include: {
            highlightProvenance: {
              include: {
                highlight: {
                  include: {
                    evidence: {
                      include: {
                        evidenceItem: { include: { source: true } },
                      },
                    },
                  },
                },
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
    const broadQuery = broadProjectQueryPattern.test(query);
    const selectedLimits = {
      highlights: limits?.highlights ?? (broadQuery ? 100 : defaultLimits.highlights),
      projectFacts: limits?.projectFacts ?? (broadQuery ? 100 : defaultLimits.projectFacts),
      evidence: limits?.evidence ?? defaultLimits.evidence,
      artifacts: limits?.artifacts ?? defaultLimits.artifacts,
    };
    const preferredFactIds = new Set(
      purpose === "public_artifact" ? [] : (preferredProjectFactIds ?? []),
    );

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
          subsystemKey:
            highlight.metadata && typeof highlight.metadata === "object" && !Array.isArray(highlight.metadata) && typeof highlight.metadata.subsystemKey === "string"
              ? highlight.metadata.subsystemKey
              : null,
          validatedThroughSha: highlight.validatedThroughSha,
          accomplishmentRanking: highlightRanking(highlight),
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
        const subsystemKey = highlightSubsystemKey(highlight.metadata);
        const accomplishmentRanking = highlightRanking(highlight);
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
            provenance: repositoryProvenance(highlight.evidence),
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
          subsystemKey,
          validatedThroughSha: highlight.validatedThroughSha,
          accomplishmentRanking,
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
              subsystemKey: fact.subsystemKey,
              validatedThroughSha: fact.validatedThroughSha,
              accomplishmentRanking: factRanking(fact),
              score:
                (preferredFactIds.has(fact.id) ? 100 : 0) +
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
                  provenance: repositoryProvenance(fact.evidence),
                },
              ],
            };
          })
          .filter(
            (hit) =>
              preferredFactIds.has(hit.id) ||
              broadProjectQueryPattern.test(query) ||
              lexicalScore(query, `${hit.title} ${hit.content}`) > 0 ||
              (lexicalRanks.projectFacts.get(hit.id) ?? 0) > 0 ||
              (vectorRanks.projectFacts.get(hit.id) ?? 0) >= 0.16,
          )
          .sort((left, right) => right.score - left.score)
          .slice(0, Math.max(selectedLimits.projectFacts, preferredFactIds.size));

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
          ownershipAuthority:
            purpose === "private_chat"
              ? explicitSelfReportedOwnershipAuthority(item)
              : 0,
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
      .sort((left, right) =>
        Number((right.ownershipAuthority ?? 0) >= 3) - Number((left.ownershipAuthority ?? 0) >= 3) ||
        right.score - left.score
      )
      .slice(0, selectedLimits.evidence);

    const regroundArtifactSources = requiresRegroundedArtifactSources(query, purpose);
    const artifactHits = workItem.artifacts
      .filter((artifact) =>
        (purpose !== "public_artifact"
          ? true
          : artifact.highlightProvenance.length > 0 &&
            artifact.highlightProvenance.every(
              (entry) => entry.highlight && isHighlightEligible(entry.highlight, purpose),
            )) &&
        (!regroundArtifactSources || hasDirectArtifactProvenance(artifact)),
      )
      .map((artifact): ProjectKnowledgeHit => {
        const content = [
          artifact.requestBrief ?? "",
          artifact.type,
          artifact.targetAngle,
          artifact.tone,
          artifact.content,
        ].join(" ");
        const directCitations: ProjectKnowledgeCitation[] = [
          ...artifact.highlightProvenance.flatMap((entry) => {
            if (!entry.highlightId) return [];
            return [{
              kind: "highlight" as const,
              label: artifactSnapshotText(entry.highlightSnapshot, "text", entry.highlight?.text ?? "Approved Highlight snapshot"),
              excerpt: artifactSnapshotText(entry.highlightSnapshot, "summary", entry.highlight?.summary ?? ""),
              highlightId: entry.highlightId,
              provenance: entry.highlight ? repositoryProvenance(entry.highlight.evidence) : [],
            }];
          }),
          ...artifact.evidenceProvenance.flatMap((entry) => {
            if (!entry.evidenceItemId) return [];
            const snapshot = objectValue(entry.evidenceSnapshot);
            // Newly explored repository excerpts remain nested provenance under
            // reviewed Highlights or Project Facts, never peer factual sources.
            if ((snapshot?.type ?? entry.evidenceItem?.type) === "github_file_excerpt") return [];
            return [{
              kind: "evidence" as const,
              label: artifactSnapshotText(entry.evidenceSnapshot, "title", entry.evidenceItem?.title ?? "Evidence snapshot"),
              excerpt: artifactSnapshotText(entry.evidenceSnapshot, "content", entry.evidenceItem?.content ?? ""),
              evidenceItemId: entry.evidenceItemId,
              sourceId: typeof snapshot?.sourceId === "string" ? snapshot.sourceId : entry.evidenceItem?.sourceId,
            }];
          }),
        ];

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
          citations: regroundArtifactSources
            ? directCitations
            : [
                {
                  kind: "artifact",
                  label: `${artifact.type.replace(/_/g, " ")} artifact`,
                  excerpt: artifact.content,
                  artifactId: artifact.id,
                },
                ...directCitations,
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
          regroundArtifactSources
            ? "Prior artifacts are derivative context and were exposed only through their direct Highlight or durable-evidence provenance."
            : "Prior artifacts are derivative context. Re-ground their factual content in highlight and evidence citations before reuse.",
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
