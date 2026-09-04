import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import sourceAuditFixture from "@/src/evals/fixtures/repository-source-audits-v1.json";
import { repositoryKnowledgeFixtures } from "@/src/evals/repository-knowledge-fixtures";
import { classifyWorkflowFailure } from "@/src/lib/error-message";
import {
  evaluateRepositoryKnowledgeMainPath,
  repositoryKnowledgeModelGenerationKinds,
  type RepositoryKnowledgeExpectedModelIdentity,
} from "@/src/evals/repository-knowledge-main-path";
import { parseRepositorySourceAuditManifest } from "@/src/evals/repository-source-audit";
import { isAllowedInertLiveRunUntrackedPath } from "@/src/evals/repository-source-audit-packet";
import {
  resolveActiveTextModelIdentity,
  resolveWorkbaseLlmProvider,
} from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import {
  fetchGitHubRepositoryDetail,
  mapRepositorySummary,
} from "@/src/services/github-client";
import { knowledgeReconciliationService } from "@/src/services/knowledge-reconciliation-service";
import {
  knowledgeRefreshService,
  resolveRepositoryInvestigationMode,
} from "@/src/services/knowledge-refresh-service";
import { knowledgeStalenessService } from "@/src/services/knowledge-staleness-service";
import { deleteWorkItemForUser } from "@/src/services/work-item-deletion-service";

type Options = {
  cleanupWorkItemIds: string[];
  fixtureIds: string[];
  help: boolean;
  outputPath: string | null;
  userEmail: string | null;
  variant: string | null;
};

type LiveFixtureDescriptor = {
  id: string;
  repository: string;
  snapshotCommit: string;
};

const LIVE_REPAIR_ATTEMPTS = 3;
const LIVE_REPAIR_RETRY_DELAY_MS = 30_000;
const exec = promisify(execFile);

async function gitOutput(root: string, args: readonly string[]) {
  const result = await exec("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function liveImplementationProvenance() {
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repositoryRoot = await gitOutput(scriptRoot, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const [commitSha, trackedStatus, untrackedOutput] = await Promise.all([
    gitOutput(repositoryRoot, ["rev-parse", "HEAD"]),
    gitOutput(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
    ]),
    gitOutput(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(commitSha)) {
    throw new Error("Live evaluation could not resolve an exact implementation commit.");
  }
  if (trackedStatus) {
    throw new Error(
      "Live evaluation requires a clean tracked Workbase checkout so results can be attributed to an exact implementation commit.",
    );
  }
  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean).sort();
  const disallowedUntrackedPaths = untrackedPaths.filter((path) =>
    !isAllowedInertLiveRunUntrackedPath(path)
  );
  if (disallowedUntrackedPaths.length) {
    throw new Error(
      `Live evaluation found untracked executable or configuration inputs outside the inert tooling allowlist: ${disallowedUntrackedPaths.slice(0, 20).join(", ")}${disallowedUntrackedPaths.length > 20 ? ", …" : ""}.`,
    );
  }
  let branch: string | null = null;
  try {
    branch = await gitOutput(repositoryRoot, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    // Detached commits are reproducible and intentionally have no branch name.
  }
  return {
    repositoryRoot,
    commitSha,
    branch: branch || null,
    trackedWorkingTreeClean: true as const,
    untrackedPolicy: "allowlisted_inert_only" as const,
    allowedInertUntrackedPaths: untrackedPaths,
  };
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function repairCoverageWithRetry(input: {
  fixtureId: string;
  refreshRunId: string;
  variant: string;
}) {
  for (let attempt = 1; attempt <= LIVE_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      return await knowledgeRefreshService.repairCoverage(input.refreshRunId);
    } catch (error) {
      const failure = classifyWorkflowFailure(error);
      const refresh = await prisma.knowledgeRefreshRun.findUnique({
        where: { id: input.refreshRunId },
        select: { status: true },
      });
      if (
        !failure.retryable ||
        refresh?.status === "failed" ||
        refresh?.status === "cancelled" ||
        attempt === LIVE_REPAIR_ATTEMPTS
      ) throw error;
      progress(
        `${input.variant}/${input.fixtureId}: transient ${failure.code}; resuming the same refresh after ${LIVE_REPAIR_RETRY_DELAY_MS / 1_000}s (attempt ${attempt + 1}/${LIVE_REPAIR_ATTEMPTS})`,
      );
      await wait(LIVE_REPAIR_RETRY_DELAY_MS);
    }
  }
  throw new Error("Live repository repair exhausted its bounded retry loop.");
}

const legacyLiveFixtures = repositoryKnowledgeFixtures.flatMap<LiveFixtureDescriptor>((fixture) =>
  fixture.sourceKind === "curated_real_repository" &&
      fixture.repository &&
      fixture.snapshotCommit
    ? [{
        id: fixture.id,
        repository: fixture.repository,
        snapshotCommit: fixture.snapshotCommit,
      }]
    : []
);
const auditedLiveFixtures = parseRepositorySourceAuditManifest(sourceAuditFixture)
  .repositories.map((repository) => ({
    id: repository.fixtureId,
    repository: repository.repository,
    snapshotCommit: repository.commitSha,
  }));
const liveFixtures = Array.from(new Map([
  ...legacyLiveFixtures,
  ...auditedLiveFixtures,
].map((fixture) => [fixture.id, fixture])).values()).filter((fixture, index, all) =>
  all.findIndex((candidate) =>
    `${candidate.repository.toLocaleLowerCase()}@${candidate.snapshotCommit.toLocaleLowerCase()}` ===
      `${fixture.repository.toLocaleLowerCase()}@${fixture.snapshotCommit.toLocaleLowerCase()}`
  ) === index
);

function usage() {
  return `Run the production repository-knowledge lifecycle against real fixture repositories.

Usage:
  npm run eval:repository-knowledge:live -- --variant <name> [--fixture <fixture-id> ...] [--user-email <email>] [--output <new-file.json>]
  npm run eval:repository-knowledge:live -- --cleanup-work-item <id> [--cleanup-work-item <id> ...]

Run mode defaults to all real fixtures. WORKBASE_DEMO_USER_EMAIL supplies the
evaluation user unless --user-email is provided. Cleanup accepts only explicit
temporary evaluation work-item IDs. Live comparisons require the real model
extraction and synthesis path; deterministic or mock synthesis is rejected.
The run requires a clean tracked Workbase checkout and records its exact commit.
--output writes the same JSON printed to stdout and refuses to overwrite a file.

Available fixtures:
${liveFixtures.map((fixture) => `  ${fixture.id} (${fixture.repository})`).join("\n")}`;
}

function optionValue(args: string[], index: number, name: string) {
  const argument = args[index]!;
  const inline = argument.startsWith(`${name}=`)
    ? argument.slice(name.length + 1)
    : null;
  const value = inline ?? args[index + 1];
  if (!value?.trim()) throw new Error(`${name} requires a value.`);
  return { consumed: inline === null ? 1 : 0, value: value.trim() };
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    cleanupWorkItemIds: [],
    fixtureIds: [],
    help: false,
    outputPath: null,
    userEmail: null,
    variant: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--variant" || argument.startsWith("--variant=")) {
      const resolved = optionValue(args, index, "--variant");
      options.variant = resolved.value;
      index += resolved.consumed;
      continue;
    }
    if (argument === "--fixture" || argument.startsWith("--fixture=")) {
      const resolved = optionValue(args, index, "--fixture");
      options.fixtureIds.push(resolved.value);
      index += resolved.consumed;
      continue;
    }
    if (argument === "--user-email" || argument.startsWith("--user-email=")) {
      const resolved = optionValue(args, index, "--user-email");
      options.userEmail = resolved.value;
      index += resolved.consumed;
      continue;
    }
    if (argument === "--output" || argument.startsWith("--output=")) {
      const resolved = optionValue(args, index, "--output");
      if (options.outputPath) {
        throw new Error("--output may only be supplied once.");
      }
      options.outputPath = resolve(resolved.value);
      index += resolved.consumed;
      continue;
    }
    if (
      argument === "--cleanup-work-item" ||
      argument.startsWith("--cleanup-work-item=")
    ) {
      const resolved = optionValue(args, index, "--cleanup-work-item");
      options.cleanupWorkItemIds.push(resolved.value);
      index += resolved.consumed;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function progress(message: string) {
  process.stderr.write(`[repository-knowledge-live] ${message}\n`);
}

async function cleanup(workItemIds: string[], userId: string) {
  const uniqueIds = Array.from(new Set(workItemIds));
  const workItems = await prisma.workItem.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, title: true, userId: true },
  });
  const nonEvaluationIds = workItems
    .filter((workItem) => !workItem.title.startsWith("Evaluation · "))
    .map((workItem) => workItem.id);
  if (nonEvaluationIds.length) {
    throw new Error(
      `Refusing to delete non-evaluation work items: ${nonEvaluationIds.join(", ")}`,
    );
  }
  const wrongOwnerIds = workItems
    .filter((workItem) => workItem.userId !== userId)
    .map((workItem) => workItem.id);
  if (wrongOwnerIds.length) {
    throw new Error(
      `Refusing to delete evaluation work items owned by another user: ${wrongOwnerIds.join(", ")}`,
    );
  }
  const foundIds = workItems.map((workItem) => workItem.id);
  const deletedWorkItemIds: string[] = [];
  for (const workItemId of foundIds) {
    const result = await deleteWorkItemForUser({ userId, workItemId });
    if (result.deleted) deletedWorkItemIds.push(workItemId);
  }
  return {
    requestedWorkItemIds: uniqueIds,
    missingWorkItemIds: uniqueIds.filter((id) => !foundIds.includes(id)),
    deletedWorkItemIds,
    deletedCount: deletedWorkItemIds.length,
  };
}

async function runRepository(input: {
  fixtureId: string;
  repositoryFullName: string;
  snapshotCommit: string;
  userId: string;
  variant: string;
  expectedIdentities: Partial<Record<
    (typeof repositoryKnowledgeModelGenerationKinds)[number],
    RepositoryKnowledgeExpectedModelIdentity
  >>;
  expectedAgenticInvestigatorIdentity: RepositoryKnowledgeExpectedModelIdentity;
  expectedSynthesisCriticIdentity: RepositoryKnowledgeExpectedModelIdentity;
}) {
  const startedAt = Date.now();
  progress(`${input.variant}/${input.fixtureId}: resolving repository`);
  const detail = await fetchGitHubRepositoryDetail({
    userId: input.userId,
    repositoryFullName: input.repositoryFullName,
  });
  const repository = mapRepositorySummary(detail.repository);
  const workItem = await prisma.workItem.create({
    data: {
      userId: input.userId,
      title: `Evaluation · ${input.variant} · ${repository.name}`,
      type: "project",
      description: `Temporary generalized repository-knowledge evaluation for ${repository.fullName}.`,
      sources: {
        create: {
          type: "github_repo",
          label: repository.fullName,
          externalId: repository.id,
          metadata: {
            status: "imported",
            repository: {
              id: repository.id,
              fullName: repository.fullName,
              owner: repository.owner,
              name: repository.name,
              description: repository.description,
              url: repository.url,
              defaultBranch: repository.defaultBranch,
              targetRef: input.snapshotCommit,
              private: repository.private,
              updatedAt: repository.updatedAt,
            },
          },
        },
      },
    },
  });

  let refreshRunId: string | null = null;
  try {
    const refresh = await knowledgeRefreshService.start({
      userId: input.userId,
      workItemId: workItem.id,
      trigger: "backfill",
      idempotencyKey: `repository-knowledge-live:${input.variant}:${input.fixtureId}:${randomUUID()}`,
    });
    refreshRunId = refresh.runId;
    if (
      refresh.targets.length !== 1 ||
      refresh.targets[0]?.commitSha.toLocaleLowerCase() !== input.snapshotCommit.toLocaleLowerCase()
    ) {
      throw new Error(
        `Live fixture ${input.fixtureId} resolved ${refresh.targets[0]?.commitSha ?? "no commit"}; expected pinned commit ${input.snapshotCommit}.`,
      );
    }
    if (refresh.status !== "completed") {
      progress(`${input.variant}/${input.fixtureId}: inventorying (${refreshRunId})`);
      await knowledgeRefreshService.inventory(refreshRunId);
      let remaining = 1;
      let chunkCount = 0;
      while (remaining > 0) {
        const chunk = await knowledgeRefreshService.analyzeChunk({
          runId: refreshRunId,
          batchSize: 128,
          maxBatches: 1,
        });
        remaining = chunk.remaining;
        chunkCount += 1;
        progress(
          `${input.variant}/${input.fixtureId}: static chunk ${chunkCount}, ${remaining} remaining`,
        );
        if (remaining > 0 && chunk.analyzed === 0) {
          throw new Error("Static analysis made no progress while files remained.");
        }
      }
      progress(`${input.variant}/${input.fixtureId}: repairing and finalizing coverage`);
      await repairCoverageWithRetry({
        fixtureId: input.fixtureId,
        refreshRunId,
        variant: input.variant,
      });
      await knowledgeRefreshService.finalizeCoverage(refreshRunId);
      progress(`${input.variant}/${input.fixtureId}: reconciling generated knowledge`);
      const reconciled = await knowledgeReconciliationService.reconcile(refreshRunId);
      await knowledgeStalenessService.reconcile({
        runId: refreshRunId,
        appliedFactIds: reconciled.appliedFactIds,
        appliedHighlightIds: reconciled.appliedHighlightIds,
      });
      await knowledgeRefreshService.complete(refreshRunId, {
        appliedFactCount: reconciled.appliedFactIds.length,
        appliedHighlightCount: reconciled.appliedHighlightIds.length,
        promotedEvidenceCount: reconciled.promotedEvidenceIds.length,
      });
    }
    const completed = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
      where: { id: refreshRunId },
      select: {
        status: true,
        qualityStatus: true,
        coverage: true,
        orchestration: true,
        budgetUsage: true,
        warnings: true,
        startedAt: true,
        finishedAt: true,
      },
    });
    if (!completed.startedAt) {
      throw new Error("Completed repository refresh has no generation start time.");
    }
    const generationStartedAt = completed.startedAt;
    const [counts, generationRuns] = await Promise.all([
      prisma.workItem.findUniqueOrThrow({
        where: { id: workItem.id },
        select: {
          _count: {
            select: {
              highlights: true,
              projectFacts: true,
              evidenceItems: true,
            },
          },
        },
      }),
      prisma.generationRun.findMany({
        where: {
          workItemId: workItem.id,
          kind: { in: [...repositoryKnowledgeModelGenerationKinds] },
          createdAt: {
            gte: generationStartedAt,
            ...(completed.finishedAt ? { lte: completed.finishedAt } : {}),
          },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          kind: true,
          status: true,
          provider: true,
          modelId: true,
          inputSummary: true,
          parsedOutput: true,
          resultRefs: true,
          tokenUsage: true,
        },
      }),
    ]);
    const mainPathIntegrity = evaluateRepositoryKnowledgeMainPath({
      generationRuns,
      expectedIdentities: input.expectedIdentities,
      expectedAgenticInvestigatorIdentity: input.expectedAgenticInvestigatorIdentity,
      expectedSynthesisCriticIdentity: input.expectedSynthesisCriticIdentity,
      coverage: completed.coverage,
      orchestration: completed.orchestration,
      warnings: completed.warnings,
    });
    return {
      fixtureId: input.fixtureId,
      repository: input.repositoryFullName,
      workItemId: workItem.id,
      refreshRunId,
      elapsedMs: Date.now() - startedAt,
      counts: counts._count,
      ...completed,
      mainPathIntegrity,
    };
  } catch (error) {
    if (refreshRunId) {
      await knowledgeRefreshService.fail(refreshRunId, error).catch(() => undefined);
    }
    return {
      fixtureId: input.fixtureId,
      repository: input.repositoryFullName,
      workItemId: workItem.id,
      refreshRunId,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.cleanupWorkItemIds.length) {
    if (options.variant || options.fixtureIds.length || options.outputPath) {
      throw new Error("Cleanup mode cannot be combined with run options.");
    }
    const userEmail = options.userEmail ??
      process.env.WORKBASE_DEMO_USER_EMAIL?.trim();
    if (!userEmail) {
      throw new Error("--user-email or WORKBASE_DEMO_USER_EMAIL is required for cleanup.");
    }
    const user = await prisma.user.findUnique({
      where: { email: userEmail },
      select: { id: true },
    });
    if (!user) throw new Error(`No evaluation user exists for ${userEmail}.`);
    process.stdout.write(`${JSON.stringify(
      await cleanup(options.cleanupWorkItemIds, user.id),
      null,
      2,
    )}\n`);
    return;
  }
  if (!options.variant || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(options.variant)) {
    throw new Error("--variant is required and must be a short slug.");
  }
  const synthesisMode = process.env.WORKBASE_REPOSITORY_SYNTHESIS_MODE?.trim() || "model";
  if (synthesisMode !== "model") {
    throw new Error(
      "Live repository-knowledge evaluation requires WORKBASE_REPOSITORY_SYNTHESIS_MODE=model.",
    );
  }
  const investigationMode = resolveRepositoryInvestigationMode();
  const plannerMode = process.env.WORKBASE_SEMANTIC_PLANNER_MODE?.trim() || "model";
  if (investigationMode === "orchestrated" && plannerMode !== "model") {
    throw new Error(
      "Live orchestrated repository-knowledge evaluation requires WORKBASE_SEMANTIC_PLANNER_MODE=model.",
    );
  }
  if (resolveWorkbaseLlmProvider() === "mock") {
    throw new Error("Live repository-knowledge evaluation requires a real model provider.");
  }
  const expectedIdentities = {
    execution_routing: resolveActiveTextModelIdentity("routing"),
    semantic_extraction: resolveActiveTextModelIdentity("code_extraction"),
    semantic_repair: resolveActiveTextModelIdentity("code_extraction"),
    capability_synthesis: resolveActiveTextModelIdentity("deep_synthesis"),
    coverage_audit: resolveActiveTextModelIdentity("verification"),
  };
  const expectedAgenticInvestigatorIdentity = resolveActiveTextModelIdentity("primary_answer");
  const expectedSynthesisCriticIdentity = resolveActiveTextModelIdentity("verification");
  const requestedFixtureIds = Array.from(new Set(options.fixtureIds));
  const unknownFixtureIds = requestedFixtureIds.filter((fixtureId) =>
    !liveFixtures.some((fixture) => fixture.id === fixtureId)
  );
  if (unknownFixtureIds.length) {
    throw new Error(`Unknown live fixture IDs: ${unknownFixtureIds.join(", ")}`);
  }
  const selectedFixtures = requestedFixtureIds.length
    ? liveFixtures.filter((fixture) => requestedFixtureIds.includes(fixture.id))
    : liveFixtures;
  const userEmail = options.userEmail ?? process.env.WORKBASE_DEMO_USER_EMAIL?.trim();
  if (!userEmail) {
    throw new Error("--user-email or WORKBASE_DEMO_USER_EMAIL is required.");
  }
  const user = await prisma.user.findUnique({
    where: { email: userEmail },
    select: { id: true, githubConnection: { select: { id: true } } },
  });
  if (!user?.githubConnection) {
    throw new Error("The evaluation user must have a GitHub connection.");
  }

  const implementation = await liveImplementationProvenance();
  const runStartedAt = new Date().toISOString();
  const results = [];
  for (const fixture of selectedFixtures) {
    results.push(await runRepository({
      fixtureId: fixture.id,
      repositoryFullName: fixture.repository,
      snapshotCommit: fixture.snapshotCommit,
      userId: user.id,
      variant: options.variant,
      expectedIdentities,
      expectedAgenticInvestigatorIdentity,
      expectedSynthesisCriticIdentity,
    }));
  }
  const artifact = {
    schemaVersion: "repository-knowledge-live-run-v3",
    variant: options.variant,
    runStartedAt,
    runFinishedAt: new Date().toISOString(),
    implementation,
    fixtures: selectedFixtures,
    results,
  } as const;
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (options.outputPath) {
    await writeFile(options.outputPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  process.stdout.write(serialized);
  if (results.some((result) =>
    "error" in result ||
    ("mainPathIntegrity" in result && !result.mainPathIntegrity.passed)
  )) process.exitCode = 1;
}

const executablePath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (executablePath === import.meta.url) {
  main()
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
