import {
  githubRepositoryExplorationService,
  type GitHubRepositoryExplorationSession,
} from "@/src/services/github-repository-exploration-service";

export interface ProjectChatAttachedSource {
  id: string;
  type: string;
  label: string;
  metadata: unknown;
  updatedAt: Date;
  resolvedRevision?: string | null;
}

export interface ProjectChatSourceSearchResult {
  handle: string;
  sourceId: string;
  sourceLabel: string;
  sourceType: string;
  repository: string;
  commitSha: string;
  path: string;
  size: number | null;
  immutableUrl: string;
  requiresRead: true;
}

interface StoredSourceHandle {
  source: ProjectChatAttachedSource;
  session: GitHubRepositoryExplorationSession;
  path: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedString(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) current = record(current)[key];
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

export function projectChatSourceSummary(source: ProjectChatAttachedSource) {
  const repository = nestedString(source.metadata, ["repository", "fullName"]);
  const importedRevision = source.resolvedRevision ??
    nestedString(source.metadata, ["revision", "commitSha"]) ??
    nestedString(source.metadata, ["commitSha"]);
  return {
    sourceId: source.id,
    type: source.type,
    label: source.label,
    repository,
    importedRevision,
    updatedAt: source.updatedAt.toISOString(),
    capabilities: source.type === "github_repo"
      ? ["list_paths", "search", "read", "refresh"]
      : ["knowledge_search"],
  };
}

/**
 * Turn-local exploration over authorized attached sources. The public tool
 * contract is connector-neutral; this adapter currently supports GitHub and
 * can gain additional source adapters without changing the model vocabulary.
 */
export class ProjectChatSourceExplorer {
  readonly #sessions = new Map<string, Promise<GitHubRepositoryExplorationSession>>();
  readonly #handles = new Map<string, StoredSourceHandle>();
  readonly #pathHandles = new Map<string, string>();
  readonly #listedInventories = new Set<string>();
  readonly #completedSearches = new Set<string>();
  readonly #budget = githubRepositoryExplorationService.createBudget();
  #nextHandle = 1;

  constructor(
    readonly input: {
      userId: string;
      workItemId: string;
      sources: ProjectChatAttachedSource[];
    },
  ) {}

  list() {
    return this.input.sources.map(projectChatSourceSummary);
  }

  async #session(source: ProjectChatAttachedSource) {
    const existing = this.#sessions.get(source.id);
    if (existing) return existing;
    const started = githubRepositoryExplorationService.start({
      userId: this.input.userId,
      workItemId: this.input.workItemId,
      sourceId: source.id,
      budget: this.#budget,
    });
    this.#sessions.set(source.id, started);
    return started;
  }

  #handleFor(input: {
    source: ProjectChatAttachedSource;
    session: GitHubRepositoryExplorationSession;
    path: string;
  }) {
    const key = `${input.source.id}:${input.path}`;
    const existing = this.#pathHandles.get(key);
    if (existing) return existing;
    const handle = `source-result-${this.#nextHandle}`;
    this.#nextHandle += 1;
    this.#pathHandles.set(key, handle);
    this.#handles.set(handle, input);
    return handle;
  }

  #candidateSources(sourceIds?: string[]) {
    const requested = new Set(sourceIds ?? []);
    const candidates = this.input.sources.filter((source) =>
      source.type === "github_repo" &&
      (!requested.size || requested.has(source.id))
    ).slice(0, 2);
    const unsupportedSourceIds = this.input.sources
      .filter((source) =>
        (requested.size ? requested.has(source.id) : true) &&
        source.type !== "github_repo"
      )
      .map((source) => source.id);
    return { candidates, unsupportedSourceIds };
  }

  async listPaths(input: {
    sourceIds?: string[];
    maxResults: number;
  }) {
    const inventoryKey = [...(input.sourceIds ?? [])].sort().join(",") || "all";
    if (this.#listedInventories.has(inventoryKey)) {
      return {
        matches: [],
        unsupportedSourceIds: [],
        listedSourceIds: input.sourceIds ?? [],
        alreadyListed: true,
        instruction: "The bounded path inventory for this source scope was already returned. Reuse its handles, search for a concrete symbol, or read selected files; do not list it again.",
      };
    }
    this.#listedInventories.add(inventoryKey);
    const { candidates, unsupportedSourceIds } = this.#candidateSources(
      input.sourceIds,
    );
    const perSource = Math.max(
      1,
      Math.min(40, Math.ceil(input.maxResults / Math.max(1, candidates.length))),
    );
    const matches: ProjectChatSourceSearchResult[] = [];
    for (const source of candidates) {
      const session = await this.#session(source);
      const listed = await session.listPaths({ limit: perSource });
      for (const path of listed.paths) {
        if (matches.length >= input.maxResults) break;
        matches.push({
          handle: this.#handleFor({ source, session, path: path.path }),
          sourceId: source.id,
          sourceLabel: source.label,
          sourceType: source.type,
          repository: session.snapshot.repository.fullName,
          commitSha: session.snapshot.revision.commitSha,
          path: path.path,
          size: path.size,
          immutableUrl: path.immutableUrl,
          requiresRead: true,
        });
      }
    }
    return {
      matches,
      unsupportedSourceIds,
      listedSourceIds: candidates.map((source) => source.id),
      instruction: matches.length
        ? "This is a bounded path inventory, not file evidence. Search within the current source when helpful, then read only the few handles needed for the answer."
        : "No eligible paths were available from the selected attached sources.",
    };
  }

  async search(input: {
    query: string;
    sourceIds?: string[];
    maxResults: number;
  }) {
    const searchKey = JSON.stringify({
      query: input.query.trim().replace(/\s+/g, " ").toLowerCase(),
      sourceIds: [...(input.sourceIds ?? [])].sort(),
    });
    if (this.#completedSearches.has(searchKey)) {
      return {
        query: input.query,
        matches: [],
        unsupportedSourceIds: [],
        unavailableSourceIds: [],
        searchedSourceIds: input.sourceIds ?? [],
        alreadySearched: true,
        instruction: "This exact current-source search was already completed. Reuse its earlier handles or try one materially different concrete query; do not repeat it.",
      };
    }
    this.#completedSearches.add(searchKey);
    const { candidates, unsupportedSourceIds } = this.#candidateSources(
      input.sourceIds,
    );
    const perSource = Math.max(
      1,
      Math.min(20, Math.ceil(input.maxResults / Math.max(1, candidates.length))),
    );
    const matches: ProjectChatSourceSearchResult[] = [];
    const unavailableSourceIds: string[] = [];
    for (const source of candidates) {
      const session = await this.#session(source);
      let found;
      try {
        found = await session.search({ query: input.query, limit: perSource });
      } catch {
        unavailableSourceIds.push(source.id);
        continue;
      }
      for (const match of found.matches) {
        if (matches.length >= input.maxResults) break;
        matches.push({
          handle: this.#handleFor({ source, session, path: match.path }),
          sourceId: source.id,
          sourceLabel: source.label,
          sourceType: source.type,
          repository: session.snapshot.repository.fullName,
          commitSha: session.snapshot.revision.commitSha,
          path: match.path,
          size: match.size,
          immutableUrl: match.immutableUrl,
          requiresRead: true,
        });
      }
    }
    return {
      query: input.query,
      matches,
      unsupportedSourceIds,
      unavailableSourceIds,
      searchedSourceIds: candidates.map((source) => source.id),
      instruction: matches.length
        ? "Search results identify candidate files only. Read the relevant handles before making claims from their contents."
        : unavailableSourceIds.length
          ? "The bounded search could not return more results. Do not repeat the same search; read useful handles already listed this turn, answer from sufficient project knowledge, or report the remaining gap."
          : "No matching attached source path was found. If repository vocabulary or file locations are unknown, inspect a bounded path inventory once; otherwise answer from sufficient project knowledge or report the gap.",
    };
  }

  async read(input: {
    requests: Array<{
      handle: string;
      lineStart?: number;
      lineEnd?: number;
      focusTerms?: string[];
    }>;
  }) {
    const results = [];
    for (const request of input.requests) {
      const stored = this.#handles.get(request.handle);
      if (!stored) {
        results.push({
          handle: request.handle,
          status: "invalid_handle" as const,
          message: "This handle was not returned by a current-turn source path or search result.",
        });
        continue;
      }
      let read;
      try {
        read = await stored.session.readFile({
          path: stored.path,
          lineStart: request.lineStart,
          lineEnd: request.lineEnd,
          focusTerms: request.focusTerms,
        });
      } catch {
        results.push({
          handle: request.handle,
          status: "read_error" as const,
          message: "The selected source could not be read within the current safety and budget boundary.",
        });
        continue;
      }
      results.push({
        handle: request.handle,
        status: "read" as const,
        sourceId: stored.source.id,
        sourceLabel: stored.source.label,
        repository: stored.session.snapshot.repository.fullName,
        commitSha: stored.session.snapshot.revision.commitSha,
        path: read.path,
        content: read.content,
        lineStart: read.lineStart,
        lineEnd: read.lineEnd,
        totalLines: read.totalLines,
        truncated: read.truncated,
        redacted: read.redacted,
        redactionCategories: read.redactionCategories,
        citation: read.citation,
      });
    }
    return results;
  }
}
