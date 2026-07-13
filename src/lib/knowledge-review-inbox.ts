export const KNOWLEDGE_REVIEW_CARD_LIMIT = 24;
export const PROVENANCE_REVIEW_CARD_LIMIT = 8;

export interface KnowledgeReviewInboxChange {
  id: string;
  entityId: string;
  entityKind: "evidence" | "highlight" | "project_fact" | "artifact";
  action: string;
  lifecycleStatus: string;
  createdAt: string;
}

export interface KnowledgeReviewInboxCounts {
  totalKnowledgeCount: number;
  totalProvenanceCount: number;
  newOrUpdatedKnowledgeCount: number;
  needsAttentionCount: number;
}

function reviewPriority(change: KnowledgeReviewInboxChange) {
  if (change.action === "quarantined" || change.lifecycleStatus === "quarantined") return 5;
  if (
    change.action === "retired" ||
    change.lifecycleStatus === "stale" ||
    change.lifecycleStatus === "needs_validation"
  ) return 4;
  if (change.action === "updated") return 3;
  if (change.action === "created") return 2;
  if (change.action === "revalidated") return 1;
  return 0;
}

function newestFirst<T extends KnowledgeReviewInboxChange>(left: T, right: T) {
  return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
}

function prioritized<T extends KnowledgeReviewInboxChange>(left: T, right: T) {
  return reviewPriority(right) - reviewPriority(left) || newestFirst(left, right);
}

function coalesceLatestEntityTransitions<T extends KnowledgeReviewInboxChange>(changes: readonly T[]) {
  const latest = new Map<string, T>();
  for (const change of [...changes].sort(newestFirst)) {
    const key = `${change.entityKind}:${change.entityId}`;
    if (!latest.has(key)) latest.set(key, change);
  }
  return Array.from(latest.values());
}

function balancedKnowledgeBatch<T extends KnowledgeReviewInboxChange>(changes: readonly T[], limit: number) {
  const attention = changes.filter((change) => reviewPriority(change) >= 4);
  const routine = changes.filter((change) => reviewPriority(change) < 4);
  const reservedAttention = Math.min(attention.length, Math.ceil(limit / 2));
  const reservedRoutine = Math.min(routine.length, limit - reservedAttention);
  const selected = [
    ...attention.slice(0, reservedAttention),
    ...routine.slice(0, reservedRoutine),
  ];
  if (selected.length >= limit) return selected;
  return [
    ...selected,
    ...attention.slice(reservedAttention),
    ...routine.slice(reservedRoutine),
  ].slice(0, limit);
}

/**
 * Keeps the review-later surface focused on user-facing knowledge. Exact file
 * excerpts remain independently reviewable, but are presented as a bounded,
 * collapsed provenance queue instead of hundreds of peer accomplishment cards.
 * The underlying KnowledgeChange audit records are never mutated or discarded.
 */
export function buildKnowledgeReviewInbox<T extends KnowledgeReviewInboxChange>(
  changes: readonly T[],
  limits: {
    knowledge?: number;
    provenance?: number;
    counts?: KnowledgeReviewInboxCounts;
  } = {},
) {
  const coalesced = coalesceLatestEntityTransitions(changes);
  const allKnowledge = coalesced
    .filter((change) => change.entityKind !== "evidence")
    .sort(prioritized);
  const allProvenance = coalesced
    .filter((change) => change.entityKind === "evidence")
    .sort(prioritized);
  const knowledgeLimit = Math.max(1, limits.knowledge ?? KNOWLEDGE_REVIEW_CARD_LIMIT);
  const provenanceLimit = Math.max(1, limits.provenance ?? PROVENANCE_REVIEW_CARD_LIMIT);
  const knowledgeChanges = balancedKnowledgeBatch(allKnowledge, knowledgeLimit);
  const provenanceChanges = allProvenance.slice(0, provenanceLimit);
  const totalKnowledgeCount = limits.counts?.totalKnowledgeCount ?? allKnowledge.length;
  const totalProvenanceCount = limits.counts?.totalProvenanceCount ?? allProvenance.length;

  return {
    // Reserve room for both safety/staleness work and newly auto-applied
    // knowledge so a large stale batch cannot hide the update itself.
    knowledgeChanges,
    provenanceChanges,
    deferredKnowledgeCount: Math.max(0, totalKnowledgeCount - knowledgeChanges.length),
    deferredProvenanceCount: Math.max(0, totalProvenanceCount - provenanceChanges.length),
    totalKnowledgeCount,
    totalProvenanceCount,
    newOrUpdatedKnowledgeCount: limits.counts?.newOrUpdatedKnowledgeCount ?? allKnowledge.filter((change) =>
      change.action === "created" || change.action === "updated" || change.action === "revalidated",
    ).length,
    needsAttentionCount: limits.counts?.needsAttentionCount
      ?? allKnowledge.filter((change) => reviewPriority(change) >= 4).length,
    coalescedTransitionCount: changes.length - coalesced.length,
  };
}
