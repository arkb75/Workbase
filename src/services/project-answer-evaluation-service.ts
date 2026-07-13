export interface EvaluatedCitation {
  ordinal: number;
  kind: string;
}

export interface EvaluatedAccomplishmentBlock {
  heading: string;
  body: string;
  citationOrdinals: number[];
}

export interface RuntimeAccomplishmentRequirement {
  key: string;
  subsystemKeys: string[];
  sourceRefs: Array<{ kind: string; sourceId: string; title: string }>;
  members: Array<{
    title: string;
    sourceRefs: Array<{ kind: string; sourceId: string; title: string }>;
  }>;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseRuntimeAccomplishmentAudit(payload: unknown) {
  const value = objectValue(payload);
  if (!value) return null;
  const requirements = Array.isArray(value.requirements)
    ? value.requirements.flatMap((candidate): RuntimeAccomplishmentRequirement[] => {
        const entry = objectValue(candidate);
        if (!entry || typeof entry.key !== "string" || !entry.key.trim()) return [];
        return [{
          key: entry.key,
          subsystemKeys: Array.isArray(entry.subsystemKeys)
            ? entry.subsystemKeys.filter((key): key is string => typeof key === "string")
            : [],
          sourceRefs: Array.isArray(entry.sourceRefs)
            ? entry.sourceRefs.flatMap((source): RuntimeAccomplishmentRequirement["sourceRefs"] => {
                const ref = objectValue(source);
                if (!ref || typeof ref.kind !== "string" || typeof ref.sourceId !== "string") return [];
                return [{ kind: ref.kind, sourceId: ref.sourceId, title: typeof ref.title === "string" ? ref.title : ref.sourceId }];
              })
            : [],
          members: Array.isArray(entry.members)
            ? entry.members.flatMap((member): RuntimeAccomplishmentRequirement["members"] => {
                const item = objectValue(member);
                if (!item) return [];
                const sourceRefs = Array.isArray(item.sourceRefs)
                  ? item.sourceRefs.flatMap((source): RuntimeAccomplishmentRequirement["sourceRefs"] => {
                      const ref = objectValue(source);
                      if (!ref || typeof ref.kind !== "string" || typeof ref.sourceId !== "string") return [];
                      return [{ kind: ref.kind, sourceId: ref.sourceId, title: typeof ref.title === "string" ? ref.title : ref.sourceId }];
                    })
                  : [];
                return [{ title: typeof item.title === "string" ? item.title : entry.key as string, sourceRefs }];
              })
            : [],
        }];
      })
    : [];
  const minimumBlocks = typeof value.minimumBlocks === "number" && Number.isInteger(value.minimumBlocks)
    ? value.minimumBlocks
    : null;
  const maximumBlocks = typeof value.maximumBlocks === "number" && Number.isInteger(value.maximumBlocks)
    ? value.maximumBlocks
    : null;
  if (!requirements.length || minimumBlocks == null || maximumBlocks == null) return null;
  return { requirements, minimumBlocks, maximumBlocks };
}

export function evaluateRuntimeRequirementCoverage(input: {
  requirements: RuntimeAccomplishmentRequirement[];
  citedSources: Iterable<{ kind: string; sourceId: string }>;
}) {
  const cited = new Set(Array.from(input.citedSources, (source) => `${source.kind}:${source.sourceId}`));
  const missingMembers = input.requirements.flatMap((requirement) => {
    const members = requirement.members.length ? requirement.members : [{ title: requirement.key, sourceRefs: requirement.sourceRefs }];
    return members
      .filter((member) => !member.sourceRefs.some((source) => cited.has(`${source.kind}:${source.sourceId}`)))
      .map((member) => ({ requirementKey: requirement.key, title: member.title }));
  });
  const missingKeys = new Set(missingMembers.map((member) => member.requirementKey));
  const missing = input.requirements.filter((requirement) => missingKeys.has(requirement.key));
  return { complete: missingMembers.length === 0, missing, missingMembers };
}

export function isEntityValidationCurrent(input: {
  validationHeads: unknown;
  validatedThroughSha: string | null;
  targetHeads: Array<{ sourceId: string; commitSha: string }>;
}) {
  const targetBySource = new Map(input.targetHeads.map((target) => [target.sourceId, target.commitSha]));
  const validationHeads = objectValue(input.validationHeads);
  const entries = validationHeads
    ? Object.entries(validationHeads).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : [];
  if (entries.length) return entries.every(([sourceId, commitSha]) => targetBySource.get(sourceId) === commitSha);
  return Boolean(input.validatedThroughSha && input.targetHeads.some((target) => target.commitSha === input.validatedThroughSha));
}

function terms(value: string) {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
}

function similarity(left: string, right: string) {
  const leftTerms = terms(left);
  const rightTerms = terms(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  const overlap = Array.from(leftTerms).filter((term) => rightTerms.has(term)).length;
  return overlap / new Set([...leftTerms, ...rightTerms]).size;
}

export function parseAccomplishmentBlocks(content: string) {
  const matches = Array.from(content.matchAll(/^###\s+(.+)$/gm));
  return matches.map((match, index): EvaluatedAccomplishmentBlock => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const body = content.slice(start, end).trim();
    return {
      heading: match[1]!.trim(),
      body,
      citationOrdinals: Array.from(body.matchAll(/\[citation:(\d+)\]/g))
        .map((citation) => Number(citation[1]))
        .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0),
    };
  });
}

export function evaluateAccomplishmentAnswerStructure(input: {
  content: string;
  citations: EvaluatedCitation[];
  countRange?: { minimum: number; maximum: number };
}) {
  const blocks = parseAccomplishmentBlocks(input.content);
  const citationKindByOrdinal = new Map(input.citations.map((citation) => [citation.ordinal, citation.kind]));
  const redundantPairs: Array<[number, number]> = [];
  for (let left = 0; left < blocks.length; left += 1) {
    for (let right = left + 1; right < blocks.length; right += 1) {
      if (similarity(`${blocks[left]!.heading} ${blocks[left]!.body}`, `${blocks[right]!.heading} ${blocks[right]!.body}`) >= 0.72) {
        redundantPairs.push([left + 1, right + 1]);
      }
    }
  }
  const artifactOnlyBlocks = blocks
    .map((block, index) => ({ block, index: index + 1 }))
    .filter(({ block }) => block.citationOrdinals.length > 0)
    .filter(({ block }) => block.citationOrdinals.every((ordinal) => citationKindByOrdinal.get(ordinal) === "artifact"))
    .map(({ index }) => index);
  const uncitedBlocks = blocks
    .map((block, index) => ({ block, index: index + 1 }))
    .filter(({ block }) => block.citationOrdinals.length === 0)
    .map(({ index }) => index);
  return {
    blocks,
    accomplishmentCount: blocks.length,
    countInRange: blocks.length >= (input.countRange?.minimum ?? 7) && blocks.length <= (input.countRange?.maximum ?? 10),
    countRange: input.countRange ?? { minimum: 7, maximum: 10 },
    nonredundant: redundantPairs.length === 0,
    redundantPairs,
    allBlocksCited: uncitedBlocks.length === 0,
    uncitedBlocks,
    noArtifactOnlyBlocks: artifactOnlyBlocks.length === 0,
    artifactOnlyBlocks,
  };
}
