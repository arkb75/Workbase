import type {
  ProjectKnowledgeAuthority,
  ProjectKnowledgeCitation,
  ProjectKnowledgeHit,
  ProjectKnowledgePurpose,
} from "@/src/domain/project-chat";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { syncWorkItemDescriptionEvidenceForWorkItem } from "@/src/lib/evidence-persistence";
import { filterSupersededProjectClaims } from "@/src/services/project-knowledge-policy";
import {
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
  /\b(summarize|overview|strongest|accomplishments?|achievements?|tell me about|(?:explain|describe) (?:workbase|this|the project)|what (?:is|does) (?:workbase|this|the project)|why (?:workbase|this(?: project)?|the project) (?:would )?matter|whole project|what did (?:i|we)|project context|(?:main|overall|system|project|high[- ]level) architecture)\b|\bhow does\b.{0,100}\b(?:architecture|system|pipeline|data flow)\b|\b(?:limitations?|risks?|strengths?(?: and weaknesses?)?|weaknesses?|trade[- ]?offs?)\b.{0,120}\b(?:workbase|whole project|overall project|system as a whole)\b|\b(?:hardest|most difficult|most valuable)\b.{0,120}\b(?:parts?|problems?|challenges?|systems?)\b.{0,160}\b(?:workbase|project|build|built|user value|product value)\b/i;
const explicitMultiItemRequestPattern =
  /\b(?:exactly\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:[a-z][\w-]*\s+){0,4}(?:bullets?|points?|items?|themes?|capabilities?|accomplishments?|achievements?|strengths?|findings?)\b/i;
const multiFacetPriorityPattern =
  /\b(?:prioritize|cover|focus on)\b[^.\n]{0,220},[^.\n]{0,120}(?:,|\band\b)[^.\n]{0,120}/i;

/**
 * Broad synthesis is an answer-shape requirement, not merely a lexical
 * similarity query. Explicit multi-facet prompts need a diverse durable-memory
 * pool; otherwise top-k retrieval can return several near-neighbor facts from
 * one subsystem and make the requested count impossible to satisfy without
 * padding. Audience alone is not a breadth signal: "three OAuth findings for a
 * hiring manager" is still a focused query and must retain hybrid retrieval.
 */
export function isBroadProjectKnowledgeQuery(query: string) {
  return broadProjectQueryPattern.test(query) ||
    (
      explicitMultiItemRequestPattern.test(query) &&
      multiFacetPriorityPattern.test(query)
    );
}
const currentProjectQueryPattern =
  /\b(?:up[- ]to[- ]date|latest|recent|newest|current(?:ly)?|as of)\b/i;

type CurrentRepositoryHead = {
  sourceId: string;
  commitSha: string;
};

type FreshnessAwareRetrievalInput =
  Parameters<ProjectKnowledgeRetrievalService["retrieve"]>[0] & {
    requireCurrentRepositoryKnowledge?: boolean;
    currentRepositoryHeads?: CurrentRepositoryHead[];
  };

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

function nestedString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    current = objectValue(current)?.[key];
  }
  return typeof current === "string" && current.trim() ? current : null;
}

type RepositoryValidatedKnowledge = {
  validatedThroughSha: string | null;
  validationHeads: unknown;
  evidence: Array<{
    evidenceItem: {
      sourceId: string;
      type: string;
      source?: { type: string } | null;
    };
  }>;
};

type RepositoryValidationState = {
  repositoryDerived: boolean;
  current: boolean;
};

/**
 * Validation is current only when every repository head recorded for the
 * entity still matches the corresponding attached Source. Legacy single-SHA
 * rows are accepted only when that SHA matches every repository source in the
 * entity's evidence; an unrelated repository with the same old SHA cannot
 * accidentally make the entity appear current.
 */
function repositoryValidationState(
  entity: RepositoryValidatedKnowledge,
  targetHeads: CurrentRepositoryHead[],
): RepositoryValidationState {
  const targetBySource = new Map(
    targetHeads.map((target) => [target.sourceId, target.commitSha]),
  );
  const recordedHeads = objectValue(entity.validationHeads);
  const recordedEntries = recordedHeads
    ? Object.entries(recordedHeads).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]),
      )
    : [];
  const repositorySourceIds = Array.from(new Set(
    entity.evidence.flatMap(({ evidenceItem }) =>
      evidenceItem.source?.type === "github_repo" || evidenceItem.type.startsWith("github_")
        ? [evidenceItem.sourceId]
        : []
    ),
  ));
  const repositoryDerived =
    recordedEntries.length > 0 ||
    repositorySourceIds.length > 0 ||
    Boolean(entity.validatedThroughSha);

  if (!repositoryDerived) return { repositoryDerived: false, current: false };
  if (recordedEntries.length) {
    return {
      repositoryDerived: true,
      current: recordedEntries.every(
        ([sourceId, commitSha]) => targetBySource.get(sourceId) === commitSha,
      ),
    };
  }
  if (!entity.validatedThroughSha) {
    return { repositoryDerived: true, current: false };
  }
  if (repositorySourceIds.length) {
    return {
      repositoryDerived: true,
      current: repositorySourceIds.every(
        (sourceId) => targetBySource.get(sourceId) === entity.validatedThroughSha,
      ),
    };
  }
  return {
    repositoryDerived: true,
    current:
      targetHeads.length === 1 &&
      targetHeads[0]?.commitSha === entity.validatedThroughSha,
  };
}

function repositoryKnowledgeFreshnessScore(state: RepositoryValidationState) {
  if (state.current) return 5;
  if (state.repositoryDerived) return 1;
  return 2;
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
    isBroadProjectKnowledgeQuery(query) ||
    currentProjectQueryPattern.test(query);
}

const postgresLexicalStopWords = new Set([
  "and", "answer", "assistant", "be", "current", "does", "explain", "for", "how",
  "information", "listing", "make", "objective", "prior", "project", "question",
  "source", "sources", "specific", "subsystems", "technically", "tell", "that",
  "the", "this", "type", "unrelated", "use", "used", "uses", "user", "what",
  "which", "why", "with", "without", "work", "works", "workbase",
]);

function tokenize(value: string) {
  return Array.from(
    new Set(
      normalizeWhitespace(value.toLowerCase())
        .split(/[^a-z0-9_./-]+/)
        .filter((term) => term.length > 2 && !postgresLexicalStopWords.has(term)),
    ),
  ).slice(0, 32);
}

function queryConceptAliases(value: string) {
  const aliases: string[] = [];
  if (/\b(?:security|secure|secrets?|credentials?|threat|posture)\b/i.test(value)) {
    aliases.push(
      "credential", "credentials", "redact", "redaction", "secret", "secrets",
      "oauth", "authorization", "permission", "permissions",
    );
  }
  if (/\b(?:authentication|authorization|permissions?|access control|oauth)\b/i.test(value)) {
    aliases.push(
      "oauth", "authentication", "authorization", "attached", "repository",
      "permission", "permissions",
    );
  }
  if (/\b(?:resilien\w*|recovery|recover\w*|fault tolerance|interruption)\b/i.test(value)) {
    aliases.push(
      "durable", "workflow", "resume", "retry",
      "progress", "idempotent", "partial",
    );
  }
  if (
    /\b(?:data model|stored?|storage|persist\w*|version\w*|supersed\w*|retir\w*|correct\w*|stale facts?|knowledge lifecycle)\b/i
      .test(value)
  ) {
    aliases.push(
      "prisma", "data", "model", "persist", "lifecycle", "version",
      "supersede", "stale", "retire", "embedding", "provenance",
    );
  }
  if (/\b(?:test(?:ing)? strategy|automated tests?|test coverage|regression|evaluation suite)\b/i.test(value)) {
    aliases.push(
      "test", "tests", "vitest", "evaluation", "scenario", "regression",
      "workflow", "security", "artifact", "research",
    );
  }
  if (/\b(?:github|oauth|repository ingestion|repo ingestion|code exploration)\b/i.test(value)) {
    aliases.push(
      "github", "oauth", "ingestion", "import", "repository", "exploration",
      "bounded", "source", "evidence",
    );
  }
  if (/\b(?:workspace|review experience|review ui|user-facing|frontend)\b/i.test(value)) {
    aliases.push(
      "workspace", "review", "highlight", "project", "fact", "citation",
      "artifact", "lifecycle",
    );
  }
  return Array.from(new Set(aliases));
}

function expandedQueryTerms(value: string) {
  return Array.from(new Set([...tokenize(value), ...queryConceptAliases(value)])).slice(0, 40);
}

function postgresLexicalQuery(value: string) {
  const terms = Array.from(new Set([
    ...queryConceptAliases(value),
    ...(
    normalizeWhitespace(value.toLowerCase())
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length > 2 && !postgresLexicalStopWords.has(term))
    ),
  ])).slice(0, 32);
  return terms.join(" OR ");
}

function lexicalScore(query: string, content: string) {
  const normalizedQuery = normalizeWhitespace(query.toLowerCase());
  const normalizedContent = normalizeWhitespace(content.toLowerCase());
  const terms = expandedQueryTerms(query);
  const contentTerms = new Set(
    normalizedContent.split(/[^a-z0-9_]+/).filter(Boolean),
  );
  let score = terms.reduce((total, term) => {
    const exactIdentifier = /[._/-]/.test(term);
    const matches = exactIdentifier
      ? normalizedContent.includes(term)
      : contentTerms.has(term);
    return total + (matches ? (exactIdentifier ? 1.8 : 1) : 0);
  }, 0);

  if (normalizedQuery.length > 4 && normalizedContent.includes(normalizedQuery)) {
    score += 4;
  }

  // Preserve intent across common inflections that substring matching and
  // pgvector cannot reliably bridge (especially in mock/offline evaluation,
  // where query and stored embeddings may come from different providers).
  if (
    /\b(?:retr(?:y|ied|ies)|backoff)\b/i.test(query) &&
    /\b(?:retr(?:y|ied|ies)|backoff)\b/i.test(content)
  ) {
    score += 5;
  }

  return score;
}

function normalizedRetrievalRelevance(input: {
  query: string;
  content: string;
  postgresLexicalRank?: number;
  vectorSimilarity?: number;
}) {
  const directLexical = lexicalScore(input.query, input.content);
  const directLexicalSignal = directLexical > 0
    ? Math.min(1, directLexical / 4)
    : 0;
  const postgresRank = Math.max(0, input.postgresLexicalRank ?? 0);
  const rawSemanticSimilarity = Math.max(
    0,
    Math.min(1, input.vectorSimilarity ?? 0),
  );
  // PostgreSQL stemming is valuable for candidate recall, but a lone stem can
  // conflate concepts such as "product" and "production". It may strengthen
  // adequacy only when at least two literal query concepts agree, or when a
  // high-confidence semantic match independently corroborates it.
  const postgresSignal =
    directLexical >= 2 || rawSemanticSimilarity >= 0.65
      ? Math.min(1, directLexicalSignal + postgresRank)
      : 0;
  // Embedding neighborhoods commonly contain broadly project-related records
  // around the middle of the cosine range. Only a decisive semantic match may
  // bypass focused lexical overlap; weaker vectors still help ranking but do
  // not prove that memory is adequate to answer the question.
  const semanticSignal = rawSemanticSimilarity >= 0.65
    ? rawSemanticSimilarity
    : 0;
  return Number(
    Math.max(directLexicalSignal, postgresSignal, semanticSignal).toFixed(4),
  );
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

function emptyKnowledgeRanks() {
  return {
    highlights: new Map<string, number>(),
    projectFacts: new Map<string, number>(),
    evidence: new Map<string, number>(),
    artifacts: new Map<string, number>(),
  };
}

function highlightRanking(highlight: {
  confidence: string;
  ownershipClarity: string;
  validatedThroughSha: string | null;
  metadata: unknown;
  evidence: Array<{ evidenceItem: { type: string } }>;
}, validation: RepositoryValidationState) {
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
    freshness: repositoryKnowledgeFreshnessScore(validation),
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
}, validation: RepositoryValidationState) {
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
    freshness: repositoryKnowledgeFreshnessScore(validation),
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
  const lexicalQuery = postgresLexicalQuery(input.query);
  if (!lexicalQuery) return emptyKnowledgeRanks();

  try {
    const [highlights, projectFacts, evidence, artifacts] = await Promise.all([
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${lexicalQuery}) AS value)
        SELECT claim."id", ts_rank_cd(
          to_tsvector('english', coalesce(claim."searchText", '')),
          query.value
        )::double precision AS score
        FROM "Claim" claim, query
        WHERE claim."workItemId" = ${input.workItemId}
          AND claim."verificationStatus" = 'approved'
          AND claim."lifecycleStatus" = 'active'
          AND to_tsvector('english', coalesce(claim."searchText", '')) @@ query.value
        ORDER BY score DESC
        LIMIT 40
      `,
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${lexicalQuery}) AS value)
        SELECT fact."id", ts_rank_cd(
          to_tsvector('english', coalesce(fact."searchText", '')),
          query.value
        )::double precision AS score
        FROM "ProjectFact" fact, query
        WHERE fact."workItemId" = ${input.workItemId}
          AND fact."status" = 'approved'
          AND fact."lifecycleStatus" = 'active'
          AND to_tsvector('english', coalesce(fact."searchText", '')) @@ query.value
        ORDER BY score DESC
        LIMIT 40
      `,
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${lexicalQuery}) AS value)
        SELECT evidence."id", ts_rank_cd(
          to_tsvector('english', coalesce(evidence."searchText", '')),
          query.value
        )::double precision AS score
        FROM "EvidenceItem" evidence, query
        WHERE evidence."workItemId" = ${input.workItemId}
          AND evidence."included" = true
          AND evidence."lifecycleStatus" = 'active'
          AND evidence."type" <> 'github_file_excerpt'::"EvidenceItemType"
          AND to_tsvector('english', coalesce(evidence."searchText", '')) @@ query.value
        ORDER BY score DESC
        LIMIT 40
      `,
      prisma.$queryRaw<RankedRow[]>`
        WITH query AS (SELECT websearch_to_tsquery('english', ${lexicalQuery}) AS value)
        SELECT artifact."id", ts_rank_cd(
          to_tsvector('english', coalesce(artifact."searchText", '')),
          query.value
        )::double precision AS score
        FROM "Artifact" artifact, query
        WHERE artifact."workItemId" = ${input.workItemId}
          AND artifact."userId" = ${input.userId}
          AND artifact."lifecycleStatus" = 'active'
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
  // Draft, flagged, and rejected Highlights are review/control-plane context,
  // never positive factual authority. Private chat may label them elsewhere,
  // but it must not cite them as support for an answer.
  if (highlight.verificationStatus !== "approved") {
    return false;
  }
  if (purpose !== "public_artifact") {
    return true;
  }

  return (
    highlight.publicSafetyStatus === "verified" &&
    !highlight.sensitivityFlag &&
    highlight.visibility !== "private"
  );
}

export const projectKnowledgeScoring = {
  lexicalScore,
  normalizedRetrievalRelevance,
  authorityWeight,
  isHighlightEligible,
  isBroadProjectKnowledgeQuery,
};

export const projectKnowledgeRetrievalService = {
  async retrieve({
    userId,
    workItemId,
    query,
    purpose,
    limits,
    preferredProjectFactIds,
    requireCurrentRepositoryKnowledge = false,
    currentRepositoryHeads: providedCurrentRepositoryHeads,
  }: FreshnessAwareRetrievalInput) {
    // Authorization must precede the system-owned sync: retrieval cannot use a
    // guessed work-item ID to create or update another user's evidence.
    await prisma.workItem.findFirstOrThrow({
      where: { id: workItemId, userId },
      select: { id: true },
    });
    await syncWorkItemDescriptionEvidenceForWorkItem(workItemId);
    const broadQuery = isBroadProjectKnowledgeQuery(query);
    const selectedLimits = {
      highlights: limits?.highlights ?? (broadQuery ? 100 : defaultLimits.highlights),
      projectFacts: limits?.projectFacts ?? (broadQuery ? 100 : defaultLimits.projectFacts),
      evidence: limits?.evidence ?? defaultLimits.evidence,
      artifacts: limits?.artifacts ?? defaultLimits.artifacts,
    };
    const preferredFactIds = new Set(
      purpose === "public_artifact" ? [] : (preferredProjectFactIds ?? []),
    );
    // Rank cheap identifiers first, then hydrate only bounded candidates and
    // their provenance. This prevents a chat turn from materializing the full
    // active knowledge graph before top-k selection.
    const [vectorRanks, lexicalRanks] = broadQuery
      ? [emptyKnowledgeRanks(), emptyKnowledgeRanks()]
      : await Promise.all([
          findNearestProjectKnowledge({ workItemId, query, limit: 40 }).catch(emptyKnowledgeRanks),
          loadPostgresLexicalScores({ userId, workItemId, query }),
        ]);
    const candidateIds = (
      vector: Map<string, number>,
      lexical: Map<string, number>,
      extras: Iterable<string> = [],
    ) => {
      const preferred = new Set(extras);
      const ranked = Array.from(new Set([...vector.keys(), ...lexical.keys(), ...preferred]))
        .sort((left, right) =>
          Number(preferred.has(right)) - Number(preferred.has(left)) ||
          ((lexical.get(right) ?? 0) * 10 + (vector.get(right) ?? 0) * 8) -
            ((lexical.get(left) ?? 0) * 10 + (vector.get(left) ?? 0) * 8) ||
          left.localeCompare(right)
        );
      // Hydrate a bounded combined-rank shortlist. Applying `take` after an
      // `updatedAt` sort can otherwise discard the actual vector/lexical
      // winner before the application-level scorer ever sees it.
      const preferredIds = ranked.filter((id) => preferred.has(id));
      const ordinaryIds = ranked.filter((id) => !preferred.has(id)).slice(0, 48);
      return [...preferredIds, ...ordinaryIds];
    };
    const highlightCandidateIds = candidateIds(vectorRanks.highlights, lexicalRanks.highlights);
    const projectFactCandidateIds = candidateIds(vectorRanks.projectFacts, lexicalRanks.projectFacts, preferredFactIds);
    const evidenceCandidateIds = candidateIds(vectorRanks.evidence, lexicalRanks.evidence);
    const artifactCandidateIds = candidateIds(vectorRanks.artifacts, lexicalRanks.artifacts);
    const [workItem, policyLifecycleFacts] = await Promise.all([
      prisma.workItem.findFirstOrThrow({
        where: {
          id: workItemId,
          userId,
        },
        include: {
        sources: {
          where: { type: "github_repo" },
          select: { id: true, metadata: true },
        },
        highlights: {
          where: {
            lifecycleStatus: "active",
            ...(!broadQuery && highlightCandidateIds.length ? { id: { in: highlightCandidateIds } } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: broadQuery
            ? 120
            : highlightCandidateIds.length || Math.max(32, selectedLimits.highlights * 4),
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
          where: {
            status: "approved",
            lifecycleStatus: "active",
            ...(!broadQuery && projectFactCandidateIds.length ? { id: { in: projectFactCandidateIds } } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: broadQuery
            ? 120
            : projectFactCandidateIds.length || Math.max(32, selectedLimits.projectFacts * 4, preferredFactIds.size),
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
            // Repository excerpts are nested provenance for reviewed Facts
            // and Highlights. Exclude them before PostgreSQL applies the
            // bounded `take`, otherwise a recent refresh can crowd durable
            // self-reported ownership and Work Item description evidence out
            // of the candidate pool before application ranking begins.
            type: { not: "github_file_excerpt" },
            ...(!broadQuery && evidenceCandidateIds.length ? { id: { in: evidenceCandidateIds } } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: broadQuery
            ? 60
            : evidenceCandidateIds.length || Math.max(40, selectedLimits.evidence * 5),
          include: {
            source: true,
            tags: true,
          },
        },
        artifacts: {
          where: {
            lifecycleStatus: "active",
            ...(!broadQuery && artifactCandidateIds.length ? { id: { in: artifactCandidateIds } } : {}),
          },
          orderBy: { updatedAt: "desc" },
          take: broadQuery
            ? 30
            : artifactCandidateIds.length || Math.max(20, selectedLimits.artifacts * 5),
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
      }),
      // The main graph hydration is deliberately bounded. Conflict policy is
      // not a ranking concern, though: an older authoritative lifecycle fact
      // must still be able to suppress a newer-but-stale README/Highlight even
      // when it falls outside the top hydrated rows.
      prisma.projectFact.findMany({
        where: {
          workItemId,
          status: "approved",
          lifecycleStatus: "active",
          subsystemKey: "knowledge_review_lifecycle",
        },
        orderBy: { updatedAt: "desc" },
        take: 16,
        select: {
          subsystemKey: true,
          statement: true,
          validatedThroughSha: true,
          validationHeads: true,
          evidence: {
            select: {
              evidenceItem: {
                select: {
                  sourceId: true,
                  type: true,
                  source: { select: { type: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const currentRepositoryHeads = providedCurrentRepositoryHeads?.length
      ? providedCurrentRepositoryHeads
      : (workItem.sources ?? []).flatMap((source) => {
          const commitSha =
            nestedString(source.metadata, ["revision", "commitSha"]) ??
            nestedString(source.metadata, ["commitSha"]);
          return commitSha ? [{ sourceId: source.id, commitSha }] : [];
        });
    const validationStateFor = (entity: RepositoryValidatedKnowledge) =>
      repositoryValidationState(entity, currentRepositoryHeads);
    const isEligibleForRequestedFreshness = (entity: RepositoryValidatedKnowledge) => {
      if (!requireCurrentRepositoryKnowledge) return true;
      const validation = validationStateFor(entity);
      return !validation.repositoryDerived || validation.current;
    };
    const eligibleHighlights = workItem.highlights.filter(isEligibleForRequestedFreshness);
    const eligibleProjectFacts = workItem.projectFacts.filter(isEligibleForRequestedFreshness);
    const eligiblePolicyLifecycleFacts = policyLifecycleFacts.filter(
      isEligibleForRequestedFreshness,
    );

    // Embeddings are maintained on write/backfill paths. Rebuilding every
    // missing vector synchronously makes an ordinary chat turn pay for old
    // data it may never use. The opt-in mode remains useful during migrations.
    if ((process.env.WORKBASE_RETRIEVAL_EMBEDDING_BACKFILL_MODE ?? "write_only") === "request") {
      await Promise.allSettled([
        ensureHighlightEmbeddings(
        eligibleHighlights.map((highlight) => ({
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
          accomplishmentRanking: highlightRanking(highlight, validationStateFor(highlight)),
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
          projectFacts: eligibleProjectFacts,
          evidenceItems: workItem.evidenceItems,
          artifacts: workItem.artifacts,
        }),
      ]);
    }

    // Broad catalog summaries are selected by authority, current-head
    // validation, accomplishment scores, and subsystem coverage. A query
    // embedding and four full-text queries cannot improve that exhaustive
    // requirement selection, so skip them on this hot path.
    const highlightHits = eligibleHighlights
      .filter((highlight) => isHighlightEligible(highlight, purpose))
      .map((highlight): ProjectKnowledgeHit => {
        const authority = highlightAuthority(highlight.verificationStatus);
        const subsystemKey = highlightSubsystemKey(highlight.metadata);
        const accomplishmentRanking = highlightRanking(
          highlight,
          validationStateFor(highlight),
        );
        const content = [
          highlight.text,
          highlight.summary,
          highlight.verificationNotes ?? "",
          highlight.tags.map((tag) => `${tag.dimension}:${tag.tag}`).join(" "),
        ].join(" ");
        const directLexicalScore = lexicalScore(query, content);
        const postgresLexicalRank = lexicalRanks.highlights.get(highlight.id) ?? 0;
        const vectorSimilarity = vectorRanks.highlights.get(highlight.id) ?? 0;
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
          retrievalRelevance: normalizedRetrievalRelevance({
            query,
            content,
            postgresLexicalRank,
            vectorSimilarity,
          }),
          score:
            authorityWeight(authority) +
            directLexicalScore +
            postgresLexicalRank * 10 +
            vectorSimilarity * 8 +
            (highlight.confidence === "high" ? 1.5 : highlight.confidence === "medium" ? 0.75 : 0) +
            (highlight.ownershipClarity === "clear" ? 1 : 0) +
            recencyScore(highlight.updatedAt),
          citations,
        };
      })
      .filter(
        (hit) =>
          broadQuery ||
          lexicalScore(query, `${hit.title} ${hit.content}`) > 0 ||
          (lexicalRanks.highlights.get(hit.id) ?? 0) > 0 ||
          (vectorRanks.highlights.get(hit.id) ?? 0) >= 0.16,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, selectedLimits.highlights);

    const projectFactHits = purpose === "public_artifact"
      ? []
      : eligibleProjectFacts
          .map((fact): ProjectKnowledgeHit => {
            const content = [fact.statement, fact.category, fact.reviewNotes ?? ""].join(" ");
            const directLexicalScore = lexicalScore(query, content);
            const postgresLexicalRank = lexicalRanks.projectFacts.get(fact.id) ?? 0;
            const vectorSimilarity = vectorRanks.projectFacts.get(fact.id) ?? 0;

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
              accomplishmentRanking: factRanking(fact, validationStateFor(fact)),
              retrievalRelevance: normalizedRetrievalRelevance({
                query,
                content,
                postgresLexicalRank,
                vectorSimilarity,
              }),
              score:
                (preferredFactIds.has(fact.id) ? 100 : 0) +
                authorityWeight("verified_project_fact") +
                directLexicalScore +
                postgresLexicalRank * 10 +
                vectorSimilarity * 8 +
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
              broadQuery ||
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
        const directLexicalScore = lexicalScore(query, content);
        const postgresLexicalRank = lexicalRanks.evidence.get(item.id) ?? 0;
        const vectorSimilarity = vectorRanks.evidence.get(item.id) ?? 0;

        return {
          id: item.id,
          kind: "evidence",
          authority: "included_evidence",
          title: item.title,
          content: item.content,
          ownershipAuthority:
            purpose === "private_chat"
              ? explicitSelfReportedOwnershipAuthority({
                  ...item,
                  source: {
                    externalId: item.source.externalId,
                    metadata: item.source.metadata,
                  },
                })
              : 0,
          retrievalRelevance: normalizedRetrievalRelevance({
            query,
            content,
            postgresLexicalRank,
            vectorSimilarity,
          }),
          score:
            authorityWeight("included_evidence") +
            linkedBonus +
            directLexicalScore +
            postgresLexicalRank * 10 +
            vectorSimilarity * 7 +
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
          broadQuery ||
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
    const hasEligibleDirectArtifactProvenance = (
      artifact: (typeof workItem.artifacts)[number],
    ) =>
      artifact.highlightProvenance.some(
        (entry) =>
          Boolean(entry.highlightId && entry.highlight) &&
          isEligibleForRequestedFreshness(entry.highlight!),
      ) ||
      artifact.evidenceProvenance.some((entry) =>
        Boolean(entry.evidenceItemId) &&
        (objectValue(entry.evidenceSnapshot)?.type ?? entry.evidenceItem?.type) !==
          "github_file_excerpt"
      );
    const hasOnlyEligibleHighlightProvenance = (
      artifact: (typeof workItem.artifacts)[number],
    ) => artifact.highlightProvenance.every((entry) =>
      !entry.highlightId ||
      Boolean(entry.highlight && isEligibleForRequestedFreshness(entry.highlight))
    );
    const artifactHits = workItem.artifacts
      .filter((artifact) =>
        (purpose !== "public_artifact"
          ? true
          : artifact.highlightProvenance.length > 0 &&
            artifact.highlightProvenance.every(
              (entry) => entry.highlight && isHighlightEligible(entry.highlight, purpose),
            )) &&
        (!regroundArtifactSources ||
          (requireCurrentRepositoryKnowledge
            ? hasOnlyEligibleHighlightProvenance(artifact) &&
              hasEligibleDirectArtifactProvenance(artifact)
            : hasDirectArtifactProvenance(artifact))),
      )
      .map((artifact): ProjectKnowledgeHit => {
        const content = [
          artifact.requestBrief ?? "",
          artifact.type,
          artifact.targetAngle,
          artifact.tone,
          artifact.content,
        ].join(" ");
        const directLexicalScore = lexicalScore(query, content);
        const postgresLexicalRank = lexicalRanks.artifacts.get(artifact.id) ?? 0;
        const vectorSimilarity = vectorRanks.artifacts.get(artifact.id) ?? 0;
        const directCitations: ProjectKnowledgeCitation[] = [
          ...artifact.highlightProvenance.flatMap((entry) => {
            if (
              !entry.highlightId ||
              (requireCurrentRepositoryKnowledge &&
                (!entry.highlight || !isEligibleForRequestedFreshness(entry.highlight)))
            ) return [];
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
          retrievalRelevance: normalizedRetrievalRelevance({
            query,
            content,
            postgresLexicalRank,
            vectorSimilarity,
          }),
          score:
            authorityWeight("prior_artifact") +
            directLexicalScore +
            postgresLexicalRank * 10 +
            vectorSimilarity * 6 +
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
          broadQuery ||
          lexicalScore(query, `${hit.title} ${hit.content}`) > 0 ||
          (lexicalRanks.artifacts.get(hit.id) ?? 0) > 0 ||
          (vectorRanks.artifacts.get(hit.id) ?? 0) >= 0.16,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, selectedLimits.artifacts);

    const rawPolicyContext = [
      ...eligiblePolicyLifecycleFacts.map((fact) => ({
        subsystemKey: fact.subsystemKey,
        title: fact.statement,
        content: fact.statement,
      })),
      ...eligibleHighlights.map((highlight) => ({
        subsystemKey: highlightSubsystemKey(highlight.metadata),
        title: highlight.text,
        content: highlight.summary,
      })),
      ...eligibleProjectFacts.map((fact) => ({
        subsystemKey: fact.subsystemKey,
        title: fact.statement,
        content: fact.statement,
      })),
    ];
    const hits = filterSupersededProjectClaims(
      [...highlightHits, ...projectFactHits, ...evidenceHits, ...artifactHits],
      rawPolicyContext,
    ).sort(
      (left, right) => right.score - left.score,
    );
    const filteredHighlightHits = hits.filter((hit) => hit.kind === "highlight");
    const filteredProjectFactHits = hits.filter((hit) => hit.kind === "project_fact");
    const filteredEvidenceHits = hits.filter((hit) => hit.kind === "evidence");
    const filteredArtifactHits = hits.filter((hit) => hit.kind === "artifact");
    const warnings = [
      ...(filteredArtifactHits.length
        ? [
          regroundArtifactSources
            ? "Prior artifacts are derivative context and were exposed only through their direct Highlight or durable-evidence provenance."
            : "Prior artifacts are derivative context. Re-ground their factual content in highlight and evidence citations before reuse.",
          ]
        : []),
      ...(filteredHighlightHits.some((hit) => hit.sensitivityFlag)
        ? ["Sensitive project context is present in this private retrieval result."]
        : []),
    ];

    return {
      query,
      purpose,
      hits,
      selectedHighlightIds: filteredHighlightHits.map((hit) => hit.id),
      selectedProjectFactIds: filteredProjectFactHits.map((hit) => hit.id),
      selectedEvidenceItemIds: filteredEvidenceHits.map((hit) => hit.id),
      selectedArtifactIds: filteredArtifactHits.map((hit) => hit.id),
      warnings,
    };
  },
} satisfies ProjectKnowledgeRetrievalService;
