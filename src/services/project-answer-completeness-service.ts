import { z } from "zod";
import type {
  GroundedAnswerBlock,
  ProjectResearchDossier,
} from "@/src/domain/project-chat";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { CitationIntegrityError } from "@/src/services/chat-citation-service";
import {
  groundProjectAnswer,
  type ProjectAnswerGroundingEntry,
} from "@/src/services/project-answer-grounding-service";
import { runAuditedStructuredGeneration } from "@/src/services/structured-generation-audit-service";

const MAX_ACCOMPLISHMENT_BLOCKS = 10;
const MAX_CITATIONS_PER_BLOCK = 4;
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

export function selectAccomplishmentRequirementSet(
  entries: AccomplishmentGroundingEntry[],
): AccomplishmentRequirementSelection {
  const eligible = entries
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
    const important = group.filter(isImportant);
    const candidates = important.length ? important : [group[0]!];
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
    const important = group.filter(isImportant);
    omittedImportantEntries.push(...(important.length ? important : [group[0]!]));
  }

  // Give every selected capability area one representative before allowing a
  // citation-rich early subsystem to consume the global answer budget. Add
  // additional same-subsystem facts one at a time across groups.
  const maximumCandidateDepth = Math.max(0, ...selectedGroups.map((group) => group.candidates.length));
  for (let depth = 1; depth < maximumCandidateDepth; depth += 1) {
    for (const group of selectedGroups) {
      const candidate = group.candidates[depth];
      if (!candidate) continue;
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
  const coverageWarning = omitted.length
    ? `This summary prioritizes ${requirements.length} capability area${requirements.length === 1 ? "" : "s"} within the 10-item and 20-source answer limits; ${omitted.length} additional supported item${omitted.length === 1 ? " was" : "s were"} not included.`
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

export function buildDeterministicAccomplishmentBlocks(
  groundedBlocks: GroundedAnswerBlock[],
  entries: AccomplishmentGroundingEntry[],
) {
  const audit = auditAccomplishmentBlocks(groundedBlocks, entries);
  const ownershipCitationIndex = selfReportedOwnershipCitationIndexes(entries)[0];
  const blocks: GroundedAnswerBlock[] = audit.requirements.map((requirement) => ({
    heading: requirement.title,
    bodyMarkdown: requirement.content.slice(0, 1_600),
    citationIndexes: uniqueIndexes([
      ...requirement.citationIndexes,
      ...(ownershipCitationIndex ? [ownershipCitationIndex] : []),
    ]).slice(0, MAX_CITATIONS_PER_BLOCK),
  }));
  const usedCitationIndexes = new Set(blocks.flatMap((block) => block.citationIndexes));
  for (const block of groundedBlocks) {
    if (blocks.length >= audit.maximumBlocks) break;
    if (blocks.some((existing) => existing.citationIndexes.some((index) => block.citationIndexes.includes(index)))) continue;
    const nextIndexes = uniqueIndexes([...usedCitationIndexes, ...block.citationIndexes]);
    if (nextIndexes.length > MAX_ACCOMPLISHMENT_CITATIONS) continue;
    blocks.push(block);
    for (const index of block.citationIndexes) usedCitationIndexes.add(index);
  }
  return blocks.slice(0, audit.maximumBlocks);
}

export function serializeGroundedBlocks(blocks: GroundedAnswerBlock[]) {
  return blocks.map((block) => [
    block.heading ? `### ${block.heading.replace(/^#{1,6}\s*/, "")}` : null,
    `${block.bodyMarkdown} ${uniqueIndexes(block.citationIndexes).map((index) => `[citation:${index}]`).join("")}`,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function boundedPreviouslyGroundedBlocks(blocks: GroundedAnswerBlock[]) {
  const selected: GroundedAnswerBlock[] = [];
  const usedCitationIndexes = new Set<number>();
  for (const block of blocks) {
    if (selected.length >= MAX_ACCOMPLISHMENT_BLOCKS) break;
    const blockIndexes = uniqueIndexes(block.citationIndexes);
    if (!blockIndexes.length || blockIndexes.length > MAX_CITATIONS_PER_BLOCK) continue;
    const nextIndexes = uniqueIndexes([...usedCitationIndexes, ...blockIndexes]);
    if (nextIndexes.length > MAX_ACCOMPLISHMENT_CITATIONS) continue;
    selected.push({ ...block, citationIndexes: blockIndexes });
    for (const index of blockIndexes) usedCitationIndexes.add(index);
  }
  return selected;
}

export async function completeGroundedAccomplishmentAnswer(input: {
  workItemId: string;
  runId: string;
  blocks: GroundedAnswerBlock[];
  entries: AccomplishmentGroundingEntry[];
}) {
  const initialAudit = auditAccomplishmentBlocks(input.blocks, input.entries);
  const safeOriginalBlocks = boundedPreviouslyGroundedBlocks(input.blocks);
  if (resolveWorkbaseLlmProvider() === "mock") {
    const blocks = buildDeterministicAccomplishmentBlocks(input.blocks, input.entries);
    return {
      blocks,
      safeOriginalBlocks,
      audit: auditAccomplishmentBlocks(blocks, input.entries),
      generationRunId: null,
      fallbackUsed: false,
      warning: null,
    };
  }

  try {
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
          availableEntries: input.entries,
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
        repairStrategy: "repair_last_failure",
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
      safeOriginalBlocks,
      audit: auditAccomplishmentBlocks(blocks, input.entries),
      generationRunId: result.generationRunId,
      fallbackUsed: false,
      warning: null,
    };
  } catch (error) {
    // The first grounding pass has already verified the existing blocks. The
    // deterministic notebook is allowed only as input to a second verifier; it
    // is never published directly.
    const blocks = buildDeterministicAccomplishmentBlocks(input.blocks, input.entries);
    return {
      blocks,
      safeOriginalBlocks,
      audit: auditAccomplishmentBlocks(blocks, input.entries),
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
    const safeBlocks = input.completion.safeOriginalBlocks ?? [];
    if (safeBlocks.length) {
      const audit = auditAccomplishmentBlocks(safeBlocks, input.entries);
      const missingCount = audit.missingMembers.length;
      const warning = [
        "The final completeness verifier was unavailable, so this answer shows only the subset already verified by the first grounding pass.",
        missingCount
          ? `${missingCount} supported capability member${missingCount === 1 ? " was" : "s were"} omitted rather than restored without verification.`
          : null,
      ].filter(Boolean).join(" ");
      return {
        grounded: {
          blocks: safeBlocks,
          issues: [warning, detail],
          tokenUsage: null,
        },
        audit: { ...audit, coverageWarning: warning, complete: false },
        partial: true,
        warning,
      };
    }
    throw new CitationIntegrityError(
      `The final accomplishment verification was not safe to publish and should be retried. ${detail}`,
    );
  }
}
