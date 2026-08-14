import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Prisma } from "../src/generated/prisma/client";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { ensureDemoUser } from "../src/lib/demo-user";
import {
  resolveActiveTextModelIdentity,
  textModelProfiles,
} from "../src/lib/llm-config";
import { prisma } from "../src/lib/prisma";
import {
  executeProjectChatApplicationTurn,
  projectChatApplicationExecutionMode,
  projectChatTurnWorkflowReference,
} from "../src/evals/project-chat-application-execution";
import {
  calculateApplicationModelMetrics,
  collectReferencedGenerationRunIds,
  selectScenarioGenerationRuns,
} from "../src/evals/project-chat-application-metrics";
import {
  type ProjectChatApplicationDriver,
  type ProjectChatApplicationMetrics,
  type ProjectChatApplicationObservation,
  type ProjectChatApplicationOutcome,
  type ProjectChatApplicationScenario,
  runProjectChatApplicationScenarios,
} from "../src/evals/project-chat-application-runner";
import {
  parseProjectChatApplicationCliOptions,
  type ProjectChatApplicationCliOptions,
} from "../src/evals/project-chat-application-cli";
import {
  buildRepositoryAccomplishmentsReport,
  buildRepositoryAccomplishmentsScenarioCatalog,
  parseRepositoryAccomplishmentsProfile,
  resolveExactRepositoryAccomplishmentsTarget,
  type ExactRepositoryAccomplishmentsTarget,
  type RepositoryAccomplishmentsProfile,
} from "../src/evals/repository-accomplishments-quality";
import {
  buildLongThreadEvaluationCitationRows,
  currentRunGroundedComparisonEvaluationFacts,
  groundedComparisonEvaluationFixtureForScenario,
  longThreadEvaluationMessageCore,
  projectChatApplicationCleanupTargets,
  projectChatApplicationSandboxIsolationKey,
  type PersistedGroundedComparisonEvaluationFact,
} from "../src/evals/project-chat-application-memory-fixtures";
import {
  completeAgentRun,
  buildRollingConversationSummary,
  createProjectChatRun,
  createProjectChatThread,
  failAgentRun,
  markAgentRunAwaitingReview,
  markAgentRunRunning,
} from "../src/services/project-chat-store";
import { proposeHighlightFromChatContext } from "../src/services/chat-highlight-candidate-service";
import { runProjectChatAgent, type ProjectChatHistoryMessage } from "../src/services/project-chat-agent-service";
import { persistResearchAgentEvent } from "../src/services/research-event-persistence-service";
import { executeArtifactAttempt } from "../src/services/artifact-workflow-service";
import { startAgentRunWorkflowOnce } from "../src/services/agent-run-workflow-start-service";

async function waitForAgentRunTerminal(runId: string, timeoutMs = 10 * 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (
      run &&
      ["completed", "insufficient_context", "failed", "cancelled"].includes(
        run.status,
      )
    ) {
      return run.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Durable application evaluation timed out before AgentRun ${runId} reached a terminal state.`,
  );
}

async function repositoryAccomplishmentsProfile(
  options: ProjectChatApplicationCliOptions,
): Promise<RepositoryAccomplishmentsProfile | null> {
  const requested = Boolean(
    options.accomplishmentsConfig ||
      options.exactWorkItemTitle ||
      options.exactRepository ||
      options.requiredCapabilityPatterns.length ||
      options.forbiddenAnswerPatterns.length ||
      options.includeFreshnessFollowUp !== null ||
      options.minimumPrimaryItems !== null ||
      options.maximumPrimaryItems !== null ||
      options.minimumDevelopedItems !== null ||
      options.minimumCitedItems !== null,
  );
  if (!requested) return null;
  if (options.scenarioIds.length) {
    throw new Error(
      "--scenarios cannot be combined with the repository accomplishments harness; its exact scenario set comes from the profile.",
    );
  }

  let fromConfig: Record<string, unknown> = {};
  if (options.accomplishmentsConfig) {
    const raw = options.accomplishmentsConfig.trim();
    const serialized = raw.startsWith("{")
      ? raw
      : await readFile(resolve(raw), "utf8");
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--accomplishments-config must resolve to a JSON object.");
    }
    fromConfig = parsed as Record<string, unknown>;
  }

  const override = <T>(value: T | null, key: string) =>
    value === null ? {} : { [key]: value };
  return parseRepositoryAccomplishmentsProfile({
    ...fromConfig,
    ...override(options.exactWorkItemTitle, "workItemTitle"),
    ...override(options.exactRepository, "repository"),
    ...(options.requiredCapabilityPatterns.length
      ? { requiredCapabilityPatterns: options.requiredCapabilityPatterns }
      : {}),
    ...(options.forbiddenAnswerPatterns.length
      ? { forbiddenAnswerPatterns: options.forbiddenAnswerPatterns }
      : {}),
    ...override(
      options.includeFreshnessFollowUp,
      "includeFreshnessFollowUp",
    ),
    ...override(options.minimumPrimaryItems, "minimumPrimaryItems"),
    ...override(options.maximumPrimaryItems, "maximumPrimaryItems"),
    ...override(options.minimumDevelopedItems, "minimumDevelopedItems"),
    ...override(options.minimumCitedItems, "minimumCitedItems"),
  });
}

function currentCleanGitCommit() {
  const status = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (status) {
    throw new Error(
      "Repository accomplishments evidence requires a clean Git worktree.",
    );
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("Could not resolve a full Git commit for accomplishments evidence.");
  }
  return commit;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function claimLedgerObservation(value: unknown) {
  const result = record(value);
  const audit = record(result.claimAudit);
  const ledger = record(audit.ledger);
  const entries = Array.isArray(ledger.entries)
    ? ledger.entries.map(record)
    : [];
  const actions = entries.map((entry) => entry.action).filter((action): action is string =>
    typeof action === "string"
  );
  const historyActions = (Array.isArray(audit.verificationHistory)
    ? audit.verificationHistory.map(record)
    : []).flatMap((historyEntry) => {
      const historyLedger = record(historyEntry.ledger);
      return Array.isArray(historyLedger.entries)
        ? historyLedger.entries.map(record).map((entry) => entry.action)
            .filter((action): action is string => typeof action === "string")
        : [];
    });
  const publicationOutcome: "answered" | "answered_with_gaps" | null =
    result.publicationOutcome === "answered" ||
      result.publicationOutcome === "answered_with_gaps"
    ? result.publicationOutcome
    : null;
  if (!entries.length && !publicationOutcome) {
    return { publicationOutcome: null, claimLedger: null };
  }
  return {
    publicationOutcome,
    claimLedger: {
      version: typeof ledger.version === "string" ? ledger.version : "missing",
      entryCount: entries.length,
      keptCount: actions.filter((action) => action.startsWith("keep_")).length,
      qualifiedCount: historyActions.filter((action) => action === "qualify").length,
      researchCount: historyActions.filter((action) => action === "research").length,
      removedCount: historyActions.filter((action) => action.startsWith("remove_")).length,
    },
  };
}

function researchUsage(value: unknown) {
  const root = record(value);
  const usage = record(root.usage);
  return {
    treeLookups: typeof usage.treeLookups === "number" ? usage.treeLookups : 0,
    searches: typeof usage.searches === "number" ? usage.searches : 0,
    fileReads: typeof usage.fileReads === "number" ? usage.fileReads : 0,
    visibleBytes: typeof usage.visibleBytes === "number" ? usage.visibleBytes : 0,
  };
}

function researchCoverageGaps(result: unknown, researchState: unknown) {
  return Array.from(new Set([
    ...stringArray(record(result).coverageGaps),
    ...stringArray(record(researchState).coverageGaps),
  ]));
}

function knowledgeRefreshHeads(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const head = record(entry);
        return typeof head.sourceId === "string" &&
            typeof head.repository === "string" &&
            typeof head.commitSha === "string"
          ? [{
              sourceId: head.sourceId,
              repository: head.repository,
              commitSha: head.commitSha,
            }]
          : [];
      })
    : [];
}

function knowledgeRefreshCoverageGapCount(value: unknown) {
  if (!Array.isArray(value)) return 0;
  return new Set(value.flatMap((entry) =>
    stringArray(record(entry).coverageGaps)
  )).size;
}

interface RepositoryCitationTargetHead {
  sourceId: string;
  repository: string;
  commitSha: string;
}

interface RepositoryValidatedCitationEntity {
  validatedThroughSha: string | null;
  validationHeads: unknown;
  evidence: Array<{
    evidenceItem: {
      sourceId: string;
      type: string;
      source: { type: string };
    };
  }>;
}

function nestedString(value: unknown, path: readonly string[]) {
  let current: unknown = value;
  for (const key of path) current = record(current)[key];
  return typeof current === "string" && current.trim()
    ? current.trim()
    : null;
}

function repositoryCitationTargetHeads(
  sources: Array<{ id: string; metadata: unknown }>,
): RepositoryCitationTargetHead[] {
  return sources.flatMap((source) => {
    const repository = nestedString(source.metadata, ["repository", "fullName"]);
    const commitSha = nestedString(source.metadata, ["revision", "commitSha"])
      ?? nestedString(source.metadata, ["commitSha"]);
    return repository && commitSha
      ? [{ sourceId: source.id, repository, commitSha: commitSha.toLowerCase() }]
      : [];
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function repositoryValidatedCitationState(
  entity: RepositoryValidatedCitationEntity,
  targetHeads: RepositoryCitationTargetHead[],
) {
  const targetBySource = new Map(
    targetHeads.map((target) => [target.sourceId, target.commitSha]),
  );
  const validationHeads = record(entity.validationHeads);
  const recordedHeads = Object.entries(validationHeads).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && Boolean(entry[1]),
  );
  const repositorySourceIds = Array.from(new Set(entity.evidence.flatMap(
    ({ evidenceItem }) =>
      evidenceItem.source.type === "github_repo" ||
          evidenceItem.type.startsWith("github_")
        ? [evidenceItem.sourceId]
        : [],
  )));
  const repositoryDerived = Boolean(
    recordedHeads.length ||
      repositorySourceIds.length ||
      entity.validatedThroughSha,
  );
  if (!repositoryDerived) return { repositoryDerived: false, current: false };
  if (recordedHeads.length) {
    return {
      repositoryDerived: true,
      current: recordedHeads.every(([sourceId, commitSha]) =>
        targetBySource.get(sourceId) === commitSha.toLowerCase()
      ),
    };
  }
  if (!entity.validatedThroughSha) {
    return { repositoryDerived: true, current: false };
  }
  const validatedThroughSha = entity.validatedThroughSha.toLowerCase();
  return {
    repositoryDerived: true,
    current: repositorySourceIds.length
      ? repositorySourceIds.every(
          (sourceId) => targetBySource.get(sourceId) === validatedThroughSha,
        )
      : targetHeads.length === 1 &&
        targetHeads[0]?.commitSha === validatedThroughSha,
  };
}

function repositoryCitationFreshness(input: {
  targetHeads: RepositoryCitationTargetHead[];
  citations: Array<{
    ordinal: number;
    kind: string;
    repository: string | null;
    commitSha: string | null;
    metadata: unknown;
    highlight: RepositoryValidatedCitationEntity | null;
    projectFact: RepositoryValidatedCitationEntity | null;
    evidenceItem: {
      sourceId: string;
      type: string;
      validatedThroughSha: string | null;
      metadata: unknown;
      source: { type: string };
    } | null;
  }>;
}) {
  const targetBySource = new Map(
    input.targetHeads.map((target) => [target.sourceId, target.commitSha]),
  );
  const targetByRepository = new Map(
    input.targetHeads.map((target) => [
      target.repository.toLowerCase(),
      target.commitSha,
    ]),
  );
  const statuses = input.citations.flatMap((citation) => {
    const entity = citation.highlight ?? citation.projectFact;
    if (entity) {
      const status = repositoryValidatedCitationState(entity, input.targetHeads);
      if (status.repositoryDerived) return [{ ordinal: citation.ordinal, ...status }];
    }
    if (
      citation.evidenceItem &&
      (citation.evidenceItem.source.type === "github_repo" ||
        citation.evidenceItem.type.startsWith("github_"))
    ) {
      const commitSha = citation.evidenceItem.validatedThroughSha
        ?? nestedString(citation.evidenceItem.metadata, ["commitSha"]);
      return [{
        ordinal: citation.ordinal,
        repositoryDerived: true,
        current: Boolean(
          commitSha &&
            targetBySource.get(citation.evidenceItem.sourceId) ===
              commitSha.toLowerCase(),
        ),
      }];
    }
    if (citation.repository || citation.kind === "github_file") {
      return [{
        ordinal: citation.ordinal,
        repositoryDerived: true,
        current: Boolean(
          citation.repository &&
            citation.commitSha &&
            targetByRepository.get(citation.repository.toLowerCase()) ===
              citation.commitSha.toLowerCase(),
        ),
      }];
    }
    const provenance = Array.isArray(record(citation.metadata).provenance)
      ? record(citation.metadata).provenance as unknown[]
      : [];
    const repositoryCoordinates = provenance.flatMap((entry) => {
      const repository = nestedString(entry, ["repository"]);
      const commitSha = nestedString(entry, ["commitSha"]);
      return repository && commitSha ? [{ repository, commitSha }] : [];
    });
    return repositoryCoordinates.length
      ? [{
          ordinal: citation.ordinal,
          repositoryDerived: true,
          current: repositoryCoordinates.every(({ repository, commitSha }) =>
            targetByRepository.get(repository.toLowerCase()) ===
              commitSha.toLowerCase()
          ),
        }]
      : [];
  });
  return {
    targetHeads: input.targetHeads,
    repositoryDerivedCitationCount: statuses.length,
    currentRepositoryDerivedCitationCount: statuses.filter(
      (status) => status.current,
    ).length,
    staleCitationOrdinals: statuses
      .filter((status) => !status.current)
      .map((status) => status.ordinal)
      .sort((left, right) => left - right),
  };
}

function applicationOutcomeFromAgentRunStatus(
  status: string,
): ProjectChatApplicationOutcome {
  if (status === "completed") return "answered";
  if (status === "awaiting_review") return "awaiting_review";
  if (status === "insufficient_context") return "insufficient_context";
  return "failed";
}

class PrismaProjectChatApplicationDriver implements ProjectChatApplicationDriver {
  private readonly threads = new Map<string, { id: string; workItemId: string }>();
  private readonly createdThreadIds = new Set<string>();
  private readonly createdRunIds = new Set<string>();
  private readonly sandboxWorkItemIds = new Set<string>();
  private readonly workspaces = new Map<string, string>();
  private readonly groundedComparisonFixtures = new Map<
    string,
    PersistedGroundedComparisonEvaluationFact[]
  >();

  constructor(
    private readonly input: {
      userId: string;
      mainWorkItemId: string;
      provider: "mock" | "bedrock" | "openrouter";
      keepData: boolean;
    },
  ) {}

  private async createSandbox(withRepository: boolean, isolationKey?: string) {
    const workspace = withRepository ? "attached_repository_sandbox" : "empty_sandbox";
    const key = isolationKey ? `${workspace}:${isolationKey}` : workspace;
    const existing = this.workspaces.get(key);
    if (existing) return existing;
    const main = await prisma.workItem.findFirstOrThrow({
      where: { id: this.input.mainWorkItemId, userId: this.input.userId },
      include: {
        sources: {
          where: { type: "github_repo" },
          orderBy: { updatedAt: "desc" },
          take: withRepository ? 1 : 0,
        },
      },
    });
    const sandbox = await prisma.workItem.create({
      data: {
        userId: this.input.userId,
        title: `Project chat application eval ${key} ${randomUUID().slice(0, 8)}`,
        type: main.type,
        description: "Ephemeral project-chat application evaluation sandbox.",
        startDate: main.startDate,
        endDate: main.endDate,
      },
    });
    this.sandboxWorkItemIds.add(sandbox.id);
    this.workspaces.set(key, sandbox.id);
    if (withRepository) {
      const source = main.sources[0];
      if (!source) throw new Error("The selected evaluation Work Item has no attached GitHub repository to clone into the sandbox.");
      await prisma.source.create({
        data: {
          workItemId: sandbox.id,
          type: source.type,
          label: source.label,
          externalId: source.externalId,
          rawContent: source.rawContent,
          metadata: source.metadata == null
            ? Prisma.JsonNull
            : source.metadata as Prisma.InputJsonValue,
        },
      });
    }
    return sandbox.id;
  }

  private async workItemIdFor(scenario: ProjectChatApplicationScenario) {
    if (scenario.workspace === "project_memory") return this.input.mainWorkItemId;
    return this.createSandbox(
      scenario.workspace === "attached_repository_sandbox",
      projectChatApplicationSandboxIsolationKey(scenario.id),
    );
  }

  private async seedGroundedComparisonScenario(
    scenario: ProjectChatApplicationScenario,
    workItemId: string,
  ) {
    const fixture = groundedComparisonEvaluationFixtureForScenario(scenario.id);
    if (!fixture) return [];
    const fixtureKey = `${workItemId}:${scenario.id}`;
    const existing = this.groundedComparisonFixtures.get(fixtureKey);
    if (existing) return existing;

    const facts = await prisma.$transaction(async (tx) => {
      const source = await tx.source.create({
        data: {
          workItemId,
          type: "manual_note",
          label: fixture.sourceLabel,
          externalId: `application-eval:${scenario.id}`,
          rawContent: fixture.facts.map((fact) => fact.evidenceContent).join("\n\n"),
          metadata: {
            evaluationScenarioId: scenario.id,
            purpose: "grounded_comparison_fixture",
          },
        },
      });
      const persisted: PersistedGroundedComparisonEvaluationFact[] = [];
      for (const fact of fixture.facts) {
        const evidence = await tx.evidenceItem.create({
          data: {
            workItemId,
            sourceId: source.id,
            externalId: `application-eval:${scenario.id}:${fact.key}`,
            type: "manual_note_excerpt",
            title: fact.evidenceTitle,
            content: fact.evidenceContent,
            searchText: `${fact.statement} ${fact.evidenceContent}`,
            logicalKey: `application-eval:${scenario.id}:${fact.key}`,
            included: true,
            lifecycleStatus: "active",
            reviewState: "reviewed",
            approvalSource: "user",
            publicSafetyStatus: "verified",
            metadata: {
              evaluationScenarioId: scenario.id,
              factKey: fact.key,
            },
          },
        });
        const projectFact = await tx.projectFact.create({
          data: {
            workItemId,
            statement: fact.statement,
            category: fact.category,
            confidence: "high",
            status: "approved",
            sensitivityFlag: false,
            reviewNotes:
              "Reviewed application-evaluation fixture backed by the linked manual-note evidence.",
            searchText: `${fact.statement} ${fact.evidenceContent}`,
            lifecycleStatus: "active",
            reviewState: "reviewed",
            approvalSource: "user",
            publicSafetyStatus: "verified",
            subsystemKey: fact.subsystemKey,
            evidence: {
              create: {
                evidenceItemId: evidence.id,
                relevanceScore: 1,
              },
            },
          },
        });
        persisted.push({
          ...fact,
          id: projectFact.id,
          evidenceItemId: evidence.id,
        });
      }
      return persisted;
    });
    this.groundedComparisonFixtures.set(fixtureKey, facts);
    return facts;
  }

  private async attachGroundedComparisonFactsToRun(
    scenario: ProjectChatApplicationScenario,
    runId: string,
    facts: readonly PersistedGroundedComparisonEvaluationFact[],
  ) {
    const currentRunFacts = currentRunGroundedComparisonEvaluationFacts(
      scenario.id,
      facts,
    );
    if (!currentRunFacts.length) return;
    const reviewedAt = new Date();
    await prisma.agentRunCandidate.createMany({
      data: currentRunFacts.map((fact, index) => ({
        agentRunId: runId,
        projectFactId: fact.id,
        kind: "new_project_fact",
        status: "approved",
        batchNumber: 1,
        ordinal: index + 1,
        reviewedAt,
        snapshot: {
          statement: fact.statement,
          category: fact.category,
          confidence: "high",
          status: "approved",
          evidenceItemIds: [fact.evidenceItemId],
          evaluationFixture: true,
        },
      })),
    });
  }

  private async seedArtifactScenario(
    scenario: ProjectChatApplicationScenario,
    workItemId: string,
    runId: string,
  ) {
    if (scenario.id === "artifact_from_approved_context") {
      const source = await prisma.source.create({
        data: {
          workItemId,
          type: "manual_note",
          label: "Artifact evaluation evidence",
          externalId: `artifact-eval:${randomUUID()}`,
          rawContent: "Built a typed backend orchestration layer with bounded retries and durable progress.",
        },
      });
      const evidence = await prisma.evidenceItem.create({
        data: {
          workItemId,
          sourceId: source.id,
          externalId: `artifact-evidence:${randomUUID()}`,
          type: "manual_note_excerpt",
          title: "Backend orchestration implementation",
          content: "Built a typed backend orchestration layer with bounded retries and durable progress.",
          searchText: "typed backend architecture orchestration bounded retries durable progress",
          included: true,
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "verified",
        },
      });
      await prisma.highlight.create({
        data: {
          workItemId,
          text: "Built a typed backend orchestration layer with bounded retries and durable progress.",
          summary: "The approved source explicitly supports the backend architecture and reliability work.",
          searchText: "typed backend architecture orchestration bounded retries durable progress",
          confidence: "high",
          ownershipClarity: "clear",
          sensitivityFlag: false,
          verificationStatus: "approved",
          visibility: "resume_safe",
          lifecycleStatus: "active",
          reviewState: "reviewed",
          approvalSource: "user",
          publicSafetyStatus: "verified",
          evidence: { create: { evidenceItemId: evidence.id, relevanceScore: 1 } },
          tags: { create: [
            { dimension: "domain", tag: "backend", score: 1 },
            { dimension: "emphasis", tag: "architecture", score: 1 },
          ] },
        },
      });
      return;
    }

    if (scenario.id === "artifact_review_gate") {
      const highlight = await prisma.highlight.create({
        data: {
          workItemId,
          text: "Potential backend architecture accomplishment requiring safety review.",
          summary: "This candidate is deliberately quarantined for the application evaluation.",
          searchText: "backend architecture candidate safety review",
          confidence: "medium",
          ownershipClarity: "unclear",
          sensitivityFlag: false,
          verificationStatus: "flagged",
          visibility: "private",
          lifecycleStatus: "quarantined",
          reviewState: "pending_review",
          approvalSource: "automation",
          publicSafetyStatus: "failed",
        },
      });
      await prisma.agentRunCandidate.create({
        data: {
          agentRunId: runId,
          highlightId: highlight.id,
          kind: "new_highlight",
          status: "pending",
          batchNumber: 1,
          ordinal: 1,
          snapshot: {
            text: highlight.text,
            summary: highlight.summary,
            verificationStatus: highlight.verificationStatus,
          },
        },
      });
    }
  }

  private async threadFor(scenario: ProjectChatApplicationScenario, workItemId: string) {
    const key = `${workItemId}:${scenario.threadKey}`;
    const existing = this.threads.get(key);
    if (existing) return existing;
    const thread = await createProjectChatThread({
      userId: this.input.userId,
      workItemId,
      title: `Application eval · ${scenario.threadKey}`,
    });
    const entry = { id: thread.id, workItemId };
    this.threads.set(key, entry);
    this.createdThreadIds.add(thread.id);
    return entry;
  }

  private async seedLongThreadScenario(
    scenario: ProjectChatApplicationScenario,
    threadId: string,
    facts: readonly PersistedGroundedComparisonEvaluationFact[],
  ) {
    if (scenario.id !== "long_thread_rollover") return;
    const existingCount = await prisma.chatMessage.count({ where: { threadId } });
    if (existingCount) return;
    const messages = Array.from({ length: 16 }, (_, index) => {
      const sequence = index + 1;
      const role = sequence % 2 === 1 ? "user" as const : "assistant" as const;
      const core = longThreadEvaluationMessageCore(sequence, role);
      return {
        threadId,
        sequence,
        role,
        status: "completed" as const,
        content: `${core} ${role === "user" ? "q" : "a"}`.padEnd(4_100, role === "user" ? "q" : "a"),
        finalizedAt: new Date(),
      };
    });
    await prisma.chatMessage.createMany({ data: messages });
    const assistants = await prisma.chatMessage.findMany({
      where: { threadId, role: "assistant" },
      select: { id: true, sequence: true },
      orderBy: { sequence: "asc" },
    });
    const citationRows = buildLongThreadEvaluationCitationRows(assistants, facts);
    await prisma.chatCitation.createMany({ data: citationRows });
    const citationLabelBySequence = new Map(
      assistants.map((message, index) => [
        message.sequence,
        citationRows[index]!.label,
      ]),
    );
    const olderMessages = messages.slice(0, messages.length - 12);
    const rollingSummary = buildRollingConversationSummary(
      olderMessages.map((message) => ({
        id: `seeded-${message.sequence}`,
        role: message.role,
        content: message.content,
        citations: message.role === "assistant"
          ? [{
              kind: "project_fact",
              label: citationLabelBySequence.get(message.sequence)!,
            }]
          : [],
      })),
      6_000,
    );
    await prisma.chatThread.update({
      where: { id: threadId },
      data: {
        rollingSummary,
        conversationState: {
          version: 1,
          olderTurns: olderMessages.map((message) => ({
            role: message.role,
            summary: message.content.slice(0, 800),
          })),
          seededForApplicationEvaluation: true,
        },
      },
    });
  }

  private async turnContext(threadId: string, runId: string): Promise<{
    userMessage: { id: string };
    history: ProjectChatHistoryMessage[];
    rollingSummary: string | null;
  }> {
    // Fetch the current message, prior conversation, citation manifests, and
    // rolling summary together. Besides making the evaluator more faithful to
    // production prompt assembly, this removes two avoidable remote-Postgres
    // round trips from every measured turn.
    const thread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId },
      select: {
        rollingSummary: true,
        messages: {
          where: { status: "completed" },
          orderBy: { sequence: "asc" },
          select: {
            id: true,
            agentRunId: true,
            role: true,
            content: true,
            citations: {
              orderBy: { ordinal: "asc" },
              select: {
                ordinal: true,
                kind: true,
                label: true,
              },
            },
          },
        },
      },
    });
    const userMessage = thread.messages.find(
      (message) => message.agentRunId === runId && message.role === "user",
    );
    if (!userMessage) {
      throw new Error(`Application evaluation could not load the user message for AgentRun ${runId}.`);
    }
    return {
      userMessage: { id: userMessage.id },
      rollingSummary: thread.rollingSummary,
      history: thread.messages
        .filter((message) => message.id !== userMessage.id)
        .map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          citations: message.citations.map((citation) => ({
            ordinal: citation.ordinal,
            kind: citation.kind,
            label: citation.label,
          })),
        })),
    };
  }

  private async persistResult(input: {
    runId: string;
    scenario: ProjectChatApplicationScenario;
    result: Awaited<ReturnType<typeof runProjectChatAgent>>;
  }): Promise<{ outcome: ProjectChatApplicationOutcome; answer: string }> {
    const { result, runId, scenario } = input;
    if (result.status === "artifact_requested") {
      if (["artifact_from_approved_context", "artifact_missing_impact", "artifact_review_gate"].includes(scenario.id)) {
        await prisma.agentRun.update({
          where: { id: runId },
          data: { kind: "artifact_workflow", request: { message: result.brief, brief: result.brief } },
        });
        for (let batchNumber = 1; batchNumber <= 3; batchNumber += 1) {
          const attempt = await executeArtifactAttempt({ runId, batchNumber });
          if (attempt.status === "retry_research") continue;
          if (attempt.status === "completed") {
            const artifact = await prisma.artifact.findUniqueOrThrow({
              where: { id: attempt.artifactId },
              select: { content: true },
            });
            return { outcome: "artifact_completed", answer: artifact.content };
          }
          if (attempt.status === "awaiting_review") {
            return { outcome: "awaiting_review", answer: "Artifact generation is waiting for the quarantined candidate review." };
          }
          return { outcome: "insufficient_context", answer: attempt.message };
        }
        return { outcome: "insufficient_context", answer: "The artifact workflow exhausted its bounded attempts." };
      }
      await prisma.$transaction([
        prisma.agentRun.update({
          where: { id: runId },
          data: { status: "cancelled", finishedAt: new Date(), result: { status: "artifact_requested", brief: result.brief } },
        }),
        prisma.chatMessage.updateMany({
          where: { agentRunId: runId, role: "assistant" },
          data: { status: "cancelled", content: "Artifact workflow route selected for evaluation.", finalizedAt: new Date() },
        }),
      ]);
      return { outcome: "artifact_requested", answer: "Artifact workflow route selected for evaluation." };
    }
    if (result.status === "insufficient_context") {
      await failAgentRun({ runId, message: result.answer, insufficient: true });
      return { outcome: "insufficient_context", answer: result.answer };
    }
    const storedResult = {
      status: result.research.status,
      findings: result.research.findings,
      coverageGaps: result.research.coverageGaps,
      warnings: result.research.warnings,
      partial: result.research.partial,
      exploredEvidenceCount: result.research.exploredEvidence.length,
      generationRunIds: result.research.generationRunIds,
      applicationEvaluation: true,
      fallbackUsed: result.fallbackUsed ?? false,
    };
    if (result.status === "awaiting_review") {
      await markAgentRunAwaitingReview({
        runId,
        content: result.answer,
        result: storedResult,
        citations: result.citations,
        citationPolicy: result.citationPolicy,
        groundedClaims: result.groundedClaims,
        freshness: result.freshness,
      });
      return { outcome: "awaiting_review", answer: result.answer };
    }
    await completeAgentRun({
      runId,
      content: result.answer,
      result: storedResult,
      citations: result.citations,
      citationPolicy: result.citationPolicy,
      groundedClaims: result.groundedClaims,
      freshness: result.freshness,
    });
    return { outcome: "answered", answer: result.answer };
  }

  private async metrics(input: {
    runId: string;
    workItemId: string;
    startedAt: Date;
    finishedAt: Date;
    events: Array<{
      id: string;
      message: string | null;
      toolName?: string | null;
      payload: unknown;
    }>;
    result: unknown;
    researchState: unknown;
    refreshRunId: string | null;
  }): Promise<ProjectChatApplicationMetrics> {
    const candidateGenerationRuns = await prisma.generationRun.findMany({
      where: {
        workItemId: input.workItemId,
        updatedAt: { gte: input.startedAt, lte: input.finishedAt },
      },
      select: {
        id: true,
        status: true,
        provider: true,
        modelId: true,
        idempotencyKey: true,
        tokenUsage: true,
        estimatedCostUsd: true,
        resultRefs: true,
        updatedAt: true,
      },
    });
    const researchRefreshRunId =
      typeof record(input.researchState).refreshRunId === "string"
        ? record(input.researchState).refreshRunId as string
        : null;
    const refreshRunId = input.refreshRunId ?? researchRefreshRunId;
    const generationRuns = selectScenarioGenerationRuns({
      generationRuns: candidateGenerationRuns,
      runId: input.runId,
      refreshRunId,
      referencedGenerationRunIds: collectReferencedGenerationRunIds(
        input.result,
        input.researchState,
      ),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    });
    const dossierModelUsage = record(input.researchState).modelUsage;
    const modelId =
      this.input.provider === "openrouter"
        ? process.env.WORKBASE_OPENROUTER_MODEL_PRIMARY_ANSWER ??
          process.env.WORKBASE_OPENROUTER_MODEL_ID ??
          "openai/gpt-5.6-terra"
        : process.env.WORKBASE_BEDROCK_MODEL_ID ??
          "us.anthropic.claude-sonnet-4-6";
    const modelMetrics = calculateApplicationModelMetrics({
      provider: this.input.provider,
      modelId,
      events: input.events,
      dossierModelUsage,
      generationRuns,
      storedResult: input.result,
      expectedModelIdsByProfile: Object.fromEntries(
        textModelProfiles.map((profile) => [
          profile,
          resolveActiveTextModelIdentity(profile).modelId,
        ]),
      ),
    });
    const repository = researchUsage(input.researchState);
    return {
      latencyMs: input.finishedAt.getTime() - input.startedAt.getTime(),
      ...modelMetrics,
      repositoryTreeLookups: repository.treeLookups,
      repositorySearches: repository.searches,
      repositoryFileReads: repository.fileReads,
      repositoryVisibleBytes: repository.visibleBytes,
    };
  }

  async run(scenario: ProjectChatApplicationScenario): Promise<ProjectChatApplicationObservation> {
    const workItemId = await this.workItemIdFor(scenario);
    const thread = await this.threadFor(scenario, workItemId);
    const groundedComparisonFacts = await this.seedGroundedComparisonScenario(
      scenario,
      workItemId,
    );
    await this.seedLongThreadScenario(
      scenario,
      thread.id,
      groundedComparisonFacts,
    );
    const startedAt = new Date();
    const run = await createProjectChatRun({
      userId: this.input.userId,
      workItemId,
      threadId: thread.id,
      message: scenario.question,
      idempotencyKey: `application-eval:${scenario.id}:${randomUUID()}`,
    });
    this.createdRunIds.add(run.id);
    await this.attachGroundedComparisonFactsToRun(
      scenario,
      run.id,
      groundedComparisonFacts,
    );
    await this.seedArtifactScenario(scenario, workItemId, run.id);
    const { userMessage, history, rollingSummary } = await this.turnContext(thread.id, run.id);
    let outcome: ProjectChatApplicationOutcome = "failed";
    let answer = "";
    let error: string | null = null;
    let directCoverageGaps: string[] = [];
    const executionMode = projectChatApplicationExecutionMode({
      provider: this.input.provider,
      scenario,
    });
    try {
      await executeProjectChatApplicationTurn({
        provider: this.input.provider,
        scenario,
        runInline: async () => {
          await markAgentRunRunning(run.id);
          if (scenario.captureUserContext) {
            await proposeHighlightFromChatContext({
              userId: this.input.userId,
              workItemId,
              threadId: thread.id,
              messageId: userMessage.id,
              agentRunId: run.id,
              text: scenario.question,
            });
          }
          const result = await runProjectChatAgent({
            runId: run.id,
            userId: this.input.userId,
            workItemId,
            threadId: thread.id,
            messageId: userMessage.id,
            question: scenario.question,
            history,
            rollingSummary,
            allowResearch: scenario.allowResearch,
            onAgentEvent: (event) => persistResearchAgentEvent(run.id, event),
          });
          directCoverageGaps = result.status === "artifact_requested" ? [] : result.research.coverageGaps;
          ({ outcome, answer } = await this.persistResult({ runId: run.id, scenario, result }));
          if (scenario.id === "artifact_missing_impact" && outcome === "insufficient_context") {
            directCoverageGaps = [answer];
          }
        },
        startDurable: () => startAgentRunWorkflowOnce({
          runId: run.id,
          startWorkflow: () => start(projectChatTurnWorkflowReference, [run.id]),
        }),
        waitForDurable: async () => {
          // Workbase's AgentRun is the product audit trail and the state the UI
          // consumes. Poll it directly: local Workflow return streams can stay
          // open after the terminal database commit when a dev server reloads.
          await waitForAgentRunTerminal(run.id);
        },
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      answer = error;
      await failAgentRun({ runId: run.id, message: error }).catch(() => null);
    }
    const finishedAt = new Date();
    const [
      storedRun,
      assistantMessage,
      events,
      candidate,
      repositorySources,
    ] = await Promise.all([
      prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
        select: {
          status: true,
          request: true,
          result: true,
          researchState: true,
          knowledgeRefreshRunId: true,
          knowledgeRefreshRun: {
            select: {
              trigger: true,
              status: true,
              qualityStatus: true,
              targetHeads: true,
              completedHeads: true,
              coverage: true,
            },
          },
          artifact: {
            select: {
              lifecycleStatus: true,
              publicSafetyStatus: true,
              _count: { select: { highlightProvenance: true, evidenceProvenance: true } },
            },
          },
        },
      }),
      prisma.chatMessage.findFirstOrThrow({
        where: { agentRunId: run.id, role: "assistant" },
        include: {
          citations: {
            orderBy: { ordinal: "asc" },
            include: {
              highlight: {
                select: {
                  validatedThroughSha: true,
                  validationHeads: true,
                  evidence: {
                    select: {
                      evidenceItem: {
                        select: {
                          sourceId: true,
                          type: true,
                          source: { select: { type: true } },
                        },
                      },
                    },
                  },
                },
              },
              projectFact: {
                select: {
                  validatedThroughSha: true,
                  validationHeads: true,
                  evidence: {
                    select: {
                      evidenceItem: {
                        select: {
                          sourceId: true,
                          type: true,
                          source: { select: { type: true } },
                        },
                      },
                    },
                  },
                },
              },
              evidenceItem: {
                select: {
                  sourceId: true,
                  type: true,
                  validatedThroughSha: true,
                  metadata: true,
                  source: { select: { type: true } },
                },
              },
            },
          },
        },
      }),
      prisma.agentRunEvent.findMany({
        where: { agentRunId: run.id },
        select: {
          id: true,
          type: true,
          toolName: true,
          message: true,
          payload: true,
        },
        orderBy: { sequence: "asc" },
      }),
      prisma.agentRunCandidate.findFirst({
        where: { agentRunId: run.id },
        include: {
          highlight: {
            include: { evidence: { include: { evidenceItem: { select: { type: true } } } } },
          },
        },
        orderBy: [{ batchNumber: "asc" }, { ordinal: "asc" }],
      }),
      prisma.source.findMany({
        where: { workItemId, type: "github_repo" },
        select: { id: true, metadata: true },
        orderBy: { id: "asc" },
      }),
    ]);
    const citationTargetHeads = repositoryCitationTargetHeads(repositorySources);
    const metrics = await this.metrics({
      runId: run.id,
      workItemId,
      startedAt,
      finishedAt,
      events,
      result: storedRun.result,
      researchState: storedRun.researchState,
      refreshRunId: storedRun.knowledgeRefreshRunId,
    });
    if (executionMode === "durable_workflow") {
      outcome = applicationOutcomeFromAgentRunStatus(storedRun.status);
    }
    const compositionEvent = [...events].reverse().find((event) =>
      event.type === "tool_result" && event.toolName === "compose_project_answer"
    );
    const compositionMode = record(compositionEvent?.payload).mode;
    const claimAudit = claimLedgerObservation(storedRun.result);
    return {
      scenarioId: scenario.id,
      runId: run.id,
      threadId: thread.id,
      workItemId,
      executionMode,
      outcome,
      answer: assistantMessage.content || answer,
      citationCount: assistantMessage.citations.length,
      citationKinds: assistantMessage.citations.map((citation) => citation.kind),
      citationOrdinals: Array.from((assistantMessage.content || answer).matchAll(/\[citation:(\d+)\]/gi))
        .map((match) => Number(match[1]))
        .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0),
      citationMetadata: assistantMessage.citations.map((citation) => ({
        ordinal: citation.ordinal,
        type: citation.kind,
        title: citation.label,
        excerpt: citation.excerpt,
        statement: citation.excerpt,
      })),
      tools: events.flatMap((event) => event.type === "tool_call" && event.toolName ? [event.toolName] : []),
      inspectionModes: Array.from(new Set(events.flatMap((event) => {
        if (event.type !== "tool_call" || event.toolName !== "inspect_project") return [];
        const modes = record(event.payload).inspectionModes;
        return Array.isArray(modes)
          ? modes.filter((mode): mode is "knowledge" | "repository" =>
              mode === "knowledge" || mode === "repository"
            )
          : [];
      }))),
      answerCompositionMode:
        typeof compositionMode === "string" ? compositionMode : null,
      publicationOutcome: claimAudit.publicationOutcome,
      claimLedger: claimAudit.claimLedger,
      knowledgeRefreshRunId: storedRun.knowledgeRefreshRunId,
      knowledgeRefresh: storedRun.knowledgeRefreshRun ? {
        trigger: storedRun.knowledgeRefreshRun.trigger,
        status: storedRun.knowledgeRefreshRun.status,
        qualityStatus: storedRun.knowledgeRefreshRun.qualityStatus,
        targetHeads: knowledgeRefreshHeads(
          storedRun.knowledgeRefreshRun.targetHeads,
        ),
        completedHeads: knowledgeRefreshHeads(
          storedRun.knowledgeRefreshRun.completedHeads,
        ),
        coverageGapCount: knowledgeRefreshCoverageGapCount(
          storedRun.knowledgeRefreshRun.coverage,
        ),
      } : null,
      repositoryCitationFreshness: repositoryCitationFreshness({
        targetHeads: citationTargetHeads,
        citations: assistantMessage.citations,
      }),
      historyMessageCount: history.length,
      historyCharacterCount: history.reduce((total, message) => total + message.content.length, 0),
      historyCitationManifestCount: history.reduce((total, message) => total + message.citations.length, 0),
      rollingSummaryCharacterCount: rollingSummary?.length ?? 0,
      rollingSummaryPreservedOpeningDecision:
        /earlier decision under discussion|decision adopted/i.test(rollingSummary ?? ""),
      rollingSummaryPreservedCitationManifest: /used sources:/i.test(rollingSummary ?? ""),
      historyPreservedCurrentRuntimeContext: history.some((message) =>
        /current runtime context|bounded (?:model|provider-neutral) (?:tool )?loop/i.test(message.content)
      ),
      candidate: candidate ? {
        exists: true,
        status: candidate.status,
        kind: candidate.kind,
        highlightLifecycleStatus: candidate.highlight?.lifecycleStatus ?? null,
        highlightReviewState: candidate.highlight?.reviewState ?? null,
        evidenceTypes: candidate.highlight?.evidence.map((edge) => edge.evidenceItem.type) ?? [],
      } : null,
      artifact: storedRun.artifact ? {
        exists: true,
        lifecycleStatus: storedRun.artifact.lifecycleStatus,
        publicSafetyStatus: storedRun.artifact.publicSafetyStatus,
        usedHighlightCount: storedRun.artifact._count.highlightProvenance,
        usedEvidenceCount: storedRun.artifact._count.evidenceProvenance,
      } : null,
      coverageGaps: Array.from(new Set([
        ...directCoverageGaps,
        ...researchCoverageGaps(storedRun.result, storedRun.researchState),
      ])),
      metrics,
      error,
    };
  }

  async cleanup() {
    if (this.input.keepData) return;
    const targets = projectChatApplicationCleanupTargets({
      createdRunIds: this.createdRunIds,
      createdThreadIds: this.createdThreadIds,
      sandboxWorkItemIds: this.sandboxWorkItemIds,
    });
    if (targets.runIds.length) {
      await prisma.artifact.deleteMany({ where: { originatingAgentRunId: { in: targets.runIds } } });
    }
    if (targets.threadIds.length) {
      await prisma.chatThread.deleteMany({ where: { id: { in: targets.threadIds } } });
    }
    if (targets.runIds.length) {
      await prisma.agentRun.deleteMany({ where: { id: { in: targets.runIds } } });
    }
    if (targets.sandboxWorkItemIds.length) {
      // Deleting the isolated Work Items cascades through their fixture Source,
      // EvidenceItem, ProjectFactEvidence, and ProjectFact rows.
      await prisma.workItem.deleteMany({ where: { id: { in: targets.sandboxWorkItemIds } } });
    }
  }
}

async function main() {
  const options = parseProjectChatApplicationCliOptions(process.argv.slice(2));
  const accomplishmentsProfile = await repositoryAccomplishmentsProfile(options);
  process.env.WORKFLOW_LOCAL_BASE_URL ??=
    process.env.WORKBASE_APPLICATION_EVAL_BASE_URL ?? "http://localhost:3000";
  process.env.WORKBASE_LLM_PROVIDER = options.provider;
  const user = await ensureDemoUser();
  let exactTarget: ExactRepositoryAccomplishmentsTarget | null = null;
  const workItem = accomplishmentsProfile
    ? await (async () => {
        const candidates = await prisma.workItem.findMany({
          where: {
            userId: user.id,
            // Deliberately use PostgreSQL's exact comparison. The resolver
            // repeats this fence and rejects ambiguity without a latest-row or
            // repository-label fallback.
            title: accomplishmentsProfile.workItemTitle,
          },
          select: {
            id: true,
            title: true,
            sources: {
              where: { type: "github_repo" },
              select: {
                id: true,
                type: true,
                metadata: true,
                _count: { select: { evidenceItems: true } },
              },
            },
          },
        });
        exactTarget = resolveExactRepositoryAccomplishmentsTarget({
          profile: accomplishmentsProfile,
          candidates: candidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            sources: candidate.sources.map((source) => ({
              id: source.id,
              type: source.type,
              metadata: source.metadata,
              evidenceItemCount: source._count.evidenceItems,
            })),
          })),
        });
        return prisma.workItem.findUniqueOrThrow({
          where: { id: exactTarget.workItemId },
        });
      })()
    : await prisma.workItem.findFirstOrThrow({
        where: {
          userId: user.id,
          title: { equals: options.workItemTitle, mode: "insensitive" },
          sources: { some: { type: "github_repo" } },
        },
        orderBy: { updatedAt: "desc" },
      });
  const driver = new PrismaProjectChatApplicationDriver({
    userId: user.id,
    mainWorkItemId: workItem.id,
    provider: options.provider,
    keepData: options.keepData,
  });
  const scenarioCatalog = accomplishmentsProfile
    ? buildRepositoryAccomplishmentsScenarioCatalog(accomplishmentsProfile)
    : undefined;
  const suite = await runProjectChatApplicationScenarios({
    driver,
    scenarioIds: accomplishmentsProfile
      ? scenarioCatalog?.map((scenario) => scenario.id)
      : options.scenarioIds,
    scenarioCatalog,
  });
  const output = accomplishmentsProfile && exactTarget
    ? buildRepositoryAccomplishmentsReport({
        provider: options.provider,
        gitCommit: currentCleanGitCommit(),
        profile: accomplishmentsProfile,
        target: exactTarget,
        suite,
        keepEvaluationData: options.keepData,
      })
    : {
        passed: suite.passed,
        provider: options.provider,
        workItem: { id: workItem.id, title: workItem.title },
        aggregate: suite.aggregate,
        scenarios: suite.results.map((result) => ({
          id: result.scenario.id,
          passed: result.passed,
          outcome: result.observation.outcome,
          executionMode: result.observation.executionMode,
          metrics: result.observation.metrics,
          tools: result.observation.tools,
          answerCompositionMode: result.observation.answerCompositionMode ?? null,
          knowledgeRefreshRunId: result.observation.knowledgeRefreshRunId ?? null,
          knowledgeRefresh: result.observation.knowledgeRefresh ?? null,
          citationCount: result.observation.citationCount,
          candidate: result.observation.candidate,
          artifact: result.observation.artifact,
          coverageGaps: result.observation.coverageGaps,
          failedChecks: result.checks.filter((check) => !check.passed),
          answer: options.compact
            ? result.observation.answer.slice(0, 800)
            : result.observation.answer,
          error: result.observation.error,
        })),
      };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.passed) process.exitCode = 2;
}

main()
  .finally(async () => {
    try {
      await getWorld().close?.();
    } finally {
      await prisma.$disconnect();
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
