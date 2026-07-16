import { z } from "zod";
import type {
  GroundedAnswerBlock,
  ProjectResearchDossier,
} from "@/src/domain/project-chat";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import { createStructuredGenerationBudget } from "@/src/lib/bedrock-structured-llm-client";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { CitationIntegrityError } from "@/src/services/chat-citation-service";
import {
  detectGroundingContractIssues,
  groundProjectAnswer,
  type ProjectAnswerGroundingEntry,
} from "@/src/services/project-answer-grounding-service";
import { runAuditedStructuredGeneration } from "@/src/services/structured-generation-audit-service";
import { filterSupersededProjectClaims } from "@/src/services/project-knowledge-policy";

const MAX_ACCOMPLISHMENT_BLOCKS = 10;
const MAX_CITATIONS_PER_BLOCK = 4;
const MAX_MEMBERS_PER_REQUIREMENT = 3;
export const MAX_ACCOMPLISHMENT_CITATIONS = 20;
export const TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS = [
  "product_surface",
  "repository_knowledge_lifecycle",
  "project_chat_grounding",
  "artifact_generation",
  "knowledge_review_lifecycle",
  "workflow_orchestration",
  "ai_runtime",
  "retrieval_provenance",
  "ingestion_integrations",
  "domain_data",
  "review_ui",
  "tests_operations",
] as const;
const topLevelSubsystemIndex = new Map<string, number>(
  TOP_LEVEL_ACCOMPLISHMENT_SUBSYSTEMS.map((key, index) => [key, index]),
);
const requirementAliases = new Map<string, string>([
  ["product_surface", "product_and_artifact_generation"],
  ["artifact_generation", "product_and_artifact_generation"],
  ["knowledge_review_lifecycle", "knowledge_review_experience"],
  ["review_ui", "knowledge_review_experience"],
]);

export function accomplishmentSubsystemPriority(subsystemKey: string | null | undefined) {
  if (subsystemKey && topLevelSubsystemIndex.has(subsystemKey)) {
    return topLevelSubsystemIndex.get(subsystemKey)!;
  }
  if (subsystemKey?.startsWith("module:")) return 1_000;
  return 500;
}

export function isTopLevelAccomplishmentSubsystem(subsystemKey: string | null | undefined) {
  return Boolean(subsystemKey && topLevelSubsystemIndex.has(subsystemKey));
}

export interface AccomplishmentGroundingEntry extends ProjectAnswerGroundingEntry {
  subsystemKey?: string | null;
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

export interface AccomplishmentRequirementMember {
  title: string;
  content: string;
  citationIndexes: number[];
  currentRun: boolean;
  subsystemKey?: string | null;
}

export interface AccomplishmentRequirement extends AccomplishmentGroundingEntry {
  requirementKey: string;
  members: AccomplishmentRequirementMember[];
}

export interface AccomplishmentRequirementSelection {
  requirements: AccomplishmentRequirement[];
  omittedImportantEntries: AccomplishmentGroundingEntry[];
  coverageWarning: string | null;
}

const completionSchema = z.object({
  blocks: z.array(z.object({
    heading: z.string().trim().min(1).max(160),
    bodyMarkdown: z.string().trim().min(10).max(1_600),
    citationIndexes: z.array(z.number().int().min(1)).min(1).max(MAX_CITATIONS_PER_BLOCK),
  })).min(1).max(MAX_ACCOMPLISHMENT_BLOCKS),
});

const completionJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ACCOMPLISHMENT_BLOCKS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "bodyMarkdown", "citationIndexes"],
        properties: {
          heading: { type: "string", minLength: 1, maxLength: 160 },
          bodyMarkdown: { type: "string", minLength: 10, maxLength: 1_600 },
          citationIndexes: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CITATIONS_PER_BLOCK,
            items: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  },
};

function score(entry: AccomplishmentGroundingEntry) {
  const ranking = entry.accomplishmentRanking;
  if (!ranking) return 0;
  return ranking.productImportance * 5 +
    ranking.implementationBreadth * 4 +
    ranking.technicalDifficulty * 3 +
    ranking.evidenceStrength * 3 +
    ranking.ownershipAuthority * 2 +
    ranking.distinctiveness * 2 +
    ranking.freshness +
    ranking.impactBonus;
}

function genericObservation(entry: AccomplishmentGroundingEntry) {
  return /\b(?:defines (?:the )?(?:symbol|model)|contains .* behavior|is present in|reads or writes persisted application state)\b/i.test(
    `${entry.title} ${entry.content}`,
  );
}

function isImportant(entry: AccomplishmentGroundingEntry) {
  const ranking = entry.accomplishmentRanking;
  return (ranking?.productImportance ?? 0) >= 4 &&
    (ranking?.implementationBreadth ?? 0) >= 3;
}

function nearDuplicateAccomplishment(
  left: AccomplishmentGroundingEntry,
  right: AccomplishmentGroundingEntry,
) {
  if (
    left.subsystemKey === "product_surface" &&
    right.subsystemKey === "product_surface" &&
    accomplishmentCoverageAnchorScore(left) >= 3 &&
    accomplishmentCoverageAnchorScore(right) >= 3
  ) return true;
  const leftTerms = semanticTokens(`${left.title} ${left.content}`);
  const rightTerms = semanticTokens(`${right.title} ${right.content}`);
  if (!leftTerms.size || !rightTerms.size) return false;
  const overlap = Array.from(leftTerms).filter((term) => rightTerms.has(term)).length;
  const containment = overlap / Math.min(leftTerms.size, rightTerms.size);
  const jaccard = overlap / new Set([...leftTerms, ...rightTerms]).size;
  return containment >= 0.55 || (overlap >= 4 && jaccard >= 0.35);
}

const subsystemCoverageAnchors: Record<string, RegExp[]> = {
  product_surface: [
    /\b(?:resume|linkedin|career (?:content|artifacts?)|project summar(?:y|ies)|work items?)\b/i,
    /\b(?:end-to-end|full-stack|product (?:surface|loop|workspace|flow))\b/i,
    /(?:\b(?:source|evidence)\b.{0,16}\b(?:intake|ingestion|review)\b|\battached sources?\b)/i,
  ],
  repository_knowledge_lifecycle: [
    /\brepository (?:refresh|knowledge|snapshot|coverage|synthesis)\b/i,
    /\b(?:immutable|pinned) commit\b/i,
    /\b(?:reconcil|supersed|stale|revalidat|semantic analys)\w*/i,
    /\b(?:capability )?work packages?\b/i,
    /\b(?:parallel )?(?:semantic )?specialist workers?\b/i,
    /\b(?:structural )?coverage audit(?:or)?\b/i,
    /\b(?:supported findings|explicit gaps|coverage gaps?)\b/i,
  ],
  project_chat_grounding: [
    /\bmulti[- ]turn\b/i,
    /\b(?:conversation|chat) history\b/i,
    /\b(?:retrieval|citation|grounding|grounded answer)\b/i,
    /\bproject chat\b/i,
    /\b(?:execution|intent) rout(?:e|er|ing)\b/i,
    /\bdeterministic (?:intent|safety|constraint|path)\w*/i,
    /\bmodel[- ]assisted rout(?:e|er|ing)\b/i,
    /\b(?:genuinely )?ambiguous requests?\b/i,
  ],
  artifact_generation: [
    /\b(?:resume bullet|linkedin experience|project summary|artifact generation)\w*/i,
    /\bapproved (?:claim|highlight)\w*/i,
    /\b(?:artifact|generation) workflow\b/i,
  ],
  knowledge_review_lifecycle: [
    /\b(?:approv|reject|review|revert|retir|supersed|revalidat)\w*/i,
    /\bknowledge (?:change|lifecycle|review)\b/i,
    /\b(?:stale|quarantin)\w*/i,
    /\bauto[- ]appl(?:y|ied)\b/i,
    /\b(?:later|retrospective) review\b/i,
    /\b(?:downstream )?invalidat\w*/i,
    /\bupdate inbox\b/i,
  ],
  workflow_orchestration: [
    /\bdurable workflow\w*/i,
    /\b(?:retry|resume|idempoten|approval hook|persisted run)\w*/i,
    /\bworkflow orchestration\b/i,
  ],
  ai_runtime: [
    /\b(?:bedrock|converse|structured (?:generation|output)|tool use|tool loop)\b/i,
    /\b(?:json schema|zod|token budget|prompt cach)\w*/i,
    /\b(?:llm|agent) runtime\b/i,
  ],
  retrieval_provenance: [
    /\b(?:hybrid|lexical|vector|embedding) retrieval\b/i,
    /\b(?:citation|provenance|authority|ranking|re-ground)\w*/i,
    /\bproject knowledge retrieval\b/i,
  ],
  ingestion_integrations: [
    /\bgithub\b/i,
    /\boauth\b/i,
    /\b(?:repository|source) import\b/i,
    /\b(?:connect|callback) route\b/i,
  ],
  domain_data: [
    /\bprisma\b/i,
    /\b(?:data model|database schema|postgres|postgresql|neon)\b/i,
    /\bnormalized (?:store|schema|data model)\b/i,
    /\b(?:model|relation|migration) history\b/i,
  ],
  review_ui: [
    /\b(?:review|project) workspaces?\b/i,
    /\b(?:chat|source|highlight|fact|artifact) (?:tab|panel|view|interface)\b/i,
    /\b(?:citation|progress|review) (?:card|display|control)\b/i,
    /\b(?:saved )?(?:chat )?threads?\b/i,
    /\bsource management\b/i,
    /\bhighlight review\b/i,
    /\bartifact (?:generation|history)\b/i,
    /\b(?:inline )?citations?\b/i,
    /\b(?:run|generation) progress\b/i,
  ],
  tests_operations: [
    /\bautomated tests? cover\b/i,
    /\bvitest\b/i,
    /\bautomated test\w*/i,
    /\btest (?:suite|coverage)\b/i,
    /\b(?:unit|integration|end-to-end|workflow|ui) tests?\b/i,
  ],
};

/**
 * Active durable memory can briefly contain both sides of a behavior change
 * while staleness reconciliation catches up. If the catalog contains the
 * current auto-apply/review-later policy, do not summarize an older blanket
 * mandatory-review claim as a peer accomplishment. Public-artifact approval
 * rules are intentionally exempt because they remain a separate invariant.
 *
 * Highly absolute security/reliability wording is also omitted from an
 * accomplishment summary: those phrases require stronger proof than ordinary
 * implementation facts and are quarantined by current synthesis policy.
 */
export function filterSupersededAccomplishmentClaims<
  T extends { subsystemKey?: string | null; title: string; content: string },
>(entries: T[]) {
  return filterSupersededProjectClaims(entries);
}

export function accomplishmentCoverageAnchorScore(entry: {
  subsystemKey?: string | null;
  title: string;
  content: string;
}) {
  if (!entry.subsystemKey) return 0;
  const value = `${entry.title} ${entry.content}`;
  return (subsystemCoverageAnchors[entry.subsystemKey] ?? [])
    .reduce((count, pattern) => count + Number(pattern.test(value)), 0);
}

function compareAccomplishmentCoverage(
  left: AccomplishmentGroundingEntry,
  right: AccomplishmentGroundingEntry,
) {
  return accomplishmentCoverageAnchorScore(right) - accomplishmentCoverageAnchorScore(left) ||
    score(right) - score(left) ||
    Number(right.currentRun) - Number(left.currentRun) ||
    left.title.localeCompare(right.title);
}

function accomplishmentCandidatesForGroup(group: AccomplishmentGroundingEntry[]) {
  const representatives = new Map<string, AccomplishmentGroundingEntry>();
  const coverageOrdered = [...group].sort(compareAccomplishmentCoverage);
  for (const entry of coverageOrdered) {
    const key = entry.subsystemKey ?? `${entry.kind}:${entry.title.toLowerCase()}`;
    if (!representatives.has(key)) representatives.set(key, entry);
  }
  const representativeEntries = Array.from(representatives.values()).sort((left, right) =>
    accomplishmentSubsystemPriority(left.subsystemKey) - accomplishmentSubsystemPriority(right.subsystemKey) ||
    score(right) - score(left),
  );
  const representativeSet = new Set(representativeEntries);
  const selected = [...representativeEntries];
  for (const candidate of coverageOrdered.filter((entry) => isImportant(entry) && !representativeSet.has(entry))) {
    const rawSubsystem = candidate.subsystemKey ?? `${candidate.kind}:${candidate.title.toLowerCase()}`;
    if (selected.some((existing) => {
      const existingSubsystem = existing.subsystemKey ?? `${existing.kind}:${existing.title.toLowerCase()}`;
      return existingSubsystem === rawSubsystem && nearDuplicateAccomplishment(existing, candidate);
    })) continue;
    selected.push(candidate);
  }
  return selected;
}

function uniqueIndexes(indexes: readonly number[]) {
  return Array.from(new Set(indexes.filter((index) => Number.isInteger(index) && index > 0)));
}

function selfReportedOwnershipCitationIndexes(entries: AccomplishmentGroundingEntry[]) {
  return uniqueIndexes(entries
    .filter((entry) =>
      entry.authority === "included_evidence" && (entry.ownershipAuthority ?? 0) >= 3
    )
    .flatMap((entry) => entry.citationIndexes));
}

function requirementKey(entry: AccomplishmentGroundingEntry) {
  if (entry.subsystemKey) return requirementAliases.get(entry.subsystemKey) ?? entry.subsystemKey;
  return `${entry.kind}:${entry.title.toLowerCase()}`;
}

function mergedRequirementContent(members: AccomplishmentRequirementMember[]) {
  if (members.length === 1) return members[0]!.content.slice(0, 1_600);
  const perMember = Math.max(220, Math.floor(1_450 / members.length));
  return members
    .map((member) => `${member.title}: ${member.content.slice(0, perMember)}`)
    .join("\n")
    .slice(0, 1_600);
}

const requirementHeadings: Record<string, string> = {
  product_and_artifact_generation: "Career Content Product & Artifact Pipeline",
  repository_knowledge_lifecycle: "Repository Knowledge Lifecycle",
  project_chat_grounding: "Grounded Multi-Turn Project Chat",
  knowledge_review_experience: "Knowledge Review Lifecycle & Workspace",
  workflow_orchestration: "Durable Workflow Orchestration",
  ai_runtime: "Structured AI Runtime",
  retrieval_provenance: "Knowledge Retrieval & Provenance",
  ingestion_integrations: "GitHub Ingestion & Integrations",
  domain_data: "Domain & Data Model",
  tests_operations: "Automated Testing & Operations",
};

function stableRequirementHeading(requirementKeyValue: string) {
  return requirementHeadings[requirementKeyValue] ?? requirementKeyValue
    .replace(/^module:/, "")
    .split("_")
    .filter(Boolean)
    .map((term) => `${term.slice(0, 1).toUpperCase()}${term.slice(1)}`)
    .join(" ")
    .slice(0, 160);
}

export function selectAccomplishmentRequirementSet(
  entries: AccomplishmentGroundingEntry[],
): AccomplishmentRequirementSelection {
  const eligible = filterSupersededAccomplishmentClaims(entries)
    .filter((entry) => entry.citationIndexes.length > 0)
    .filter((entry) => entry.kind === "highlight" || entry.kind === "project_fact")
    .filter((entry) => entry.currentRun || Boolean(entry.accomplishmentRanking))
    .filter((entry) => !genericObservation(entry))
    .sort((left, right) => score(right) - score(left) || Number(right.currentRun) - Number(left.currentRun));
  const supportedTopLevelSubsystems = new Set(
    eligible
      .map((entry) => entry.subsystemKey)
      .filter((key): key is string => isTopLevelAccomplishmentSubsystem(key)),
  );
  const grouped = new Map<string, AccomplishmentGroundingEntry[]>();
  for (const entry of eligible) {
    const key = requirementKey(entry);
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }

  const topLevelGroupCount = supportedTopLevelSubsystems.size;
  const orderedGroups = Array.from(grouped.entries())
    .filter(([key, group]) =>
      topLevelGroupCount < 7 ||
      group.some((entry) => isTopLevelAccomplishmentSubsystem(entry.subsystemKey)) ||
      (!key.startsWith("module:") && group.some(isImportant))
    )
    .sort(([, leftEntries], [, rightEntries]) =>
      Math.min(...leftEntries.map((entry) => accomplishmentSubsystemPriority(entry.subsystemKey))) -
      Math.min(...rightEntries.map((entry) => accomplishmentSubsystemPriority(entry.subsystemKey))) ||
      score(rightEntries[0]!) - score(leftEntries[0]!),
    );

  const omittedImportantEntries: AccomplishmentGroundingEntry[] = [];
  const usedCitationIndexes = new Set<number>();
  const ownershipCitationIndexes = selfReportedOwnershipCitationIndexes(entries);
  const technicalCitationLimit = MAX_ACCOMPLISHMENT_CITATIONS - (ownershipCitationIndexes.length ? 1 : 0);
  const technicalCitationsPerBlock = MAX_CITATIONS_PER_BLOCK - (ownershipCitationIndexes.length ? 1 : 0);
  const selectedGroups = orderedGroups.slice(0, MAX_ACCOMPLISHMENT_BLOCKS).map(([key, group]) => {
    const candidates = accomplishmentCandidatesForGroup(group);
    const primary = candidates[0]!;
    const primaryCitationIndex = uniqueIndexes(primary.citationIndexes)[0]!;
    usedCitationIndexes.add(primaryCitationIndex);
    return {
      requirementKey: key,
      primary,
      candidates,
      members: [{
        member: {
          title: primary.title,
          content: primary.content,
          citationIndexes: [primaryCitationIndex],
          currentRun: primary.currentRun,
          subsystemKey: primary.subsystemKey,
        },
        candidate: primary,
      }],
    };
  });
  for (const [, group] of orderedGroups.slice(MAX_ACCOMPLISHMENT_BLOCKS)) {
    omittedImportantEntries.push(...accomplishmentCandidatesForGroup(group));
  }

  // Give every selected capability area one representative before allowing a
  // citation-rich early subsystem to consume the global answer budget. Add
  // additional same-subsystem facts one at a time across groups.
  const maximumCandidateDepth = Math.max(0, ...selectedGroups.map((group) => group.candidates.length));
  for (let depth = 1; depth < maximumCandidateDepth; depth += 1) {
    for (const group of selectedGroups) {
      const candidate = group.candidates[depth];
      if (!candidate) continue;
      if (group.members.length >= MAX_MEMBERS_PER_REQUIREMENT) {
        omittedImportantEntries.push(candidate);
        continue;
      }
      const requirementIndexes = uniqueIndexes(group.members.flatMap((entry) => entry.member.citationIndexes));
      const firstUsableIndex = uniqueIndexes(candidate.citationIndexes).find((index) =>
        requirementIndexes.includes(index) ||
        (
          requirementIndexes.length < technicalCitationsPerBlock &&
          (usedCitationIndexes.has(index) || usedCitationIndexes.size < technicalCitationLimit)
        )
      );
      if (!firstUsableIndex || (
        !requirementIndexes.includes(firstUsableIndex) &&
        requirementIndexes.length >= technicalCitationsPerBlock
      )) {
        omittedImportantEntries.push(candidate);
        continue;
      }
      usedCitationIndexes.add(firstUsableIndex);
      group.members.push({
        member: {
          title: candidate.title,
          content: candidate.content,
          citationIndexes: [firstUsableIndex],
          currentRun: candidate.currentRun,
          subsystemKey: candidate.subsystemKey,
        },
        candidate,
      });
    }
  }

  // Spend any remaining per-block/global citation budget round-robin on the
  // already-selected members. This preserves richer provenance when possible
  // without sacrificing a later top-level capability.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const group of selectedGroups) {
      for (const selectedMember of group.members) {
        const requirementIndexes = uniqueIndexes(group.members.flatMap((entry) => entry.member.citationIndexes));
        if (requirementIndexes.length >= technicalCitationsPerBlock) break;
        const nextIndex = uniqueIndexes(selectedMember.candidate.citationIndexes).find((index) =>
          !selectedMember.member.citationIndexes.includes(index) &&
          (usedCitationIndexes.has(index) || usedCitationIndexes.size < technicalCitationLimit)
        );
        if (!nextIndex) continue;
        selectedMember.member.citationIndexes.push(nextIndex);
        usedCitationIndexes.add(nextIndex);
        expanded = true;
      }
    }
  }

  const requirements: AccomplishmentRequirement[] = selectedGroups.map((group) => {
    const members = group.members.map((entry) => entry.member);
    return {
      ...group.primary,
      requirementKey: group.requirementKey,
      title: group.primary.title,
      content: mergedRequirementContent(members),
      currentRun: members.some((member) => member.currentRun),
      citationIndexes: uniqueIndexes(members.flatMap((member) => member.citationIndexes)),
      members,
    };
  });

  const omitted = Array.from(new Set(omittedImportantEntries));
  const selectedRequirementKeys = new Set(requirements.map((requirement) => requirement.requirementKey));
  const omittedCapabilityKeys = new Set(
    omitted
      .map((entry) => requirementKey(entry))
      .filter((key) => !selectedRequirementKeys.has(key)),
  );
  const omittedMemberCount = omitted.length;
  const coverageWarning = omittedMemberCount
    ? `This summary covers ${requirements.length} capability area${requirements.length === 1 ? "" : "s"} within the 10-item and 20-source answer limits; ${omittedCapabilityKeys.size} additional capability area${omittedCapabilityKeys.size === 1 ? "" : "s"} and ${omittedMemberCount - omittedCapabilityKeys.size} additional supported facet${omittedMemberCount - omittedCapabilityKeys.size === 1 ? " were" : "s were"} not included.`
    : null;
  return { requirements, omittedImportantEntries: omitted, coverageWarning };
}

export function selectAccomplishmentRequirements(entries: AccomplishmentGroundingEntry[]) {
  return selectAccomplishmentRequirementSet(entries).requirements;
}

const semanticStopWords = new Set([
  "about", "added", "also", "and", "application", "built", "capability", "created",
  "designed", "developed", "for", "from", "implemented", "into", "project", "provides",
  "service", "system", "that", "the", "this", "through", "using", "with", "workbase",
]);

function stem(term: string) {
  if (term.endsWith("ies") && term.length > 4) return `${term.slice(0, -3)}y`;
  if (term.endsWith("ing") && term.length > 5) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length > 4) return term.slice(0, -2);
  if (term.endsWith("es") && term.length > 4) return term.slice(0, -2);
  if (term.endsWith("s") && term.length > 3) return term.slice(0, -1);
  return term;
}

function semanticTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(stem)
      .filter((term) => term.length > 2 && !semanticStopWords.has(term)),
  );
}

function semanticallyCovers(block: GroundedAnswerBlock, member: AccomplishmentRequirementMember) {
  if (!block.citationIndexes.some((index) => member.citationIndexes.includes(index))) return false;
  const blockText = `${block.heading ?? ""} ${block.bodyMarkdown}`.toLowerCase().replace(/\s+/g, " ").trim();
  const memberTitle = member.title.toLowerCase().replace(/\s+/g, " ").trim();
  if (memberTitle.length > 2 && blockText.includes(memberTitle)) return true;
  const memberText = `${member.title} ${member.content}`.toLowerCase().replace(/\s+/g, " ").trim();
  if (memberText.length > 8 && blockText.includes(memberText)) return true;
  const expected = semanticTokens(memberText);
  if (!expected.size) return true;
  const actual = semanticTokens(blockText);
  const overlap = Array.from(expected).filter((term) => actual.has(term)).length;
  return overlap >= Math.min(2, expected.size);
}

export function auditAccomplishmentBlocks(
  blocks: GroundedAnswerBlock[],
  entries: AccomplishmentGroundingEntry[],
) {
  const selection = selectAccomplishmentRequirementSet(entries);
  const missingMembers = selection.requirements.flatMap((requirement) =>
    requirement.members
      .filter((member) => !blocks.some((block) => semanticallyCovers(block, member)))
      .map((member) => ({ requirementKey: requirement.requirementKey, member })),
  );
  const missingKeys = new Set(missingMembers.map((entry) => entry.requirementKey));
  const missing = selection.requirements.filter((requirement) => missingKeys.has(requirement.requirementKey));
  const uniqueCitationCount = uniqueIndexes(blocks.flatMap((block) => block.citationIndexes)).length;
  const perBlockCitationBudgetExceeded = blocks.some((block) =>
    uniqueIndexes(block.citationIndexes).length > MAX_CITATIONS_PER_BLOCK
  );
  const minimumBlocks = Math.min(7, selection.requirements.length);
  return {
    requirements: selection.requirements,
    missing,
    missingMembers,
    minimumBlocks,
    maximumBlocks: MAX_ACCOMPLISHMENT_BLOCKS,
    uniqueCitationCount,
    citationBudgetExceeded: uniqueCitationCount > MAX_ACCOMPLISHMENT_CITATIONS,
    perBlockCitationBudgetExceeded,
    omittedImportantEntries: selection.omittedImportantEntries,
    coverageWarning: selection.coverageWarning,
    complete:
      missing.length === 0 &&
      blocks.length >= minimumBlocks &&
      blocks.length <= MAX_ACCOMPLISHMENT_BLOCKS &&
      uniqueCitationCount <= MAX_ACCOMPLISHMENT_CITATIONS &&
      !perBlockCitationBudgetExceeded,
  };
}

/**
 * Structurally folds already-grounded factual units into one block per broad
 * requirement. It never pulls prose from raw memory, changes a grounded unit,
 * or removes citations from that unit, so it can safely avoid another model
 * call when the first verifier covered everything but returned too many blocks.
 */
export function compactAlreadyGroundedAccomplishmentBlocks(
  blocks: GroundedAnswerBlock[],
  entries: AccomplishmentGroundingEntry[],
) {
  const initialAudit = auditAccomplishmentBlocks(blocks, entries);
  if (initialAudit.missingMembers.length) return null;

  const ownershipIndexes = selfReportedOwnershipCitationIndexes(entries).slice(0, 1);
  const usedCitationIndexes = new Set<number>();
  const usedBlockIndexes = new Set<number>();
  const compacted: GroundedAnswerBlock[] = [];
  for (const requirement of initialAudit.requirements) {
    const allowedIndexes = new Set([...requirement.citationIndexes, ...ownershipIndexes]);
    const selectedBlockIndexes = new Set<number>();
    for (const member of requirement.members) {
      if (Array.from(selectedBlockIndexes).some((index) => semanticallyCovers(blocks[index]!, member))) {
        continue;
      }
      const currentIndexes = uniqueIndexes(Array.from(selectedBlockIndexes)
        .flatMap((index) => blocks[index]!.citationIndexes));
      const candidate = blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => semanticallyCovers(block, member))
        .map(({ block, index }) => {
          const requirementIndexes = uniqueIndexes([...currentIndexes, ...block.citationIndexes]);
          const globalIndexes = uniqueIndexes([...usedCitationIndexes, ...requirementIndexes]);
          return {
            block,
            index,
            feasible:
              requirementIndexes.length <= MAX_CITATIONS_PER_BLOCK &&
              globalIndexes.length <= MAX_ACCOMPLISHMENT_CITATIONS,
            outsideAllowed: block.citationIndexes.filter((citationIndex) => !allowedIndexes.has(citationIndex)).length,
            addedCitations: requirementIndexes.length - currentIndexes.length,
          };
        })
        .filter((entry) => entry.feasible)
        .sort((left, right) =>
          left.outsideAllowed - right.outsideAllowed ||
          Number(usedBlockIndexes.has(left.index)) - Number(usedBlockIndexes.has(right.index)) ||
          left.addedCitations - right.addedCitations ||
          left.block.bodyMarkdown.length - right.block.bodyMarkdown.length,
        )[0];
      if (!candidate) return null;
      selectedBlockIndexes.add(candidate.index);
    }

    const selectedBlocks = Array.from(selectedBlockIndexes).map((index) => blocks[index]!);
    const citationIndexes = uniqueIndexes(selectedBlocks.flatMap((block) => block.citationIndexes));
    const globalIndexes = uniqueIndexes([...usedCitationIndexes, ...citationIndexes]);
    if (
      !selectedBlocks.length ||
      citationIndexes.length > MAX_CITATIONS_PER_BLOCK ||
      globalIndexes.length > MAX_ACCOMPLISHMENT_CITATIONS
    ) return null;
    const heading = selectedBlocks.find((block) => block.heading)?.heading ??
      requirement.requirementKey
        .split("_")
        .map((term) => `${term.slice(0, 1).toUpperCase()}${term.slice(1)}`)
        .join(" ");
    const bodyMarkdown = selectedBlocks.map((block, index) => {
      const nestedHeading = index > 0 && block.heading && block.heading !== heading
        ? `**${block.heading.replace(/^#{1,6}\s*/, "")}**\n`
        : "";
      return `${nestedHeading}${block.bodyMarkdown}`;
    }).join("\n\n");
    compacted.push({ heading, bodyMarkdown, citationIndexes });
    for (const index of selectedBlockIndexes) usedBlockIndexes.add(index);
    for (const index of citationIndexes) usedCitationIndexes.add(index);
  }

  return auditAccomplishmentBlocks(compacted, entries).complete ? compacted : null;
}

export function buildDeterministicAccomplishmentBlocks(
  _groundedBlocks: GroundedAnswerBlock[],
  entries: AccomplishmentGroundingEntry[],
) {
  const requirements = selectAccomplishmentRequirementSet(entries).requirements;
  const ownershipCitationIndex = selfReportedOwnershipCitationIndexes(entries)[0];
  const citationCount = Math.max(0, ...entries.flatMap((entry) => entry.citationIndexes));
  const blocks: GroundedAnswerBlock[] = requirements.map((requirement) => {
    const bodyMarkdown = requirement.members.length === 1
      ? requirement.members[0]!.content.trim()
      : requirement.members.map((member) => `- ${member.content.trim()}`).join("\n");
    const technicalCitationIndexes = uniqueIndexes(requirement.citationIndexes);
    const block: GroundedAnswerBlock = {
      heading: stableRequirementHeading(requirement.requirementKey),
      bodyMarkdown,
      citationIndexes: technicalCitationIndexes,
    };
    const ownershipUnsupported = requirement.members.some((member) =>
      detectGroundingContractIssues({
        answer: `${member.content} ${uniqueIndexes(member.citationIndexes)
          .map((index) => `[citation:${index}]`)
          .join("")}`,
        citationCount,
        entries,
      }).some((issue) => issue.startsWith("Repository-only sources cannot establish personal ownership:"))
    );
    if (
      ownershipUnsupported &&
      ownershipCitationIndex &&
      block.citationIndexes.length < MAX_CITATIONS_PER_BLOCK
    ) {
      block.citationIndexes = uniqueIndexes([...block.citationIndexes, ownershipCitationIndex]);
    }
    return block;
  });
  return blocks;
}

function serializeBlocksForGroundingContract(blocks: GroundedAnswerBlock[]) {
  return serializeGroundedBlocks(blocks.map((block) => ({
    ...block,
    // Structured blocks carry one citation set for their complete body. Fold
    // list newlines only for the text-only contract parser so each bullet does
    // not appear to have lost the block-level citation set.
    bodyMarkdown: block.bodyMarkdown.replace(/\n+/g, " "),
  })));
}

function sameBlockShape(left: GroundedAnswerBlock, right: GroundedAnswerBlock) {
  return left.heading === right.heading &&
    left.bodyMarkdown === right.bodyMarkdown &&
    JSON.stringify(uniqueIndexes(left.citationIndexes)) === JSON.stringify(uniqueIndexes(right.citationIndexes));
}

export function validateExactSourceAccomplishmentBlocks(input: {
  blocks: GroundedAnswerBlock[];
  entries: AccomplishmentGroundingEntry[];
  citationCount: number;
  dossier?: ProjectResearchDossier | null;
}) {
  const expected = buildDeterministicAccomplishmentBlocks([], input.entries);
  const shape = completionSchema.safeParse({ blocks: input.blocks });
  if (!shape.success) {
    throw new CitationIntegrityError("The exact-source accomplishment fallback does not match the bounded block schema.");
  }
  if (
    input.blocks.length !== expected.length ||
    input.blocks.some((block, index) => !sameBlockShape(block, expected[index]!))
  ) {
    throw new CitationIntegrityError("The exact-source accomplishment fallback was not derived exactly from the selected durable requirements.");
  }
  const audit = auditAccomplishmentBlocks(input.blocks, input.entries);
  if (!audit.complete) {
    throw new CitationIntegrityError(
      `The exact-source accomplishment fallback omitted ${audit.missingMembers.length} required capability member${audit.missingMembers.length === 1 ? "" : "s"}.`,
    );
  }
  const contractIssues = detectGroundingContractIssues({
    answer: serializeBlocksForGroundingContract(input.blocks),
    citationCount: input.citationCount,
    dossier: input.dossier,
    entries: input.entries,
  });
  if (contractIssues.length) {
    throw new CitationIntegrityError(
      `The exact-source accomplishment fallback violated the grounding contract: ${contractIssues.join(" ")}`,
    );
  }
  return { blocks: input.blocks, audit };
}

export function serializeGroundedBlocks(blocks: GroundedAnswerBlock[]) {
  return blocks.map((block) => [
    block.heading ? `### ${block.heading.replace(/^#{1,6}\s*/, "")}` : null,
    `${block.bodyMarkdown} ${uniqueIndexes(block.citationIndexes).map((index) => `[citation:${index}]`).join("")}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}

export async function completeGroundedAccomplishmentAnswer(input: {
  workItemId: string;
  runId: string;
  blocks: GroundedAnswerBlock[];
  entries: AccomplishmentGroundingEntry[];
}) {
  const initialAudit = auditAccomplishmentBlocks(input.blocks, input.entries);
  const exactSourceBlocks = buildDeterministicAccomplishmentBlocks([], input.entries);
  const exactSourceCitationCount = Math.max(0, ...input.entries.flatMap((entry) => entry.citationIndexes));
  if (
    resolveWorkbaseLlmProvider() === "mock" ||
    (process.env.WORKBASE_COMPLETENESS_EDITOR_MODE ?? "deterministic") !== "model"
  ) {
    const exactSource = validateExactSourceAccomplishmentBlocks({
      blocks: exactSourceBlocks,
      entries: input.entries,
      citationCount: exactSourceCitationCount,
    });
    return {
      blocks: exactSource.blocks,
      exactSourceBlocks: exactSource.blocks,
      audit: exactSource.audit,
      generationRunId: null,
      fallbackUsed: true,
      warning: null,
    };
  }

  try {
    const completionBudget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 8_000,
      maxTotalTokens: 60_000,
    });
    const result = await runAuditedStructuredGeneration({
      workItemId: input.workItemId,
      kind: "answer_completeness_audit",
      idempotencyKey: `answer-completeness:${input.runId}`,
      inputSummary: {
        groundedBlockCount: input.blocks.length,
        requiredSubsystems: initialAudit.requirements.map((entry) => entry.requirementKey),
        missingSubsystems: initialAudit.missing.map((entry) => entry.requirementKey),
        omittedImportantEntries: initialAudit.omittedImportantEntries.map((entry) => entry.title),
      },
      execute: () => getBedrockStructuredLlmClient().generateStructured({
        systemPrompt: [
          "You are the final completeness editor for a citation-grounded accomplishment summary.",
          "Return 7–10 distinct accomplishments when that many supported capability entries exist; otherwise return one block per supported distinct capability.",
          "Cover every member of every required capability, combining related same-subsystem facts into one accurate block when possible.",
          "A citation index alone is not coverage: the block text must explicitly describe the corresponding required member.",
          "Use only supplied source entry content and citationIndexes. Do not invent ownership, impact, scale, reliability, completeness, or production claims.",
          "When using personal or subjectless accomplishment wording, include the supplied selfReportedOwnershipCitationIndexes alongside the technical citation; otherwise use neutral repository-implementation wording.",
          `Use no more than ${MAX_ACCOMPLISHMENT_CITATIONS} unique citation indexes across the entire response.`,
          "Do not write citation markers inside headings or bodyMarkdown.",
        ].join(" "),
        userPrompt: JSON.stringify({
          alreadyGroundedBlocks: input.blocks,
          requiredEntries: initialAudit.requirements,
          minimumBlocks: initialAudit.minimumBlocks,
          maximumBlocks: initialAudit.maximumBlocks,
          coverageWarning: initialAudit.coverageWarning,
          selfReportedOwnershipCitationIndexes: selfReportedOwnershipCitationIndexes(input.entries).slice(0, 1),
        }),
        schema: completionSchema,
        schemaName: "project_answer_completeness_audit",
        schemaDescription: "A complete, nonredundant set of supported accomplishment blocks using only supplied citation indexes.",
        jsonSchema: completionJsonSchema,
        maxTokens: 8_000,
        temperature: 0,
        effort: "high",
        transportPreference: ["bedrock_json_schema"],
        budget: completionBudget,
        extraValidation: (value) => {
          const blocks = value.blocks;
          const errors: string[] = [];
          const allowedCitationIndexes = new Set(input.entries.flatMap((entry) => entry.citationIndexes));
          if (blocks.length < initialAudit.minimumBlocks) errors.push(`At least ${initialAudit.minimumBlocks} distinct blocks are required.`);
          if (blocks.some((block) => /\[citation:\d+\]|\[\d+\]/i.test(`${block.heading} ${block.bodyMarkdown}`))) {
            errors.push("Blocks must use citationIndexes instead of citation marker text.");
          }
          if (blocks.some((block) => block.citationIndexes.some((index) => !allowedCitationIndexes.has(index)))) {
            errors.push("A block references an unavailable citation index.");
          }
          const audit = auditAccomplishmentBlocks(blocks, input.entries);
          for (const missing of audit.missingMembers) {
            errors.push(`Missing required capability member: ${missing.requirementKey} / ${missing.member.title}.`);
          }
          if (audit.citationBudgetExceeded) errors.push(`No more than ${MAX_ACCOMPLISHMENT_CITATIONS} unique citations are allowed.`);
          return errors;
        },
      }),
    });
    const blocks = result.data.blocks;
    return {
      blocks,
      exactSourceBlocks,
      audit: auditAccomplishmentBlocks(blocks, input.entries),
      generationRunId: result.generationRunId,
      fallbackUsed: false,
      warning: null,
    };
  } catch (error) {
    const exactSource = validateExactSourceAccomplishmentBlocks({
      blocks: exactSourceBlocks,
      entries: input.entries,
      citationCount: exactSourceCitationCount,
    });
    return {
      blocks: exactSource.blocks,
      exactSourceBlocks: exactSource.blocks,
      audit: exactSource.audit,
      generationRunId: null,
      fallbackUsed: true,
      warning: error instanceof Error ? error.message.slice(0, 500) : "The completeness editor failed validation.",
    };
  }
}

export async function verifyCompletedAccomplishmentAnswer(input: {
  completion: Awaited<ReturnType<typeof completeGroundedAccomplishmentAnswer>>;
  entries: AccomplishmentGroundingEntry[];
  citationCount: number;
  dossier?: ProjectResearchDossier | null;
  verifier?: typeof groundProjectAnswer;
}) {
  const verifier = input.verifier ?? groundProjectAnswer;
  const exactSource = () => validateExactSourceAccomplishmentBlocks({
    blocks: input.completion.exactSourceBlocks,
    entries: input.entries,
    citationCount: input.citationCount,
    dossier: input.dossier,
  });
  const publishExactSource = (detail: string | null) => {
    const validated = exactSource();
    return {
      grounded: {
        blocks: validated.blocks,
        issues: detail ? [detail] : [],
        tokenUsage: null,
      },
      audit: validated.audit,
      partial: false,
      warning: null,
    };
  };
  if (input.completion.fallbackUsed) {
    return publishExactSource(input.completion.warning);
  }
  try {
    const grounded = await verifier({
      answer: serializeGroundedBlocks(input.completion.blocks),
      entries: input.entries,
      citationCount: input.citationCount,
      dossier: input.dossier,
      requiredBlockCount: {
        minimum: input.completion.audit.minimumBlocks,
        maximum: input.completion.audit.maximumBlocks,
      },
      singleAttempt: true,
    });
    const audit = auditAccomplishmentBlocks(grounded.blocks, input.entries);
    if (!audit.complete) {
      throw new CitationIntegrityError(
        `Final verification omitted ${audit.missingMembers.length} required capability member${audit.missingMembers.length === 1 ? "" : "s"}.`,
      );
    }
    return { grounded, audit, partial: false, warning: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown final verifier failure.";
    return publishExactSource(`The combined final verifier failed; the answer was restored from exact durable source text. ${detail}`);
  }
}
