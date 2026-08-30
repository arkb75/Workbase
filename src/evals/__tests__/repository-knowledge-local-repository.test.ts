import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { repositoryKnowledgeFixture } from "@/src/evals/repository-knowledge-fixtures";
import {
  assertCuratedRepositoryRoots,
  hydrateRepositoryKnowledgeFixtureFromLocalTree,
} from "@/src/evals/repository-knowledge-local-repository";
import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryKnowledgeEvaluationRun,
  type RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];

async function git(root: string, ...args: string[]) {
  const result = await execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "repository-knowledge-local-"));
  temporaryRoots.push(root);
  await git(root, "init");
  await writeFile(join(root, "tracked.ts"), "export const pinned = true;\n");
  await git(root, "add", "tracked.ts");
  await git(
    root,
    "-c",
    "user.name=Repository Knowledge Test",
    "-c",
    "user.email=repository-knowledge@example.test",
    "commit",
    "-m",
    "pinned snapshot",
  );
  return { root, commit: await git(root, "rev-parse", "HEAD") };
}

function fixtureAt(snapshotCommit: string): RepositoryKnowledgeFixture {
  return {
    ...repositoryKnowledgeFixture("backer-marketplace")!,
    snapshotCommit,
  };
}

function emptyRun(
  fixture: RepositoryKnowledgeFixture,
): RepositoryKnowledgeEvaluationRun {
  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: fixture.id,
    repository: fixture.repository,
    commitSha: fixture.snapshotCommit,
    items: [],
    inventory: {
      scannableFiles: 0,
      analyzedFiles: 0,
      semanticAnalyzedFiles: 0,
    },
    coverage: { static: null, semantic: null, knowledge: null },
    performance: {
      durationMs: null,
      modelCalls: null,
      totalTokens: null,
      estimatedCostUsd: null,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
    })),
  );
});

describe("local repository fixture hydration", () => {
  it("requires a local root for every curated fixture selected for certification", () => {
    const curated = fixtureAt("a".repeat(40));
    const synthetic: RepositoryKnowledgeFixture = {
      ...curated,
      id: "synthetic-fixture",
      sourceKind: "synthetic_archetype",
      repository: null,
      snapshotCommit: null,
    };

    expect(() => assertCuratedRepositoryRoots(
      [curated, synthetic],
      new Map(),
    )).toThrow(new RegExp(curated.id, "u"));
    expect(() => assertCuratedRepositoryRoots(
      [curated, synthetic],
      new Map([[curated.id, "/tmp/pinned-checkout"]]),
    )).not.toThrow();
    expect(() => assertCuratedRepositoryRoots(
      [synthetic],
      new Map(),
    )).not.toThrow();
  });

  it("hydrates an exact pinned checkout without admitting untracked files", async () => {
    const { root, commit } = await createRepository();
    await writeFile(join(root, "untracked.md"), "not part of the pinned tree\n");
    const fixture = fixtureAt(commit);

    const hydrated = await hydrateRepositoryKnowledgeFixtureFromLocalTree({
      fixture,
      repositoryRoot: root,
      run: emptyRun(fixture),
    });

    expect(hydrated.files.map((file) => file.path)).toContain("tracked.ts");
    expect(hydrated.files.map((file) => file.path)).not.toContain("untracked.md");
  });

  it("loads checked-out content for quote-less cited files", async () => {
    const { root, commit } = await createRepository();
    const fixture = fixtureAt(commit);
    const run = emptyRun(fixture);
    run.items = [{
      id: "quote-less-evidence",
      kind: "fact",
      text: "Exports a pinned flag.",
      claimState: "implemented",
      evidence: [{ path: "tracked.ts", lineStart: 1, lineEnd: 1 }],
    }];

    const hydrated = await hydrateRepositoryKnowledgeFixtureFromLocalTree({
      fixture,
      repositoryRoot: root,
      run,
    });

    expect(hydrated.files.find((file) => file.path === "tracked.ts")?.content)
      .toBe("export const pinned = true;\n");
  });

  it("grounds curated evidence from HEAD even when index flags hide worktree drift", async () => {
    const { root, commit } = await createRepository();
    await git(root, "update-index", "--assume-unchanged", "tracked.ts");
    await writeFile(join(root, "tracked.ts"), "export const forged = true;\n");
    const fixture = fixtureAt(commit);
    const run = emptyRun(fixture);
    run.items = [{
      id: "pinned-blob-evidence",
      kind: "fact",
      text: "Exports a pinned flag.",
      claimState: "implemented",
      evidence: [{ path: "tracked.ts", lineStart: 1, lineEnd: 1 }],
    }];

    const hydrated = await hydrateRepositoryKnowledgeFixtureFromLocalTree({
      fixture,
      repositoryRoot: root,
      run,
    });

    expect(hydrated.files.find((file) => file.path === "tracked.ts")?.content)
      .toBe("export const pinned = true;\n");
  });

  it("hydrates Git paths without quoted-path escaping", async () => {
    const { root } = await createRepository();
    const unicodePath = "résumé-数据.ts";
    await writeFile(join(root, unicodePath), "export const localized = true;\n");
    await git(root, "add", "--", unicodePath);
    await git(
      root,
      "-c",
      "user.name=Repository Knowledge Test",
      "-c",
      "user.email=repository-knowledge@example.test",
      "commit",
      "-m",
      "unicode path",
    );
    const fixture = fixtureAt(await git(root, "rev-parse", "HEAD"));

    const hydrated = await hydrateRepositoryKnowledgeFixtureFromLocalTree({
      fixture,
      repositoryRoot: root,
      run: emptyRun(fixture),
    });

    expect(hydrated.files.map((file) => file.path)).toContain(unicodePath);
  });

  it("fails closed when checkout HEAD differs from the fixture snapshot", async () => {
    const { root, commit } = await createRepository();
    await writeFile(join(root, "tracked.ts"), "export const pinned = false;\n");
    await git(root, "add", "tracked.ts");
    await git(
      root,
      "-c",
      "user.name=Repository Knowledge Test",
      "-c",
      "user.email=repository-knowledge@example.test",
      "commit",
      "-m",
      "later snapshot",
    );
    const fixture = fixtureAt(commit);

    await expect(hydrateRepositoryKnowledgeFixtureFromLocalTree({
      fixture,
      repositoryRoot: root,
      run: emptyRun(fixture),
    })).rejects.toThrow(/is at .* but fixture .* is pinned to/iu);
  });

  it("fails closed on tracked working-tree drift at the pinned commit", async () => {
    const { root, commit } = await createRepository();
    await writeFile(join(root, "tracked.ts"), "export const drifted = true;\n");
    const fixture = fixtureAt(commit);

    await expect(hydrateRepositoryKnowledgeFixtureFromLocalTree({
      fixture,
      repositoryRoot: root,
      run: emptyRun(fixture),
    })).rejects.toThrow(/tracked working-tree changes/iu);
  });
});
