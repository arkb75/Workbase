import { readFile } from "node:fs/promises";
import {
  repositoryKnowledgeFixture,
  repositoryKnowledgeFixtures,
} from "@/src/evals/repository-knowledge-fixtures";
import { repositoryKnowledgeObservationFromDatabase } from "@/src/evals/repository-knowledge-database-observation";
import {
  assertCuratedRepositoryRoots,
  hydrateRepositoryKnowledgeFixtureFromLocalTree,
} from "@/src/evals/repository-knowledge-local-repository";
import { parseRepositoryKnowledgeEvaluationRuns } from "@/src/evals/repository-knowledge-observation";
import {
  evaluateRepositoryKnowledgeRun,
  evaluateRepositoryKnowledgeSuite,
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  REPOSITORY_KNOWLEDGE_EVALUATOR_POLICY_VERSION,
  type RepositoryKnowledgeEvaluationRun,
  type RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";

interface CliOptions {
  observationPaths: string[];
  databaseFixtureIds: string[];
  databaseWorkItemIds: Map<string, string>;
  repositoryRoots: Map<string, string>;
  pretty: boolean;
}

function usage() {
  return `Usage:
  npm run eval:repository-knowledge -- --observation <runs.json> --repository-root <curated-fixture-id>=<checkout> [...]
  npm run eval:repository-knowledge -- --from-database-all [--work-item <fixture-id>=<work-item-id> ...] --repository-root <fixture-id>=<checkout> ...
  npm run eval:repository-knowledge -- --from-database <fixture-id> [--work-item <fixture-id>=<work-item-id>] --repository-root <fixture-id>=<checkout> [...]

Inputs may be one observation, an array, or an object with a runs/observations array.
Every selected curated real-repository fixture requires its exact clean pinned checkout.
Synthetic fixtures do not require --repository-root.
Use --compact for stable single-line JSON. The default is pretty JSON.`;
}

function optionValue(args: string[], index: number, option: string) {
  const argument = args[index]!;
  const inline = argument.match(new RegExp(`^${option}=(.+)$`, "u"))?.[1];
  if (inline) return { value: inline, consumed: 0 };
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${option} requires a value.\n\n${usage()}`);
  }
  return { value: next, consumed: 1 };
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    observationPaths: [],
    databaseFixtureIds: [],
    databaseWorkItemIds: new Map(),
    repositoryRoots: new Map(),
    pretty: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--compact") {
      options.pretty = false;
      continue;
    }
    if (argument === "--from-database-all") {
      options.databaseFixtureIds.push(
        ...repositoryKnowledgeFixtures
          .filter((fixture) => fixture.sourceKind === "curated_real_repository")
          .map((fixture) => fixture.id),
      );
      continue;
    }
    if (argument === "--observation" || argument.startsWith("--observation=")) {
      const resolved = optionValue(args, index, "--observation");
      options.observationPaths.push(resolved.value);
      index += resolved.consumed;
      continue;
    }
    if (argument === "--from-database" || argument.startsWith("--from-database=")) {
      const resolved = optionValue(args, index, "--from-database");
      options.databaseFixtureIds.push(resolved.value);
      index += resolved.consumed;
      continue;
    }
    if (argument === "--work-item" || argument.startsWith("--work-item=")) {
      const resolved = optionValue(args, index, "--work-item");
      const delimiter = resolved.value.indexOf("=");
      if (delimiter < 1 || delimiter === resolved.value.length - 1) {
        throw new Error("--work-item must use <fixture-id>=<work-item-id>.");
      }
      options.databaseWorkItemIds.set(
        resolved.value.slice(0, delimiter),
        resolved.value.slice(delimiter + 1),
      );
      index += resolved.consumed;
      continue;
    }
    if (argument === "--repository-root" || argument.startsWith("--repository-root=")) {
      const resolved = optionValue(args, index, "--repository-root");
      const delimiter = resolved.value.indexOf("=");
      if (delimiter < 1 || delimiter === resolved.value.length - 1) {
        throw new Error("--repository-root must use <fixture-id>=<checkout-path>.");
      }
      options.repositoryRoots.set(
        resolved.value.slice(0, delimiter),
        resolved.value.slice(delimiter + 1),
      );
      index += resolved.consumed;
      continue;
    }
    throw new Error(`Unknown repository evaluation option: ${argument}.\n\n${usage()}`);
  }
  if (!options.observationPaths.length && !options.databaseFixtureIds.length) {
    throw new Error(`Supply --observation or --from-database.\n\n${usage()}`);
  }
  const databaseFixtureIds = new Set(options.databaseFixtureIds);
  const unselectedWorkItemFixtures = Array.from(
    options.databaseWorkItemIds.keys(),
  ).filter((fixtureId) => !databaseFixtureIds.has(fixtureId));
  if (unselectedWorkItemFixtures.length) {
    throw new Error(
      `--work-item requires a matching --from-database fixture: ${unselectedWorkItemFixtures.join(", ")}.`,
    );
  }
  return options;
}

async function loadObservations(options: CliOptions) {
  const serialized = await Promise.all(options.observationPaths.map(async (path) =>
    parseRepositoryKnowledgeEvaluationRuns(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    )
  ));
  const database = await Promise.all(
    Array.from(new Set(options.databaseFixtureIds)).map(async (fixtureId) => {
      const fixture = repositoryKnowledgeFixture(fixtureId);
      if (!fixture) throw new Error(`Unknown repository fixture: ${fixtureId}.`);
      return repositoryKnowledgeObservationFromDatabase(fixture, {
        workItemId: options.databaseWorkItemIds.get(fixtureId),
      });
    }),
  );
  const observations = [...serialized.flat(), ...database];
  const duplicateIds = observations.flatMap((observation, index) =>
    observations.findIndex((candidate) => candidate.fixtureId === observation.fixtureId) === index
      ? []
      : [observation.fixtureId]
  );
  if (duplicateIds.length) {
    throw new Error(
      `Only one observation is allowed per fixture: ${Array.from(new Set(duplicateIds)).join(", ")}.`,
    );
  }
  return observations;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const observations = await loadObservations(options);
  const baseFixtures = observations.map((observation) => {
    const fixture = repositoryKnowledgeFixture(observation.fixtureId);
    if (!fixture) {
      throw new Error(`Unknown repository fixture: ${observation.fixtureId}.`);
    }
    return fixture;
  });
  assertCuratedRepositoryRoots(baseFixtures, options.repositoryRoots);
  const fixtures: RepositoryKnowledgeFixture[] = await Promise.all(
    baseFixtures.map(async (fixture, index) => {
      const repositoryRoot = options.repositoryRoots.get(fixture.id);
      if (!repositoryRoot) return fixture;
      return hydrateRepositoryKnowledgeFixtureFromLocalTree({
        fixture,
        repositoryRoot,
        run: observations[index]!,
      });
    }),
  );
  const results = fixtures.map((fixture, index) =>
    evaluateRepositoryKnowledgeRun({ fixture, run: observations[index]! })
  );
  const aggregate = evaluateRepositoryKnowledgeSuite({ fixtures, runs: observations });
  const output = {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    evaluatorPolicyVersion: REPOSITORY_KNOWLEDGE_EVALUATOR_POLICY_VERSION,
    profiles: fixtures.map((fixture) => ({
      fixtureId: fixture.id,
      repository: fixture.repository,
      archetype: fixture.archetype,
      languages: fixture.languages,
      sourceKind: fixture.sourceKind,
      fixtureSnapshotCommit: fixture.snapshotCommit,
      evaluatedCommit: observations.find((run) => run.fixtureId === fixture.id)?.commitSha ?? null,
      databaseWorkItemIdUsed: options.databaseWorkItemIds.get(fixture.id) ?? null,
      localRepositoryRootUsed: options.repositoryRoots.has(fixture.id),
    })),
    observations: observations satisfies RepositoryKnowledgeEvaluationRun[],
    reports: results,
    aggregate,
  };
  process.stdout.write(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
