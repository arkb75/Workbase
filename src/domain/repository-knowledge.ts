export const repositoryKnowledgeRoles = [
  "implementation",
  "limitation",
] as const;

export type RepositoryKnowledgeRole =
  (typeof repositoryKnowledgeRoles)[number];

export const repositoryKnowledgeImplementationStates = [
  "implemented",
  "partial",
  "planned",
  "bounded_absence",
] as const;

export type RepositoryKnowledgeImplementationState =
  (typeof repositoryKnowledgeImplementationStates)[number];

export const repositoryOperationFacets = [
  "entrypoint",
  "transition",
  "persistence",
  "side_effect",
  "boundary",
  "architecture",
] as const;

export type RepositoryOperationFacet =
  (typeof repositoryOperationFacets)[number];

export const REPOSITORY_KNOWLEDGE_METADATA_SCHEMA_VERSION =
  "repository-knowledge-metadata-v1" as const;

/**
 * Server-owned semantic identity retained after source observations become a
 * durable Project Fact or Highlight. Arrays are intentional: one synthesized
 * claim can cite several exact operation facets, while a single-value consumer
 * must treat mixed or legacy state as unknown instead of guessing.
 */
export interface RepositoryKnowledgeMetadata {
  schemaVersion: typeof REPOSITORY_KNOWLEDGE_METADATA_SCHEMA_VERSION;
  managedBy: "repository_knowledge_sync";
  refreshRunId: string;
  /** Stable attached-source identities; repository labels and paths are mutable. */
  sourceIds: string[];
  subsystemKey: string;
  synthesisKey: string | null;
  knowledgeRoles: RepositoryKnowledgeRole[];
  implementationStates: RepositoryKnowledgeImplementationState[];
  operationKeys: string[];
  operationFacets: RepositoryOperationFacet[];
}

type RepositoryKnowledgeMetadataSource = {
  sourceId?: string;
  knowledgeRole?: RepositoryKnowledgeRole;
  implementationState?: RepositoryKnowledgeImplementationState;
  operationKey?: string;
  operationFacet?: RepositoryOperationFacet;
};

function uniqueSorted<T extends string>(
  values: readonly T[],
  order?: readonly T[],
) {
  const unique = Array.from(new Set(values));
  if (!order) return unique.sort((left, right) => left.localeCompare(right));
  const rank = new Map(order.map((value, index) => [value, index]));
  return unique.sort((left, right) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    left.localeCompare(right)
  );
}

export function buildRepositoryKnowledgeMetadata(input: {
  refreshRunId: string;
  subsystemKey: string;
  synthesisKey?: string | null;
  sources: readonly RepositoryKnowledgeMetadataSource[];
}): RepositoryKnowledgeMetadata {
  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_METADATA_SCHEMA_VERSION,
    managedBy: "repository_knowledge_sync",
    refreshRunId: input.refreshRunId,
    sourceIds: uniqueSorted(input.sources.flatMap((source) => {
      const sourceId = source.sourceId?.trim();
      return sourceId ? [sourceId] : [];
    })),
    subsystemKey: input.subsystemKey,
    synthesisKey: input.synthesisKey?.trim() || null,
    knowledgeRoles: uniqueSorted(
      input.sources.flatMap((source) =>
        source.knowledgeRole ? [source.knowledgeRole] : []
      ),
      repositoryKnowledgeRoles,
    ),
    implementationStates: uniqueSorted(
      input.sources.flatMap((source) =>
        source.implementationState ? [source.implementationState] : []
      ),
      repositoryKnowledgeImplementationStates,
    ),
    operationKeys: uniqueSorted(input.sources.flatMap((source) => {
      const key = source.operationKey?.trim();
      return key ? [key] : [];
    })),
    operationFacets: uniqueSorted(
      input.sources.flatMap((source) =>
        source.operationFacet ? [source.operationFacet] : []
      ),
      repositoryOperationFacets,
    ),
  };
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function enumArray<T extends string>(value: unknown, options: readonly T[]) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(options);
  return uniqueSorted(value.filter((entry): entry is T =>
    typeof entry === "string" && allowed.has(entry)
  ), options);
}

function stringArray(value: unknown) {
  return !Array.isArray(value)
    ? []
    : uniqueSorted(value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : []
      ));
}

/** Parses only the versioned shape; legacy untyped metadata remains unknown. */
export function parseRepositoryKnowledgeMetadata(
  value: unknown,
): RepositoryKnowledgeMetadata | null {
  const metadata = record(value);
  if (
    metadata?.schemaVersion !== REPOSITORY_KNOWLEDGE_METADATA_SCHEMA_VERSION ||
    metadata.managedBy !== "repository_knowledge_sync" ||
    typeof metadata.refreshRunId !== "string" ||
    !metadata.refreshRunId.trim() ||
    typeof metadata.subsystemKey !== "string" ||
    !metadata.subsystemKey.trim() ||
    !(typeof metadata.synthesisKey === "string" || metadata.synthesisKey === null)
  ) return null;

  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_METADATA_SCHEMA_VERSION,
    managedBy: "repository_knowledge_sync",
    refreshRunId: metadata.refreshRunId,
    // Early v1 rows did not yet persist sourceIds. Keep them readable as
    // unknown-source metadata; reconciliation can recover the IDs from their
    // immutable Evidence relations and write the complete shape on success.
    sourceIds: stringArray(metadata.sourceIds),
    subsystemKey: metadata.subsystemKey,
    synthesisKey: metadata.synthesisKey,
    knowledgeRoles: enumArray(metadata.knowledgeRoles, repositoryKnowledgeRoles),
    implementationStates: enumArray(
      metadata.implementationStates,
      repositoryKnowledgeImplementationStates,
    ),
    operationKeys: stringArray(metadata.operationKeys),
    operationFacets: enumArray(metadata.operationFacets, repositoryOperationFacets),
  };
}

export function repositoryKnowledgeClaimState(
  metadata: RepositoryKnowledgeMetadata | null,
): RepositoryKnowledgeImplementationState | "unknown" {
  return metadata?.implementationStates.length === 1
    ? metadata.implementationStates[0]!
    : "unknown";
}
