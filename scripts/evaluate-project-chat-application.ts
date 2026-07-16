import { randomUUID } from "node:crypto";
import { Prisma } from "../src/generated/prisma/client";
import { ensureDemoUser } from "../src/lib/demo-user";
import { prisma } from "../src/lib/prisma";
import {
  type ProjectChatApplicationDriver,
  type ProjectChatApplicationMetrics,
  type ProjectChatApplicationObservation,
  type ProjectChatApplicationOutcome,
  type ProjectChatApplicationScenario,
  type ProjectChatApplicationScenarioId,
  projectChatApplicationScenarios,
  runProjectChatApplicationScenarios,
} from "../src/evals/project-chat-application-runner";
import {
  completeAgentRun,
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
import {
  collectModelTokenUsage,
  collectUnknownModelUsageAttempts,
  estimateBedrockCostUsd,
} from "../src/services/model-usage-service";

interface CliOptions {
  provider: "mock" | "bedrock";
  workItemTitle: string;
  scenarioIds: ProjectChatApplicationScenarioId[];
  keepData: boolean;
  compact: boolean;
}

function parseArguments(argv: string[]): CliOptions {
  const valueAfter = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const provider = valueAfter("--provider") ?? "mock";
  if (provider !== "mock" && provider !== "bedrock") {
    throw new Error("--provider must be mock or bedrock.");
  }
  const scenarioValue = valueAfter("--scenarios");
  const scenarioIds = scenarioValue
    ? scenarioValue.split(",").map((entry) => entry.trim()).filter(Boolean) as ProjectChatApplicationScenarioId[]
    : [];
  const knownScenarioIds = new Set(projectChatApplicationScenarios.map((scenario) => scenario.id));
  const unknownScenarioIds = scenarioIds.filter((id) => !knownScenarioIds.has(id));
  if (unknownScenarioIds.length) {
    throw new Error(`Unknown application scenario${unknownScenarioIds.length === 1 ? "" : "s"}: ${unknownScenarioIds.join(", ")}.`);
  }
  return {
    provider,
    workItemTitle: valueAfter("--work-item") ?? process.env.EVAL_WORK_ITEM_TITLE ?? "Workbase",
    scenarioIds,
    keepData: argv.includes("--keep"),
    compact: argv.includes("--compact"),
  };
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

function countUsageLeaves(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countUsageLeaves(entry, seen), 0);
  const entry = value as Record<string, unknown>;
  if (["inputTokens", "outputTokens", "totalTokens"].some((key) => typeof entry[key] === "number")) return 1;
  return Object.values(entry).reduce<number>((total, nested) => total + countUsageLeaves(nested, seen), 0);
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

class PrismaProjectChatApplicationDriver implements ProjectChatApplicationDriver {
  private readonly threads = new Map<string, { id: string; workItemId: string }>();
  private readonly createdThreadIds = new Set<string>();
  private readonly createdRunIds = new Set<string>();
  private readonly sandboxWorkItemIds = new Set<string>();
  private readonly workspaces = new Map<string, string>();

  constructor(
    private readonly input: {
      userId: string;
      mainWorkItemId: string;
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
    const isolatedArtifactScenario = [
      "artifact_from_approved_context",
      "artifact_missing_impact",
      "artifact_review_gate",
    ].includes(scenario.id)
      ? scenario.id
      : undefined;
    return this.createSandbox(
      scenario.workspace === "attached_repository_sandbox",
      isolatedArtifactScenario,
    );
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

  private async history(threadId: string, currentUserMessageId: string): Promise<ProjectChatHistoryMessage[]> {
    const messages = await prisma.chatMessage.findMany({
      where: {
        threadId,
        status: "completed",
        id: { not: currentUserMessageId },
      },
      orderBy: { sequence: "asc" },
      include: { citations: { orderBy: { ordinal: "asc" } } },
    });
    return messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citations: message.citations.map((citation) => ({
        ordinal: citation.ordinal,
        kind: citation.kind,
        label: citation.label,
      })),
    }));
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
    events: Array<{ payload: unknown }>;
    researchState: unknown;
  }): Promise<ProjectChatApplicationMetrics> {
    const candidateGenerationRuns = await prisma.generationRun.findMany({
      where: {
        workItemId: input.workItemId,
        createdAt: { gte: input.startedAt, lte: input.finishedAt },
      },
      select: {
        provider: true,
        modelId: true,
        idempotencyKey: true,
        tokenUsage: true,
        estimatedCostUsd: true,
        resultRefs: true,
      },
    });
    const refreshRunId = typeof record(input.researchState).refreshRunId === "string"
      ? record(input.researchState).refreshRunId as string
      : null;
    const generationRuns = candidateGenerationRuns.filter((run) => {
      const refs = record(run.resultRefs);
      if (refs.agentRunId === input.runId) return true;
      if (run.idempotencyKey?.includes(input.runId)) return true;
      return Boolean(refreshRunId && run.idempotencyKey?.includes(refreshRunId));
    });
    const eventUsageValues: unknown[] = input.events.flatMap((event) => {
      const usage = record(event.payload).usage;
      return usage ? [usage] : [];
    });
    const dossierModelUsage = record(input.researchState).modelUsage;
    const nonGenerationUsage = collectModelTokenUsage([
      ...eventUsageValues,
      ...(dossierModelUsage ? [dossierModelUsage] : []),
    ]);
    const generationUsage = collectModelTokenUsage(generationRuns.map((run) => run.tokenUsage));
    const usage = collectModelTokenUsage([nonGenerationUsage, generationUsage]);
    const nonGenerationUnknownUsageAttempts = collectUnknownModelUsageAttempts([
      ...eventUsageValues,
      ...(dossierModelUsage ? [dossierModelUsage] : []),
    ]);
    const generationUnknownUsageAttempts = generationRuns.reduce((total, run) => {
      const refs = record(run.resultRefs);
      const recorded = refs.unknownUsageAttempts;
      return total + (
        typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0
          ? Math.floor(recorded)
        : run.tokenUsage == null && run.provider === "bedrock"
            ? 1
            : collectUnknownModelUsageAttempts(run.tokenUsage)
      );
    }, 0);
    const modelId = process.env.WORKBASE_BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
    const nonGenerationCost = estimateBedrockCostUsd(modelId, nonGenerationUsage) ?? 0;
    const generationCost = generationRuns.reduce((total, run) => total + (
      run.estimatedCostUsd ?? estimateBedrockCostUsd(run.modelId, collectModelTokenUsage(run.tokenUsage)) ?? 0
    ), 0);
    const repository = researchUsage(input.researchState);
    return {
      latencyMs: input.finishedAt.getTime() - input.startedAt.getTime(),
      modelCalls: eventUsageValues.reduce<number>((total, value) => total + countUsageLeaves(value), 0)
        + countUsageLeaves(dossierModelUsage)
        + nonGenerationUnknownUsageAttempts
        + generationRuns.reduce((total, run) => {
          const auditAttemptCount = record(run.resultRefs).auditAttemptCount;
          return total + (
            typeof auditAttemptCount === "number" && Number.isFinite(auditAttemptCount) && auditAttemptCount >= 0
              ? Math.floor(auditAttemptCount)
              : countUsageLeaves(run.tokenUsage)
          );
        }, 0),
      totalTokens: usage.totalTokens,
      estimatedCostUsd: Number((nonGenerationCost + generationCost).toFixed(6)),
      usageComplete: nonGenerationUnknownUsageAttempts + generationUnknownUsageAttempts === 0,
      repositoryTreeLookups: repository.treeLookups,
      repositorySearches: repository.searches,
      repositoryFileReads: repository.fileReads,
      repositoryVisibleBytes: repository.visibleBytes,
    };
  }

  async run(scenario: ProjectChatApplicationScenario): Promise<ProjectChatApplicationObservation> {
    const workItemId = await this.workItemIdFor(scenario);
    const thread = await this.threadFor(scenario, workItemId);
    const startedAt = new Date();
    const run = await createProjectChatRun({
      userId: this.input.userId,
      workItemId,
      threadId: thread.id,
      message: scenario.question,
      idempotencyKey: `application-eval:${scenario.id}:${randomUUID()}`,
    });
    this.createdRunIds.add(run.id);
    await markAgentRunRunning(run.id);
    await this.seedArtifactScenario(scenario, workItemId, run.id);
    const userMessage = await prisma.chatMessage.findFirstOrThrow({
      where: { agentRunId: run.id, role: "user" },
    });
    const history = await this.history(thread.id, userMessage.id);
    let outcome: ProjectChatApplicationOutcome = "failed";
    let answer = "";
    let error: string | null = null;
    let directCoverageGaps: string[] = [];
    try {
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
        rollingSummary: (await prisma.chatThread.findUnique({ where: { id: thread.id }, select: { rollingSummary: true } }))?.rollingSummary,
        allowResearch: scenario.allowResearch,
        onAgentEvent: (event) => persistResearchAgentEvent(run.id, event),
      });
      directCoverageGaps = result.status === "artifact_requested" ? [] : result.research.coverageGaps;
      ({ outcome, answer } = await this.persistResult({ runId: run.id, scenario, result }));
      if (scenario.id === "artifact_missing_impact" && outcome === "insufficient_context") {
        directCoverageGaps = [answer];
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      answer = error;
      await failAgentRun({ runId: run.id, message: error }).catch(() => null);
    }
    const finishedAt = new Date();
    const [storedRun, assistantMessage, events, candidate] = await Promise.all([
      prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
        select: {
          result: true,
          researchState: true,
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
        include: { citations: { orderBy: { ordinal: "asc" } } },
      }),
      prisma.agentRunEvent.findMany({
        where: { agentRunId: run.id },
        select: { type: true, toolName: true, payload: true },
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
    ]);
    const metrics = await this.metrics({
      runId: run.id,
      workItemId,
      startedAt,
      finishedAt,
      events,
      researchState: storedRun.researchState,
    });
    return {
      scenarioId: scenario.id,
      runId: run.id,
      threadId: thread.id,
      workItemId,
      outcome,
      answer: assistantMessage.content || answer,
      citationCount: assistantMessage.citations.length,
      citationKinds: assistantMessage.citations.map((citation) => citation.kind),
      citationOrdinals: Array.from((assistantMessage.content || answer).matchAll(/\[citation:(\d+)\]/gi))
        .map((match) => Number(match[1]))
        .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0),
      tools: events.flatMap((event) => event.type === "tool_call" && event.toolName ? [event.toolName] : []),
      historyMessageCount: history.length,
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
    if (this.createdRunIds.size) {
      await prisma.artifact.deleteMany({ where: { originatingAgentRunId: { in: [...this.createdRunIds] } } });
    }
    if (this.createdThreadIds.size) {
      await prisma.chatThread.deleteMany({ where: { id: { in: [...this.createdThreadIds] } } });
    }
    if (this.createdRunIds.size) {
      await prisma.agentRun.deleteMany({ where: { id: { in: [...this.createdRunIds] } } });
    }
    if (this.sandboxWorkItemIds.size) {
      await prisma.workItem.deleteMany({ where: { id: { in: [...this.sandboxWorkItemIds] } } });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  process.env.WORKBASE_LLM_PROVIDER = options.provider;
  const user = await ensureDemoUser();
  const workItem = await prisma.workItem.findFirst({
    where: {
      userId: user.id,
      title: { equals: options.workItemTitle, mode: "insensitive" },
      sources: { some: { type: "github_repo" } },
    },
    orderBy: { updatedAt: "desc" },
  }) ?? await prisma.workItem.findFirstOrThrow({
    where: { userId: user.id, sources: { some: { type: "github_repo" } } },
    orderBy: { updatedAt: "desc" },
  });
  const driver = new PrismaProjectChatApplicationDriver({
    userId: user.id,
    mainWorkItemId: workItem.id,
    keepData: options.keepData,
  });
  const suite = await runProjectChatApplicationScenarios({
    driver,
    scenarioIds: options.scenarioIds,
  });
  const output = {
    passed: suite.passed,
    provider: options.provider,
    workItem: { id: workItem.id, title: workItem.title },
    aggregate: suite.aggregate,
    scenarios: suite.results.map((result) => ({
      id: result.scenario.id,
      passed: result.passed,
      outcome: result.observation.outcome,
      metrics: result.observation.metrics,
      tools: result.observation.tools,
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
  if (!suite.passed) process.exitCode = 2;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
