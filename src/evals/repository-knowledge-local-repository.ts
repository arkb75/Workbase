import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import type {
  RepositoryKnowledgeEvaluationRun,
  RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";

const maximumManifestFiles = 100_000;
const maximumEvidenceFiles = 2_000;
const maximumEvidenceFileBytes = 512 * 1024;
const maximumEvidenceBytes = 32 * 1024 * 1024;
const maximumGitManifestBytes = 128 * 1024 * 1024;

export function assertCuratedRepositoryRoots(
  fixtures: readonly RepositoryKnowledgeFixture[],
  repositoryRoots: ReadonlyMap<string, string>,
) {
  const missing = fixtures.filter((fixture) =>
    fixture.sourceKind === "curated_real_repository" &&
    !repositoryRoots.has(fixture.id)
  );
  if (missing.length) {
    throw new Error(
      "Curated repository certification requires --repository-root at the exact clean pinned checkout for: " +
      missing.map((fixture) => fixture.id).join(", ") + ".",
    );
  }
}

function gitOutput(
  root: string,
  args: string[],
  maxBuffer = 1024 * 1024,
) {
  return new Promise<string>((resolveOutput, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "utf8", maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `Unable to inspect repository checkout ${root}: ${stderr.trim() || error.message}`,
          ));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function gitBlob(root: string, objectId: string, maximumBytes: number) {
  return new Promise<Buffer>((resolveOutput, reject) => {
    execFile(
      "git",
      ["-C", root, "cat-file", "blob", objectId],
      { encoding: null, maxBuffer: maximumBytes + 1 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `Unable to read pinned repository blob ${objectId}: ${stderr.toString().trim() || error.message}`,
          ));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function slashPath(value: string) {
  return value.split(sep).join("/");
}

async function assertPinnedRepositoryCheckout(
  fixture: RepositoryKnowledgeFixture,
  root: string,
) {
  if (fixture.sourceKind !== "curated_real_repository") return null;
  if (!fixture.snapshotCommit) {
    throw new Error(
      `Curated repository fixture ${fixture.id} has no pinned snapshot commit.`,
    );
  }
  const [checkoutRoot, requestedRoot] = await Promise.all([
    realpath((await gitOutput(root, ["rev-parse", "--show-toplevel"])).trim()),
    realpath(root),
  ]);
  if (checkoutRoot !== requestedRoot) {
    throw new Error(
      `Repository root ${root} resolves to Git checkout ${checkoutRoot}; pass the checkout root itself.`,
    );
  }
  const head = (await gitOutput(root, ["rev-parse", "HEAD"])).trim();
  if (head.toLowerCase() !== fixture.snapshotCommit.toLowerCase()) {
    throw new Error(
      `Repository checkout ${root} is at ${head}, but fixture ${fixture.id} is pinned to ${fixture.snapshotCommit}.`,
    );
  }
  const trackedChanges = await gitOutput(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  if (trackedChanges) {
    throw new Error(
      `Repository checkout ${root} has tracked working-tree changes; use a clean checkout at ${fixture.snapshotCommit}.`,
    );
  }
  return fixture.snapshotCommit;
}

async function repositoryPaths(root: string) {
  const paths: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      paths.push(slashPath(relative(root, absolute)));
      if (paths.length > maximumManifestFiles) {
        throw new Error(
          `Repository ${root} exceeds the ${maximumManifestFiles}-file evaluation manifest limit.`,
        );
      }
    }
  }
  await visit(root);
  return paths;
}

async function pinnedRepositoryEntries(root: string, snapshotCommit: string) {
  const output = await gitOutput(root, [
    "ls-tree",
    "-r",
    "-z",
    "--long",
    snapshotCommit,
  ], maximumGitManifestBytes);
  const entries = output
    ? output.split("\0").filter(Boolean).map((line) => {
        const match = /^(\d+) (blob|commit) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]+)$/u.exec(line);
        if (!match) {
          throw new Error(`Unable to parse pinned Git tree entry: ${line}.`);
        }
        return {
          mode: match[1]!,
          type: match[2]! as "blob" | "commit",
          objectId: match[3]!,
          size: match[4] === "-" ? null : Number(match[4]),
          path: slashPath(match[5]!),
        };
      })
    : [];
  if (entries.length > maximumManifestFiles) {
    throw new Error(
      `Repository ${root} exceeds the ${maximumManifestFiles}-file evaluation manifest limit.`,
    );
  }
  return entries;
}

/**
 * Expands the compact fixture manifest with a local repository tree. Curated
 * fixtures use only the exact pinned commit's tracked paths; synthetic fixtures
 * may use the supplied filesystem tree. Contents are loaded for every cited
 * file so curated scoring can verify claims against source rather than file
 * names. Evidence reads remain bounded.
 */
export async function hydrateRepositoryKnowledgeFixtureFromLocalTree(input: {
  fixture: RepositoryKnowledgeFixture;
  repositoryRoot: string;
  run: RepositoryKnowledgeEvaluationRun;
}) {
  const root = resolve(input.repositoryRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Repository root is not a directory: ${root}.`);
  }
  const pinnedCommit = await assertPinnedRepositoryCheckout(input.fixture, root);
  const pinnedEntries = input.fixture.sourceKind === "curated_real_repository"
    ? await pinnedRepositoryEntries(root, pinnedCommit!)
    : null;
  const paths = pinnedEntries
    ? pinnedEntries.map((entry) => entry.path)
    : await repositoryPaths(root);
  const pinnedEntryByPath = new Map((pinnedEntries ?? []).map((entry) => [
    entry.path,
    entry,
  ]));
  const evidencePaths = new Set(
    input.run.items.flatMap((item) =>
      item.evidence.map((reference) =>
        slashPath(reference.path).replace(/^\.\//u, "")
      )
    ),
  );
  if (evidencePaths.size > maximumEvidenceFiles) {
    throw new Error(
      `Evaluation run ${input.run.fixtureId} cites more than ${maximumEvidenceFiles} distinct files.`,
    );
  }
  const repositoryPathSet = new Set(paths);
  const evidenceContentByPath = new Map<string, string>();
  let totalEvidenceBytes = 0;
  for (const path of evidencePaths) {
    // Missing or untracked paths remain absent from the hydrated manifest and
    // are scored as invalid citations.
    if (!repositoryPathSet.has(path)) continue;
    let size: number;
    let content: Buffer;
    const pinnedEntry = pinnedEntryByPath.get(path);
    if (pinnedEntries) {
      if (!pinnedEntry || pinnedEntry.type !== "blob" || pinnedEntry.size === null) {
        throw new Error(`Cited pinned repository path is not a blob: ${path}.`);
      }
      size = pinnedEntry.size;
      if (size <= maximumEvidenceFileBytes) {
        content = await gitBlob(root, pinnedEntry.objectId, maximumEvidenceFileBytes);
      } else {
        content = Buffer.alloc(0);
      }
    } else {
      const absolute = resolve(root, path);
      const safeRelative = relative(root, absolute);
      if (safeRelative.startsWith("..") || safeRelative === "") continue;
      const info = await lstat(absolute);
      if (!info.isFile()) {
        throw new Error(`Cited repository path is not a regular file: ${path}.`);
      }
      size = info.size;
      content = size <= maximumEvidenceFileBytes
        ? await readFile(absolute)
        : Buffer.alloc(0);
    }
    if (size > maximumEvidenceFileBytes) {
      throw new Error(
        `Cited repository file ${path} exceeds the ${maximumEvidenceFileBytes}-byte verification limit.`,
      );
    }
    totalEvidenceBytes += size;
    if (totalEvidenceBytes > maximumEvidenceBytes) {
      throw new Error(
        `Cited repository content exceeds the ${maximumEvidenceBytes}-byte verification limit.`,
      );
    }
    evidenceContentByPath.set(path, content.toString("utf8"));
  }
  const files = paths.map((path) => evidenceContentByPath.has(path)
    ? { path, content: evidenceContentByPath.get(path)! }
    : { path });
  return {
    ...input.fixture,
    files,
  } satisfies RepositoryKnowledgeFixture;
}
