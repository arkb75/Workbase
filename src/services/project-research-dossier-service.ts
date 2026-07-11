import type {
  ProjectKnowledgeCitation,
  ProjectResearchDossier,
  ProjectResearchRepositorySnapshot,
  ProjectResearchResult,
} from "@/src/domain/project-chat";

const dossierPhases = new Set<ProjectResearchDossier["phase"]>([
  "planning",
  "searching",
  "reading",
  "extracting",
  "awaiting_review",
  "finalizing",
  "completed",
  "insufficient_context",
  "failed",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function unique(values: readonly string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseRepositories(value: unknown): ProjectResearchRepositorySnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const source = record(entry);
    const sourceId = stringValue(source?.sourceId);
    const name = stringValue(source?.name);
    const importedAt = stringValue(source?.importedAt);
    if (!sourceId || !name || !importedAt) return [];
    return [{
      sourceId,
      name,
      importedAt,
      pinnedSha: stringValue(source?.pinnedSha),
      committedAt: stringValue(source?.committedAt),
      resolvedAt: stringValue(source?.resolvedAt),
    }];
  });
}

function parseCoverage(value: unknown): ProjectResearchResult["coverage"] {
  const source = record(value);
  if (!source) return null;
  return {
    planned: strings(source.planned),
    achieved: strings(source.achieved),
    uninspected: strings(source.uninspected),
    omittedRepositories: strings(source.omittedRepositories),
  };
}

function parseNotebook(value: unknown): ProjectResearchDossier["notebook"] {
  const source = record(value);
  if (!source) return null;
  const paths = Array.isArray(source.paths)
    ? source.paths.flatMap((entry) => {
        const path = record(entry);
        const handle = stringValue(path?.handle);
        const sourceId = stringValue(path?.sourceId);
        const repository = stringValue(path?.repository);
        const pathName = stringValue(path?.path);
        const origin = stringValue(path?.origin);
        const score = typeof path?.score === "number" ? path.score : null;
        return handle && sourceId && repository && pathName && origin && score != null
          ? [{ handle, sourceId, repository, path: pathName, origin, score }]
          : [];
      })
    : [];
  const citations = Array.isArray(source.citations)
    ? source.citations.flatMap((entry) => {
        const citation = record(entry);
        const type = stringValue(citation?.type);
        const title = stringValue(citation?.title);
        if (!type || !title || !["highlight", "project_fact", "evidence", "artifact", "github_file"].includes(type)) return [];
        return [{
          type: type as ProjectKnowledgeCitation["kind"],
          title,
          repository: stringValue(citation?.repository) ?? undefined,
          commitSha: stringValue(citation?.commitSha) ?? undefined,
          path: stringValue(citation?.path) ?? undefined,
          startLine: typeof citation?.startLine === "number" ? citation.startLine : undefined,
          endLine: typeof citation?.endLine === "number" ? citation.endLine : undefined,
        }];
      })
    : [];
  return { paths, citations };
}

function repositoriesFromEnvironment(value: unknown) {
  const environment = record(value);
  const capabilities = record(environment?.capabilities);
  const repositoryResearch = record(capabilities?.repositoryResearch);
  return parseRepositories(repositoryResearch?.repositories);
}

/**
 * Reads both the v1 dossier and the legacy v2 researchState shape. The
 * environment snapshot is used only to recover repository identity for runs
 * created before repository snapshots were copied into researchState.
 */
export function parseProjectResearchDossier(
  value: unknown,
  environmentSnapshot?: unknown,
): ProjectResearchDossier | null {
  const source = record(value);
  if (!source) return null;
  const phaseValue = stringValue(source.phase);
  const phase = phaseValue && dossierPhases.has(phaseValue as ProjectResearchDossier["phase"])
    ? phaseValue as ProjectResearchDossier["phase"]
    : "planning";
  const updatedAt = stringValue(source.updatedAt) ?? new Date(0).toISOString();
  const coverage = parseCoverage(source.coverage);
  const finalization = record(source.finalization);

  return {
    version: 1,
    controllerVersion: stringValue(source.controllerVersion),
    allowedActions: unique(strings(source.allowedActions)),
    remaining: record(source.remaining),
    objective: stringValue(source.objective) ?? stringValue(record(environmentSnapshot)?.objective) ?? "",
    phase,
    startedAt: stringValue(source.startedAt) ?? updatedAt,
    updatedAt,
    researchedAt: stringValue(source.researchedAt),
    completedAt: stringValue(source.completedAt),
    repositories: parseRepositories(source.repositories).length
      ? parseRepositories(source.repositories)
      : repositoriesFromEnvironment(environmentSnapshot),
    coverage,
    coverageGaps: unique([
      ...strings(source.coverageGaps),
      ...(coverage?.uninspected ?? []),
    ]),
    warnings: unique(strings(source.warnings)),
    partial: source.partial === true,
    usage: record(source.usage),
    notebook: parseNotebook(source.notebook),
    candidateIds: unique(strings(source.candidateIds)),
    provisionalProjectFactIds: unique(strings(source.provisionalProjectFactIds)),
    generationRunIds: unique(strings(source.generationRunIds)),
    modelUsage: Array.isArray(source.modelUsage) ? source.modelUsage : [],
    finalization: finalization
      ? {
          citationCount: typeof finalization.citationCount === "number" ? finalization.citationCount : 0,
          usedProjectFactIds: unique(strings(finalization.usedProjectFactIds)),
        }
      : null,
  };
}

export function mergeProjectResearchDossier(
  current: ProjectResearchDossier | null,
  patch: Partial<ProjectResearchDossier> & Pick<ProjectResearchDossier, "objective" | "phase" | "repositories">,
): ProjectResearchDossier {
  const now = new Date().toISOString();
  const coverage = patch.coverage ?? current?.coverage ?? null;
  return {
    version: 1,
    controllerVersion: patch.controllerVersion ?? current?.controllerVersion ?? null,
    allowedActions: patch.allowedActions ?? current?.allowedActions ?? [],
    remaining: patch.remaining ?? current?.remaining ?? null,
    objective: patch.objective || current?.objective || "",
    phase: patch.phase,
    startedAt: current?.startedAt ?? patch.startedAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    researchedAt: patch.researchedAt ?? current?.researchedAt ?? null,
    completedAt: patch.completedAt ?? current?.completedAt ?? null,
    repositories: current?.repositories.length ? current.repositories : patch.repositories,
    coverage,
    coverageGaps: unique([
      ...(current?.coverageGaps ?? []),
      ...(patch.coverageGaps ?? []),
      ...(coverage?.uninspected ?? []),
    ]),
    warnings: unique([...(current?.warnings ?? []), ...(patch.warnings ?? [])]),
    partial: Boolean(current?.partial || patch.partial),
    usage: patch.usage ?? current?.usage ?? null,
    notebook: patch.notebook ?? current?.notebook ?? null,
    candidateIds: unique([...(current?.candidateIds ?? []), ...(patch.candidateIds ?? [])]),
    provisionalProjectFactIds: unique([
      ...(current?.provisionalProjectFactIds ?? []),
      ...(patch.provisionalProjectFactIds ?? []),
    ]),
    generationRunIds: unique([...(current?.generationRunIds ?? []), ...(patch.generationRunIds ?? [])]),
    modelUsage: patch.modelUsage ?? current?.modelUsage ?? [],
    finalization: patch.finalization ?? current?.finalization ?? null,
  };
}

export function completeProjectResearchDossier(
  value: unknown,
  environmentSnapshot: unknown,
  input: {
    status: "completed" | "insufficient_context" | "failed";
    citationCount: number;
    usedProjectFactIds: string[];
  },
) {
  const current = parseProjectResearchDossier(value, environmentSnapshot);
  if (!current) return null;
  const completedAt = new Date().toISOString();
  return mergeProjectResearchDossier(current, {
    objective: current.objective,
    phase: input.status,
    repositories: current.repositories,
    completedAt,
    researchedAt: current.researchedAt ?? current.updatedAt,
    finalization: {
      citationCount: input.citationCount,
      usedProjectFactIds: unique(input.usedProjectFactIds),
    },
  });
}

export function repositoryFreshnessFromDossier(dossier: ProjectResearchDossier | null) {
  return {
    latestSourceImportedAt: dossier?.repositories.map((entry) => entry.importedAt).sort().at(-1) ?? null,
    latestRepositoryCommitAt: dossier?.repositories.flatMap((entry) => entry.committedAt ? [entry.committedAt] : []).sort().at(-1) ?? null,
    latestRepositoryInspectedAt: dossier?.repositories.flatMap((entry) => entry.resolvedAt ? [entry.resolvedAt] : []).sort().at(-1) ?? dossier?.researchedAt ?? null,
    pinnedRevisions: dossier?.repositories.map((entry) => ({
      repository: entry.name,
      commitSha: entry.pinnedSha,
      committedAt: entry.committedAt,
      inspectedAt: entry.resolvedAt ?? dossier.researchedAt,
    })) ?? [],
  };
}
