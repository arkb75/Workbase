import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import type {
  RepositoryKnowledgeEvaluationRun,
  RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";

const maximumManifestFiles = 100_000;
const maximumQuotedEvidenceBytes = 512 * 1024;

function slashPath(value: string) {
  return value.split(sep).join("/");
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

/**
 * Expands the compact fixture manifest with the checked-out repository tree.
 * This keeps fixture capability paths representative while allowing any real,
 * branch-produced provenance path to be validated. Contents are loaded only
 * for files carrying quoted evidence, and remain bounded.
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
  const paths = await repositoryPaths(root);
  const quotedPaths = new Set(
    input.run.items.flatMap((item) =>
      item.evidence.flatMap((reference) =>
        reference.quote?.trim() ? [slashPath(reference.path)] : []
      )
    ),
  );
  const files = await Promise.all(paths.map(async (path) => {
    if (!quotedPaths.has(path)) return { path };
    const absolute = resolve(root, path);
    const safeRelative = relative(root, absolute);
    if (safeRelative.startsWith("..") || safeRelative === "") return { path };
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > maximumQuotedEvidenceBytes) return { path };
    return { path, content: await readFile(absolute, "utf8") };
  }));
  return {
    ...input.fixture,
    files,
  } satisfies RepositoryKnowledgeFixture;
}
