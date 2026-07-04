import type { ClaimDraft, ClaimSnapshot } from "@/src/domain/types";
import { slugifyText } from "@/src/lib/utils";

const DUPLICATE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "application",
  "built",
  "for",
  "in",
  "implemented",
  "including",
  "of",
  "on",
  "the",
  "to",
  "using",
  "with",
]);

function tokenizeHighlightText(text: string) {
  return new Set(
    slugifyText(text)
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length > 2 && !DUPLICATE_STOP_WORDS.has(token)),
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}

export const STRONG_HIGHLIGHT_SIMILARITY_THRESHOLD = 0.86;
export const POSSIBLE_HIGHLIGHT_SIMILARITY_THRESHOLD = 0.78;

export function collectHighlightEvidenceIds(draft: ClaimDraft | ClaimSnapshot) {
  return new Set(
    draft.evidence.sourceRefs.flatMap((sourceRef) =>
      sourceRef.evidenceItemId ? [sourceRef.evidenceItemId] : [],
    ),
  );
}

export function collectHighlightTagKeys(draft: ClaimDraft | ClaimSnapshot) {
  return new Set(draft.tags.map((tag) => `${tag.dimension}:${tag.tag}`));
}

function buildEvidenceFingerprint(draft: ClaimDraft | ClaimSnapshot) {
  return draft.evidence.sourceRefs
    .map((sourceRef) => sourceRef.evidenceItemId ?? `${sourceRef.sourceId}:${sourceRef.excerpt}`)
    .sort()
    .join("|");
}

export function haveEvidenceOrTagOverlap(
  left: ClaimDraft | ClaimSnapshot,
  right: ClaimDraft | ClaimSnapshot,
) {
  const leftEvidenceIds = collectHighlightEvidenceIds(left);
  const rightEvidenceIds = collectHighlightEvidenceIds(right);

  for (const evidenceId of leftEvidenceIds) {
    if (rightEvidenceIds.has(evidenceId)) {
      return true;
    }
  }

  const leftTagKeys = collectHighlightTagKeys(left);
  const rightTagKeys = collectHighlightTagKeys(right);

  for (const tagKey of leftTagKeys) {
    if (rightTagKeys.has(tagKey)) {
      return true;
    }
  }

  return false;
}

export function classifyHighlightSimilarity(params: {
  cosineSimilarity: number | null;
  evidenceOrTagOverlap: boolean;
  deterministicDuplicate?: boolean;
}) {
  if (params.deterministicDuplicate) {
    return "strong" as const;
  }

  if (params.cosineSimilarity == null) {
    return "none" as const;
  }

  if (params.cosineSimilarity >= STRONG_HIGHLIGHT_SIMILARITY_THRESHOLD) {
    return "strong" as const;
  }

  if (
    params.cosineSimilarity >= POSSIBLE_HIGHLIGHT_SIMILARITY_THRESHOLD &&
    params.evidenceOrTagOverlap
  ) {
    return "possible" as const;
  }

  return "none" as const;
}

export function areNearDuplicateHighlights(
  left: ClaimDraft | ClaimSnapshot,
  right: ClaimDraft | ClaimSnapshot,
) {
  const leftFingerprint = slugifyText(left.text);
  const rightFingerprint = slugifyText(right.text);

  if (leftFingerprint === rightFingerprint) {
    return true;
  }

  const leftEvidence = buildEvidenceFingerprint(left);
  const rightEvidence = buildEvidenceFingerprint(right);
  const similarity = jaccardSimilarity(
    tokenizeHighlightText(left.text),
    tokenizeHighlightText(right.text),
  );

  if (leftEvidence && leftEvidence === rightEvidence && similarity >= 0.45) {
    return true;
  }

  return similarity >= 0.82;
}

export function partitionClaimsByPersistence(claims: ClaimSnapshot[]) {
  const preserved = claims.filter(
    (claim) =>
      claim.verificationStatus === "approved" ||
      claim.verificationStatus === "rejected",
  );
  const replaceable = claims.filter(
    (claim) =>
      claim.verificationStatus === "draft" ||
      claim.verificationStatus === "flagged",
  );

  return { preserved, replaceable };
}

export function filterDuplicateClaimDrafts(
  drafts: ClaimDraft[],
  preservedClaims: ClaimSnapshot[],
) {
  const keptDrafts: ClaimDraft[] = [];

  for (const draft of drafts) {
    if (preservedClaims.some((claim) => areNearDuplicateHighlights(claim, draft))) {
      continue;
    }

    if (keptDrafts.some((candidate) => areNearDuplicateHighlights(candidate, draft))) {
      continue;
    }

    keptDrafts.push(draft);
  }

  return keptDrafts;
}
