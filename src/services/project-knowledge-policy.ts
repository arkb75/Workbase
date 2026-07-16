const currentAutoApplyLifecyclePattern =
  /\b(?:auto[- ]appl(?:y|ied)|appl(?:y|ied).{0,40}(?:later|retrospective) review|review[- ]later|update inbox)\b/i;
const obsoleteMandatoryReviewPattern =
  /\b(?:mandatory (?:human )?review|human review gate|(?:all|every) .{0,80}(?:claim|fact|highlight|candidate|knowledge).{0,60}(?:review|approv)|(?:claim|fact|highlight|candidate|knowledge).{0,60}(?:must|requir).{0,40}(?:human )?(?:review|approv))\b/i;
const blanketMandatoryReviewPattern =
  /\b(?:mandatory (?:human )?review|human review gate|(?:all|every) .{0,80}(?:claim|fact|highlight|candidate|knowledge).{0,60}(?:human )?(?:review|approv))\b/i;
const scopedPublicArtifactPolicyPattern =
  /\b(?:(?:public(?:-facing)? artifacts?).{0,100}approved (?:claims?|highlights?)|approved (?:claims?|highlights?).{0,100}(?:public(?:-facing)? artifacts?))\b/i;
const unsupportedAbsoluteProjectClaimPattern =
  /\b(?:tamper[- ]evident|fallback (?:that )?always produces|always produces calibrated output)\b/i;

export interface ProjectClaimPolicyEntry {
  subsystemKey?: string | null;
  title: string;
  content: string;
}
/**
 * Removes known-conflicting or intrinsically overclaimed durable memory before
 * it can reach any private-chat answer—not only accomplishment summaries.
 * Context entries may be a larger pre-ranking catalog so a current lifecycle
 * fact can suppress an older README, Artifact, or Highlight that ranking would
 * otherwise surface by itself.
 */
export function filterSupersededProjectClaims<T extends ProjectClaimPolicyEntry>(
  entries: T[],
  contextEntries: readonly ProjectClaimPolicyEntry[] = entries,
) {
  const hasCurrentAutoApplyLifecycle = contextEntries.some((entry) =>
    (entry.subsystemKey === "knowledge_review_lifecycle" || !entry.subsystemKey) &&
    currentAutoApplyLifecyclePattern.test(`${entry.title} ${entry.content}`)
  );
  return entries.filter((entry) => {
    const value = `${entry.title} ${entry.content}`;
    if (unsupportedAbsoluteProjectClaimPattern.test(value)) return false;
    if (!hasCurrentAutoApplyLifecycle || !obsoleteMandatoryReviewPattern.test(value)) return true;
    return !blanketMandatoryReviewPattern.test(value) && scopedPublicArtifactPolicyPattern.test(value);
  });
}
