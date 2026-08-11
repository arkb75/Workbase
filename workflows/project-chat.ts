import {
  createHook,
  FatalError,
  getWorkflowMetadata,
  getWritable,
  sleep,
} from "workflow";
import type { ChatProgressEvent } from "@/src/domain/project-chat";
import type { BedrockConverseAgentEvent } from "@/src/lib/bedrock-converse-agent";
import { classifyWorkflowFailure } from "@/src/lib/error-message";
import { prisma } from "@/src/lib/prisma";
import {
  appendAgentRunEvent,
  completeAgentRun,
  failAgentRun,
  markAgentRunAwaitingReview,
  markAgentRunRunning,
} from "@/src/services/project-chat-store";
import { proposeHighlightFromChatContext } from "@/src/services/chat-highlight-candidate-service";
import { executeArtifactAttempt } from "@/src/services/artifact-workflow-service";
import { persistResearchAgentEvent } from "@/src/services/research-event-persistence-service";
import {
  finalizeProjectChatAfterFactReview,
  requiresLiveRepositoryResearch,
  runProjectChatAgent,
} from "@/src/services/project-chat-agent-service";
import {
  isKnowledgeRefreshPartial,
  knowledgeRefreshService,
  startKnowledgeRefresh,
} from "@/src/services/knowledge-refresh-service";
import {
  assertKnowledgeRefreshGenerationCurrent,
  knowledgeReconciliationService,
} from "@/src/services/knowledge-reconciliation-service";
import { knowledgeStalenessService } from "@/src/services/knowledge-staleness-service";
import { runtimeReadinessService } from "@/src/services/runtime-readiness-service";

async function assertApplicationRuntimeReady() {
  "use step";

  const readiness = await runtimeReadinessService.check();
  if (readiness.ready) return;
  const message = `${readiness.reason}: ${readiness.message} ${readiness.recovery}`;
  if (!readiness.retryable) throw new FatalError(message);
  throw new Error(message);
}

type TerminalAgentRunStatus =
  | "completed"
  | "insufficient_context"
  | "failed"
  | "cancelled";

type AgentRunWorkflowOwnership =
  | { status: "owned" }
  | { status: "superseded"; attachedWorkflowId: string | null }
  | { status: "terminal"; runStatus: TerminalAgentRunStatus };

type TerminalKnowledgeRefreshStatus = "completed" | "failed" | "cancelled";

type KnowledgeRefreshWorkflowOwnership =
  | { status: "owned" }
  | { status: "superseded"; attachedWorkflowId: string | null }
  | { status: "terminal"; runStatus: TerminalKnowledgeRefreshStatus };

const ACTIVE_KNOWLEDGE_REFRESH_WORKFLOW_STATUSES = [
  "queued",
  "inventorying",
  "analyzing",
  "routing",
  "semantic_analysis",
  "auditing",
  "reconciling",
] as const;

function terminalAgentRunResult(status: string) {
  return ["completed", "insufficient_context", "failed", "cancelled"].includes(status)
    ? {
        status: status as TerminalAgentRunStatus,
        replayed: true as const,
      }
    : {
        status: "failed" as const,
        replayed: true as const,
      };
}

async function terminalAgentRunStatus(
  runId: string,
): Promise<TerminalAgentRunStatus | null> {
  "use step";

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
    return run.status as TerminalAgentRunStatus;
  }
  return null;
}

function classifyAgentRunWorkflowOwnership(
  run: { workflowId: string | null; status: string } | null,
  workflowRunId: string,
): AgentRunWorkflowOwnership | { status: "starting"; reservation: string } {
  if (!run) return { status: "superseded", attachedWorkflowId: null };
  if (
    ["completed", "insufficient_context", "failed", "cancelled"].includes(
      run.status,
    )
  ) {
    return {
      status: "terminal",
      runStatus: run.status as TerminalAgentRunStatus,
    };
  }
  if (run.workflowId === workflowRunId) return { status: "owned" };
  if (run.workflowId?.startsWith("starting:")) {
    return { status: "starting", reservation: run.workflowId };
  }
  return {
    status: "superseded",
    attachedWorkflowId: run.workflowId,
  };
}

async function claimAgentRunWorkflowOwnership(
  runId: string,
  workflowRunId: string,
): Promise<AgentRunWorkflowOwnership> {
  "use step";

  const current = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { workflowId: true, status: true },
  });
  const ownership = classifyAgentRunWorkflowOwnership(current, workflowRunId);
  if (ownership.status !== "starting") return ownership;

  const claimed = await prisma.agentRun.updateMany({
    where: {
      id: runId,
      workflowId: ownership.reservation,
      status: { in: ["queued", "running", "awaiting_review"] },
    },
    data: { workflowId: workflowRunId },
  });
  if (claimed.count) return { status: "owned" };

  // Another workflow or a terminal transition won the compare-and-swap.
  // Re-read once and exit unless this workflow is now the attached owner.
  const winner = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { workflowId: true, status: true },
  });
  const resolved = classifyAgentRunWorkflowOwnership(winner, workflowRunId);
  if (resolved.status === "starting") {
    return {
      status: "superseded",
      attachedWorkflowId: resolved.reservation,
    };
  }
  return resolved;
}

function classifyKnowledgeRefreshWorkflowOwnership(
  run: { workflowId: string | null; status: string } | null,
  workflowRunId: string,
): KnowledgeRefreshWorkflowOwnership | { status: "starting"; reservation: string } {
  if (!run) return { status: "superseded", attachedWorkflowId: null };
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    return {
      status: "terminal",
      runStatus: run.status as TerminalKnowledgeRefreshStatus,
    };
  }
  if (run.workflowId === workflowRunId) return { status: "owned" };
  if (run.workflowId?.startsWith("starting:")) {
    return { status: "starting", reservation: run.workflowId };
  }
  return {
    status: "superseded",
    attachedWorkflowId: run.workflowId,
  };
}

async function claimKnowledgeRefreshWorkflowOwnership(
  refreshRunId: string,
  workflowRunId: string,
): Promise<KnowledgeRefreshWorkflowOwnership> {
  "use step";

  const current = await prisma.knowledgeRefreshRun.findUnique({
    where: { id: refreshRunId },
    select: { workflowId: true, status: true },
  });
  const ownership = classifyKnowledgeRefreshWorkflowOwnership(
    current,
    workflowRunId,
  );
  if (ownership.status !== "starting") return ownership;

  const claimed = await prisma.knowledgeRefreshRun.updateMany({
    where: {
      id: refreshRunId,
      workflowId: ownership.reservation,
      status: { in: [...ACTIVE_KNOWLEDGE_REFRESH_WORKFLOW_STATUSES] },
    },
    data: { workflowId: workflowRunId },
  });
  if (claimed.count) return { status: "owned" };

  const winner = await prisma.knowledgeRefreshRun.findUnique({
    where: { id: refreshRunId },
    select: { workflowId: true, status: true },
  });
  const resolved = classifyKnowledgeRefreshWorkflowOwnership(
    winner,
    workflowRunId,
  );
  if (resolved.status === "starting") {
    return {
      status: "superseded",
      attachedWorkflowId: resolved.reservation,
    };
  }
  return resolved;
}

async function terminalKnowledgeRefreshStatus(
  refreshRunId: string,
): Promise<TerminalKnowledgeRefreshStatus | null> {
  "use step";

  const refresh = await prisma.knowledgeRefreshRun.findUnique({
    where: { id: refreshRunId },
    select: { status: true },
  });
  return refresh && ["completed", "failed", "cancelled"].includes(refresh.status)
    ? refresh.status as TerminalKnowledgeRefreshStatus
    : null;
}

export function repositoryKnowledgeRefreshDebounceDelay(
  trigger: string,
): "5s" | null {
  // Push bursts commonly contain several commits in quick succession. Give the
  // generation lock a short window to replace an older head before any
  // inventory, database promotion, or model work begins. Manual, scheduled,
  // attach, and chat-triggered runs never pay this delay.
  return trigger === "webhook_push" ? "5s" : null;
}

async function knowledgeRefreshTrigger(refreshRunId: string) {
  "use step";
  return (
    await prisma.knowledgeRefreshRun.findUniqueOrThrow({
      where: { id: refreshRunId },
      select: { trigger: true },
    })
  ).trigger;
}

function inactiveWorkflowResult(ownership: Exclude<
  AgentRunWorkflowOwnership,
  { status: "owned" }
>) {
  return ownership.status === "terminal"
    ? { status: ownership.runStatus, replayed: true as const }
    : {
        status: "superseded" as const,
        replayed: true as const,
        attachedWorkflowId: ownership.attachedWorkflowId,
      };
}

async function emitProgress(
  runId: string,
  message: string,
  type: ChatProgressEvent["type"] = "status",
) {
  "use step";

  await appendAgentRunEvent({
    runId,
    type: type === "error" ? "error" : "progress",
    message,
  }).catch(() => null);
  try {
    const writable = getWritable<ChatProgressEvent>();
    const writer = writable.getWriter();
    try {
      await writer.write({
        type,
        message,
        createdAt: new Date().toISOString(),
        refs: { runId },
      }).catch(() => undefined);
    } finally {
      writer.releaseLock();
    }
  } catch {
    // The durable event above is the audit trail. Streaming is best effort.
  }
}

async function closeProgressStream() {
  "use step";
  // Progress delivery is UX telemetry. A disconnected client must never turn
  // a successfully persisted run into a failed workflow.
  try {
    await getWritable<ChatProgressEvent>().close().catch(() => undefined);
  } catch {
    // The client may already be disconnected or the stream may be closed.
  }
}

async function attachAndClaimRequiredKnowledgeRefresh(input: {
  runId: string;
  refreshRunId: string;
  alreadyComplete: boolean;
}) {
  const ownerToken = `inline-agent:${input.runId}`;
  return prisma.$transaction(async (tx) => {
    // Cancellation uses the same AgentRun row lock. Whichever transition wins
    // is therefore authoritative: a cancelled turn can neither receive the
    // refresh link nor acquire an inline repository-work owner afterward.
    const locked = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status"
      FROM "AgentRun"
      WHERE "id" = ${input.runId}
      FOR UPDATE
    `;
    const status = locked[0]?.status;
    if (!status) throw new Error("The agent run no longer exists.");
    if (["completed", "insufficient_context", "failed", "cancelled"].includes(status)) {
      return {
        active: false as const,
        terminalStatus: status as TerminalAgentRunStatus,
        owner: false,
      };
    }

    const attached = await tx.agentRun.updateMany({
      where: {
        id: input.runId,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: { knowledgeRefreshRunId: input.refreshRunId },
    });
    if (!attached.count) {
      const current = await tx.agentRun.findUnique({
        where: { id: input.runId },
        select: { status: true },
      });
      if (
        current &&
        ["completed", "insufficient_context", "failed", "cancelled"].includes(
          current.status,
        )
      ) {
        return {
          active: false as const,
          terminalStatus: current.status as TerminalAgentRunStatus,
          owner: false,
        };
      }
      throw new Error("The agent run lost its repository-refresh attachment fence.");
    }

    const owner = input.alreadyComplete
      ? false
      : await knowledgeRefreshService.claimInline({
          runId: input.refreshRunId,
          ownerToken,
        }, tx);
    return {
      active: true as const,
      terminalStatus: null,
      owner,
    };
  });
}

async function releaseRequiredKnowledgeRefreshOwner(
  runId: string,
  refreshRunId: string,
) {
  "use step";
  return knowledgeRefreshService.releaseInline({
    runId: refreshRunId,
    ownerToken: `inline-agent:${runId}`,
  });
}

async function startRequiredKnowledgeRefresh(runId: string) {
  "use step";
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: { messages: { where: { role: "user" }, orderBy: { sequence: "desc" }, take: 1 } },
  });
  if (
    ["completed", "insufficient_context", "failed", "cancelled"].includes(
      run.status,
    )
  ) {
    return {
      required: false as const,
      refreshRunId: null,
      alreadyComplete: false,
      terminalStatus: run.status as TerminalAgentRunStatus,
    };
  }
  const question = run.messages[0]?.content ?? "";
  // Artifact adequacy is evaluated by ArtifactWorkflow itself, which starts
  // from approved Highlights and performs bounded targeted research only when
  // they are insufficient. Refreshing every attached repository before every
  // artifact request duplicated that work and made the common adequate-memory
  // path pay the full repository cost. Explicit freshness/repository language
  // still enters the refresh barrier here.
  if (!requiresLiveRepositoryResearch(question)) {
    return {
      required: false as const,
      refreshRunId: null,
      alreadyComplete: false,
      terminalStatus: null,
    };
  }
  const refresh = await startKnowledgeRefresh({
    userId: run.userId,
    workItemId: run.workItemId,
    trigger: "chat_freshness",
    idempotencyKey: `agent-run:${run.id}:freshness`,
  });
  const alreadyComplete = refresh.status === "completed";
  const attachment = await attachAndClaimRequiredKnowledgeRefresh({
    runId: run.id,
    refreshRunId: refresh.runId,
    alreadyComplete,
  });
  if (!attachment.active) {
    return {
      required: false as const,
      refreshRunId: null,
      alreadyComplete: false,
      owner: false,
      terminalStatus: attachment.terminalStatus,
    };
  }
  return {
    required: true as const,
    refreshRunId: refresh.runId,
    alreadyComplete,
    owner: attachment.owner,
    terminalStatus: null,
  };
}

async function inventoryRequiredKnowledge(refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.inventory(refreshRunId);
}

async function analyzeRequiredKnowledgeChunk(refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.analyzeChunk({ runId: refreshRunId, batchSize: 128, maxBatches: 1 });
}

async function finalizeRequiredCoverage(refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.finalizeCoverage(refreshRunId);
}

async function repairRequiredCoverage(refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.repairCoverage(refreshRunId);
}

async function retryRequiredKnowledgeEmbeddingBackfill(refreshRunId: string) {
  "use step";
  return knowledgeReconciliationService.retryEmbeddingBackfill(refreshRunId);
}

export function replayedAppliedKnowledgeIds(changes: Array<{
  entityKind: string;
  action: string;
  evidenceItemId: string | null;
  projectFactId: string | null;
  highlightId: string | null;
}>) {
  const appliedActions = new Set(["created", "updated", "revalidated"]);
  return {
    appliedFactIds: Array.from(new Set(changes.flatMap((change) =>
      change.entityKind === "project_fact" &&
      appliedActions.has(change.action) &&
      change.projectFactId
        ? [change.projectFactId]
        : []
    ))),
    appliedHighlightIds: Array.from(new Set(changes.flatMap((change) =>
      change.entityKind === "highlight" &&
      appliedActions.has(change.action) &&
      change.highlightId
        ? [change.highlightId]
        : []
    ))),
    promotedEvidenceIds: Array.from(new Set(changes.flatMap((change) =>
      change.entityKind === "evidence" &&
      appliedActions.has(change.action) &&
      change.evidenceItemId
        ? [change.evidenceItemId]
        : []
    ))),
  };
}

async function reconcileRequiredKnowledge(refreshRunId: string) {
  "use step";
  const checkpoint = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: refreshRunId },
    select: {
      status: true,
      warnings: true,
      changes: {
        select: {
          entityKind: true,
          action: true,
          evidenceItemId: true,
          projectFactId: true,
          highlightId: true,
        },
      },
    },
  });
  if (checkpoint.status === "completed") {
    const warnings = checkpoint.warnings &&
      typeof checkpoint.warnings === "object" &&
      !Array.isArray(checkpoint.warnings)
      ? checkpoint.warnings as Record<string, unknown>
      : {};
    const embeddingTelemetry = warnings.embeddingTelemetry &&
      typeof warnings.embeddingTelemetry === "object" &&
      !Array.isArray(warnings.embeddingTelemetry)
      ? warnings.embeddingTelemetry
      : {
          attempted: 0,
          attempts: 0,
          retried: 0,
          recovered: 0,
          failed: 0,
          failedTargets: [],
        };
    return {
      ...replayedAppliedKnowledgeIds(checkpoint.changes),
      embeddingTelemetry,
      staleness: null,
      replayed: true as const,
    };
  }
  await assertKnowledgeRefreshGenerationCurrent(refreshRunId);
  const reconciled = await knowledgeReconciliationService.reconcile(refreshRunId);
  await assertKnowledgeRefreshGenerationCurrent(refreshRunId);
  const stalenessStartedAt = Date.now();
  const stalenessResult = await knowledgeStalenessService.reconcile({
    runId: refreshRunId,
    appliedFactIds: reconciled.appliedFactIds,
    appliedHighlightIds: reconciled.appliedHighlightIds,
  });
  const staleness = {
    ...stalenessResult,
    durationMs: Date.now() - stalenessStartedAt,
  };
  await assertKnowledgeRefreshGenerationCurrent(refreshRunId);
  await knowledgeRefreshService.complete(refreshRunId, {
    appliedFactCount: reconciled.appliedFactIds.length,
    appliedHighlightCount: reconciled.appliedHighlightIds.length,
    promotedEvidenceCount: reconciled.promotedEvidenceIds.length,
  });
  return {
    appliedFactIds: reconciled.appliedFactIds,
    appliedHighlightIds: reconciled.appliedHighlightIds,
    promotedEvidenceIds: reconciled.promotedEvidenceIds,
    embeddingTelemetry: reconciled.embeddingTelemetry,
    reconciliationTelemetry: reconciled.reconciliationTelemetry,
    staleness,
  };
}

// Every mutation is generation-fenced and idempotent. The completed-run
// checkpoint above also turns a lost step response into a cheap replay, so a
// transient database/provider delivery failure no longer strands the parent
// chat after repository knowledge has already committed.
reconcileRequiredKnowledge.maxRetries = 2;

async function failRequiredKnowledgeRefresh(refreshRunId: string, errorMessage: string) {
  "use step";
  return knowledgeRefreshService.fail(refreshRunId, new Error(errorMessage));
}

async function attachRefreshToAgentRun(runId: string, refreshRunId: string) {
  "use step";
  const refresh = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: refreshRunId } });
  const updated = await prisma.agentRun.updateMany({
    where: {
      id: runId,
      status: { in: ["queued", "running", "awaiting_review"] },
    },
    data: {
      knowledgeRefreshRunId: refreshRunId,
      researchState: {
        kind: "repository_knowledge_refresh",
        refreshRunId,
        status: refresh.status,
        targetHeads: refresh.targetHeads,
        coverage: refresh.coverage,
        partial: isKnowledgeRefreshPartial(refresh),
        completedAt: refresh.finishedAt?.toISOString() ?? new Date().toISOString(),
      },
    },
  });
  return updated.count > 0;
}

async function inspectRequiredKnowledgeRefresh(refreshRunId: string) {
  "use step";
  const refresh = await prisma.knowledgeRefreshRun.findUniqueOrThrow({
    where: { id: refreshRunId },
    select: { status: true, error: true },
  });
  const error = refresh.error && typeof refresh.error === "object" && !Array.isArray(refresh.error)
    ? refresh.error as Record<string, unknown>
    : null;
  return {
    status: refresh.status,
    error: typeof error?.message === "string" ? error.message : null,
  };
}

async function claimRequiredKnowledgeRefresh(runId: string, refreshRunId: string) {
  "use step";
  return knowledgeRefreshService.claimInline({
    runId: refreshRunId,
    ownerToken: `inline-agent:${runId}`,
  });
}

function sharedRefreshWaitDelaySeconds(attempt: number) {
  const delays = [2, 3, 5, 8, 13, 21, 30] as const;
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return delays[Math.min(safeAttempt, delays.length - 1)]!;
}

async function waitForRequiredKnowledgeRefresh(runId: string, refreshRunId: string) {
  await emitProgress(
    runId,
    "Another turn is already refreshing this repository revision; waiting for its shared result.",
    "research",
  );
  const maxWaitSeconds = 15 * 60;
  let elapsedSeconds = 0;
  for (let attempt = 0; elapsedSeconds <= maxWaitSeconds; attempt += 1) {
    const terminalStatus = await terminalAgentRunStatus(runId);
    if (terminalStatus) return { refreshRunId, terminalStatus };
    const refresh = await inspectRequiredKnowledgeRefresh(refreshRunId);
    if (refresh.status === "completed") {
      await attachRefreshToAgentRun(runId, refreshRunId);
      await emitProgress(runId, "Using the completed shared repository refresh.", "research");
      return { refreshRunId };
    }
    if (refresh.status === "failed" || refresh.status === "cancelled") {
      throw new Error(
        refresh.error ?? "The shared repository refresh did not complete successfully.",
      );
    }
    const claimed = await claimRequiredKnowledgeRefresh(runId, refreshRunId);
    if (claimed) {
      await emitProgress(
        runId,
        "The previous refresh owner stopped; resuming its checkpointed repository work.",
        "research",
      );
      return { refreshRunId, claimed: true as const };
    }
    if (elapsedSeconds === maxWaitSeconds) break;
    const delaySeconds = Math.min(
      sharedRefreshWaitDelaySeconds(attempt),
      maxWaitSeconds - elapsedSeconds,
    );
    await sleep(`${delaySeconds}s`);
    elapsedSeconds += delaySeconds;
  }
  throw new Error("The shared repository refresh did not complete within the durable wait window.");
}

async function runRequiredKnowledgeRefresh(runId: string) {
  const requirement = await startRequiredKnowledgeRefresh(runId);
  if (requirement.terminalStatus) {
    return { terminalStatus: requirement.terminalStatus };
  }
  if (!requirement.required || !requirement.refreshRunId) return null;
  if (requirement.alreadyComplete) {
    const terminalStatus = await terminalAgentRunStatus(runId);
    if (terminalStatus) return { terminalStatus };
    const embeddingBackfill = await retryRequiredKnowledgeEmbeddingBackfill(
      requirement.refreshRunId,
    );
    await attachRefreshToAgentRun(runId, requirement.refreshRunId);
    await emitProgress(
      runId,
      embeddingBackfill.attempted > 0
        ? embeddingBackfill.failed > 0
          ? `Repository knowledge is current; ${embeddingBackfill.failed} semantic index entries remain queued for a later retry.`
          : `Repository knowledge is current and ${embeddingBackfill.attempted} semantic index entries were repaired.`
        : "Repository knowledge is already complete at the latest resolved commit.",
      "research",
    );
    return { refreshRunId: requirement.refreshRunId, embeddingBackfill };
  }
  let ownsRefresh = Boolean(requirement.owner);
  if (!requirement.owner) {
    const waited = await waitForRequiredKnowledgeRefresh(runId, requirement.refreshRunId);
    if (waited.terminalStatus) return { terminalStatus: waited.terminalStatus };
    if (!waited.claimed) {
      const terminalStatus = await terminalAgentRunStatus(runId);
      if (terminalStatus) return { terminalStatus };
      const embeddingBackfill = await retryRequiredKnowledgeEmbeddingBackfill(
        requirement.refreshRunId,
      );
      await attachRefreshToAgentRun(runId, requirement.refreshRunId);
      return { ...waited, embeddingBackfill };
    }
    ownsRefresh = true;
  }
  await emitProgress(runId, "Resolving the latest repository commit and inventorying every safe file.", "research");
  try {
    const beforeInventory = await terminalAgentRunStatus(runId);
    if (beforeInventory) {
      if (ownsRefresh) {
        await releaseRequiredKnowledgeRefreshOwner(runId, requirement.refreshRunId);
      }
      return { terminalStatus: beforeInventory };
    }
    await inventoryRequiredKnowledge(requirement.refreshRunId);
    let remaining = 1;
    while (remaining > 0) {
      const beforeAnalysis = await terminalAgentRunStatus(runId);
      if (beforeAnalysis) {
        if (ownsRefresh) {
          await releaseRequiredKnowledgeRefreshOwner(runId, requirement.refreshRunId);
        }
        return { terminalStatus: beforeAnalysis };
      }
      const chunk = await analyzeRequiredKnowledgeChunk(requirement.refreshRunId);
      remaining = chunk.remaining;
      await emitProgress(
        runId,
        remaining > 0
          ? `Analyzing complete repository coverage (${remaining} safe files remaining).`
          : "Every safe repository file has been analyzed.",
        "research",
      );
    }
    const beforeFinalization = await terminalAgentRunStatus(runId);
    if (beforeFinalization) {
      if (ownsRefresh) {
        await releaseRequiredKnowledgeRefreshOwner(runId, requirement.refreshRunId);
      }
      return { terminalStatus: beforeFinalization };
    }
    const repair = await repairRequiredCoverage(requirement.refreshRunId);
    if (repair.repaired > 0) {
      await emitProgress(runId, `Deepening ${repair.repaired} files to resolve semantic coverage gaps.`, "research");
    }
    await finalizeRequiredCoverage(requirement.refreshRunId);
    const beforeReconciliation = await terminalAgentRunStatus(runId);
    if (beforeReconciliation) {
      if (ownsRefresh) {
        await releaseRequiredKnowledgeRefreshOwner(runId, requirement.refreshRunId);
      }
      return { terminalStatus: beforeReconciliation };
    }
    await emitProgress(runId, "Reconciling current Facts, Highlights, Evidence, and Artifacts.", "candidate");
    const reconciliation = await reconcileRequiredKnowledge(requirement.refreshRunId);
    await attachRefreshToAgentRun(runId, requirement.refreshRunId);
    return { refreshRunId: requirement.refreshRunId, ...reconciliation };
  } catch (error) {
    const terminalStatus = await terminalAgentRunStatus(runId);
    if (terminalStatus) {
      if (ownsRefresh) {
        await releaseRequiredKnowledgeRefreshOwner(runId, requirement.refreshRunId);
      }
      return { terminalStatus };
    }
    const failure = classifyWorkflowFailure(error);
    await failRequiredKnowledgeRefresh(
      requirement.refreshRunId,
      `${failure.message}${failure.recovery ? ` ${failure.recovery}` : ""}`,
    );
    throw error;
  }
}

type StoredHistoryCitation = {
  ordinal: number;
  kind: string;
  label: string;
};

type StoredHistoryMessage = {
  id: string;
  agentRunId: string | null;
  sequence: number;
  role: "user" | "assistant";
  status: string;
  content: string;
  metadata: unknown;
  citations: StoredHistoryCitation[];
  agentRun: { error: unknown } | null;
};

type NormalizedHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: StoredHistoryCitation[];
};

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizedTranscriptText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function sanitizedFailureCode(value: unknown) {
  const code = sanitizedTranscriptText(value, 80);
  return code && /^[a-z0-9][a-z0-9_.:-]*$/i.test(code) ? code : null;
}

/**
 * Failed assistant content can contain provider diagnostics, request payloads,
 * or other implementation detail that is inappropriate to replay to the
 * model. Reconstruct the turn exclusively from the persisted, user-safe
 * failure envelope. A legacy failure without that envelope is omitted along
 * with its paired user message by normalizeProjectChatHistory below.
 */
function sanitizedTerminalAssistantMessage(
  message: StoredHistoryMessage,
): NormalizedHistoryMessage | null {
  if (message.status === "cancelled") {
    return {
      id: message.id,
      role: "assistant",
      content: "The previous assistant turn was cancelled before completion.",
      citations: [],
    };
  }
  if (message.status !== "failed") return null;

  const metadata = jsonRecord(message.metadata);
  const runError = jsonRecord(message.agentRun?.error);
  const code = sanitizedFailureCode(metadata?.failureCode) ??
    sanitizedFailureCode(runError?.code);
  const stage = sanitizedTranscriptText(runError?.stage, 120);
  const recovery = sanitizedTranscriptText(metadata?.recovery, 400);
  if (!code && !stage && !recovery) return null;

  return {
    id: message.id,
    role: "assistant",
    content: [
      "The previous assistant turn failed.",
      code ? `Failure code: ${code}.` : null,
      stage ? `Stage: ${stage}.` : null,
      recovery ? `Recovery: ${recovery}` : null,
    ].filter(Boolean).join(" "),
    citations: [],
  };
}

/**
 * Bedrock conversation history must describe complete turns. Normalize the
 * persisted transcript into chronological user/assistant pairs so a failed,
 * cancelled, interrupted, or legacy turn can never leave two adjacent user
 * messages. The final slice stays pair-aligned while retaining the existing
 * twelve-message history ceiling.
 */
function normalizeProjectChatHistory(
  messages: StoredHistoryMessage[],
  currentUserMessageId: string,
): NormalizedHistoryMessage[] {
  const normalized: NormalizedHistoryMessage[] = [];
  let pendingUser: StoredHistoryMessage | null = null;

  for (const message of messages
    .filter((candidate) => candidate.id !== currentUserMessageId)
    .sort((left, right) => left.sequence - right.sequence)) {
    if (message.role === "user") {
      pendingUser = message.status === "completed" ? message : null;
      continue;
    }
    if (!pendingUser) continue;

    const sameRun = !pendingUser.agentRunId ||
      !message.agentRunId ||
      pendingUser.agentRunId === message.agentRunId;
    if (!sameRun) {
      pendingUser = null;
      continue;
    }

    const assistant = message.status === "completed"
      ? {
          id: message.id,
          role: "assistant" as const,
          content: message.content,
          citations: message.citations.map((citation) => ({
            ordinal: citation.ordinal,
            kind: citation.kind,
            label: citation.label,
          })),
        }
      : sanitizedTerminalAssistantMessage(message);
    if (assistant) {
      normalized.push(
        {
          id: pendingUser.id,
          role: "user",
          content: pendingUser.content,
          citations: [],
        },
        assistant,
      );
    }
    pendingUser = null;
  }

  return normalized.slice(-12);
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * A `use step` invocation can be retried after its database writes committed
 * but before Workflow persisted the step result. Treat the review checkpoint
 * as the durable output only when its run result, provisional assistant
 * snapshot, persisted citations, and scoped Project Fact candidate batch all
 * agree. A malformed/partial checkpoint falls through to the normal recovery
 * path instead of silently skipping work.
 */
async function hasValidAwaitingReviewCheckpoint(runId: string) {
  const checkpoint = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: {
      status: true,
      result: true,
      provisionalResult: true,
      candidates: {
        where: {
          kind: { in: ["new_project_fact", "project_fact_revision"] },
        },
        select: {
          id: true,
          kind: true,
          batchNumber: true,
          projectFactId: true,
        },
      },
      messages: {
        where: { role: "assistant" },
        orderBy: { sequence: "desc" },
        take: 1,
        select: {
          status: true,
          content: true,
          citations: {
            orderBy: { ordinal: "asc" },
            select: {
              ordinal: true,
              kind: true,
              label: true,
              projectFactId: true,
            },
          },
        },
      },
    },
  });
  if (checkpoint?.status !== "awaiting_review") return false;

  const result = jsonRecord(checkpoint.result);
  const provisional = jsonRecord(checkpoint.provisionalResult);
  if (result?.status !== "awaiting_review" || !provisional) return false;

  const rawCandidateIds = result.candidateIds;
  const candidateIds = Array.from(new Set(stringList(rawCandidateIds)));
  if (
    !Array.isArray(rawCandidateIds) ||
    !candidateIds.length ||
    candidateIds.length !== rawCandidateIds.length
  ) {
    return false;
  }
  const candidateById = new Map(
    checkpoint.candidates.map((candidate) => [candidate.id, candidate]),
  );
  if (
    candidateIds.some((candidateId) => {
      const candidate = candidateById.get(candidateId);
      return (
        !candidate ||
        candidate.batchNumber !== 1 ||
        !candidate.projectFactId ||
        (
          candidate.kind !== "new_project_fact" &&
          candidate.kind !== "project_fact_revision"
        )
      );
    })
  ) {
    return false;
  }

  const content =
    typeof provisional.content === "string" ? provisional.content.trim() : "";
  const citationManifest = Array.isArray(provisional.citations)
    ? provisional.citations.map(jsonRecord)
    : [];
  if (!content || citationManifest.some((citation) => !citation)) return false;

  const assistant = checkpoint.messages[0];
  if (
    !assistant ||
    assistant.status !== "awaiting_review" ||
    assistant.content.trim() !== content ||
    assistant.citations.length !== citationManifest.length
  ) {
    return false;
  }
  return citationManifest.every((citation, index) => {
    const persistedCitation = assistant.citations[index];
    return (
      citation?.ordinal === index + 1 &&
      typeof citation.kind === "string" &&
      typeof citation.label === "string" &&
      persistedCitation?.ordinal === citation.ordinal &&
      persistedCitation.kind === citation.kind &&
      persistedCitation.label === citation.label.slice(0, 300) &&
      persistedCitation.projectFactId ===
        (typeof citation.projectFactId === "string"
          ? citation.projectFactId
          : null)
    );
  });
}

async function answerProjectQuestion(runId: string, afterFactReview = false) {
  "use step";

  const persisted = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true },
  });
  if (persisted.status === "completed") {
    return { status: "completed" as const, replayed: true as const };
  }
  if (persisted.status === "insufficient_context") {
    return { status: "insufficient_context" as const, replayed: true as const };
  }
  if (persisted.status === "failed") {
    return { status: "failed" as const, replayed: true as const };
  }
  if (persisted.status === "cancelled") {
    return { status: "cancelled" as const, replayed: true as const };
  }
  if (
    !afterFactReview &&
    persisted.status === "awaiting_review" &&
    await hasValidAwaitingReviewCheckpoint(runId)
  ) {
    return { status: "awaiting_review" as const, replayed: true as const };
  }

  const running = await markAgentRunRunning(runId);
  if (!running.active) return terminalAgentRunResult(running.status);
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      messages: {
        orderBy: { sequence: "asc" },
      },
      thread: {
        include: {
          messages: {
            where: { status: { in: ["completed", "failed", "cancelled"] } },
            orderBy: { sequence: "desc" },
            // Scan enough persisted messages to recover twelve complete,
            // pair-aligned transcript entries after excluding the current user
            // and any unusable legacy failure.
            take: 25,
            include: {
              citations: { orderBy: { ordinal: "asc" } },
              agentRun: { select: { error: true } },
            },
          },
        },
      },
    },
  });
  if (
    ["completed", "insufficient_context", "failed", "cancelled"].includes(
      run.status,
    )
  ) {
    return terminalAgentRunResult(run.status);
  }
  const userMessage = run.messages.find((message) => message.role === "user");
  const question = userMessage?.content ?? "";

  if (!userMessage || !question) {
    await failAgentRun({ runId, message: "The chat request did not contain a question." });
    return { status: "failed" as const };
  }

  const existingCandidate = await prisma.agentRunCandidate.findFirst({
    where: { agentRunId: run.id },
  });

  if (!existingCandidate && run.threadId && userMessage) {
    const beforeCandidate = await prisma.agentRun.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    if (
      !beforeCandidate ||
      !["queued", "running", "awaiting_review"].includes(
        beforeCandidate.status,
      )
    ) {
      return terminalAgentRunResult(beforeCandidate?.status ?? "missing");
    }
    try {
      const candidate = await proposeHighlightFromChatContext({
        userId: run.userId,
        workItemId: run.workItemId,
        threadId: run.threadId,
        messageId: userMessage.id,
        agentRunId: run.id,
        text: question,
      });

      if (candidate) {
        await appendAgentRunEvent({
          runId,
          type: "status_change",
          message: "Prepared a reviewable highlight candidate from your new context.",
        });
      }
    } catch (error) {
      await appendAgentRunEvent({
        runId,
        type: "warning",
        message: "The answer is continuing, but Workbase could not prepare a highlight candidate.",
        payload: { error: error instanceof Error ? error.message : "unknown" },
        isUserVisible: false,
      });
    }
  }

  const history = normalizeProjectChatHistory(
    run.thread?.messages ?? [],
    userMessage.id,
  );
  const agentInput = {
    runId: run.id,
    userId: run.userId,
    workItemId: run.workItemId,
    threadId: run.threadId!,
    messageId: userMessage!.id,
    question,
    history,
    rollingSummary: run.thread?.rollingSummary,
    allowResearch: !afterFactReview,
    // Agent telemetry must never be in the model/tool critical path. The
    // persisted answer and citations are authoritative; progress events are a
    // best-effort audit/UX stream.
    onAgentEvent: (event: BedrockConverseAgentEvent) =>
      persistResearchAgentEvent(run.id, event).catch(() => undefined),
  };
  const beforeAgent = await prisma.agentRun.findUnique({
    where: { id: run.id },
    select: { status: true },
  });
  if (
    !beforeAgent ||
    !["queued", "running", "awaiting_review"].includes(beforeAgent.status)
  ) {
    return terminalAgentRunResult(beforeAgent?.status ?? "missing");
  }
  const result = afterFactReview
    ? await finalizeProjectChatAfterFactReview(agentInput)
    : await runProjectChatAgent(agentInput);

  if (result.status === "artifact_requested") {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        kind: "artifact_workflow",
        request: { message: question, brief: result.brief },
      },
    });
    return { status: "artifact_requested" as const };
  }

  if (result.status === "insufficient_context") {
    await failAgentRun({
      runId,
      message: result.answer,
      insufficient: true,
    });
    return { status: "insufficient_context" as const };
  }

  if (result.status === "awaiting_review") {
    const reviewTransition = await markAgentRunAwaitingReview({
      runId: run.id,
      content: result.answer,
      citations: result.citations,
      citationPolicy: result.citationPolicy,
      groundedClaims: result.groundedClaims,
      freshness: result.freshness,
      result: {
        status: "awaiting_review",
        candidateIds: result.research.candidateIds,
        coverageGaps: result.research.coverageGaps,
        warnings: result.research.warnings,
        partial: result.research.partial,
        exploredEvidenceCount: result.research.exploredEvidence.length,
      },
    });
    if (!reviewTransition.persisted) {
      return terminalAgentRunResult(reviewTransition.status);
    }
    return { status: "awaiting_review" as const };
  }

  const completion = await completeAgentRun({
    runId,
    content: result.answer,
    result: {
      status: result.research.status,
      findings: result.research.findings,
      coverageGaps: result.research.coverageGaps,
      warnings: result.research.warnings,
      citationCount: result.citations.length,
      generationRunIds: result.research.generationRunIds,
      partial: result.research.partial,
      exploredEvidenceCount: result.research.exploredEvidence.length,
      groundedClaims: result.research.groundedClaims ?? [],
      fallbackUsed: result.fallbackUsed ?? false,
    },
    citations: result.citations,
    citationPolicy: result.citationPolicy,
    groundedClaims: result.groundedClaims,
    freshness: result.freshness,
    researchFinalization: {
      usedProjectFactIds: result.citations.flatMap((citation) => citation.projectFactId ? [citation.projectFactId] : []),
    },
  });
  if (!completion.persisted) {
    if (
      completion.status === "completed" ||
      completion.status === "insufficient_context" ||
      completion.status === "failed" ||
      completion.status === "cancelled"
    ) {
      return { status: completion.status, replayed: true as const };
    }
    throw new Error("The agent answer could not be persisted to an active run.");
  }
  return { status: "completed" as const };
}

async function approvedProjectFactCandidateCount(runId: string) {
  "use step";
  return prisma.agentRunCandidate.count({
    where: {
      agentRunId: runId,
      kind: { in: ["new_project_fact", "project_fact_revision"] },
      status: { in: ["approved", "edited_and_approved"] },
      projectFact: { status: "approved" },
    },
  });
}

async function finishDeniedProjectFactReview(runId: string) {
  "use step";
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { result: true } });
  const stored = run?.result && typeof run.result === "object" && !Array.isArray(run.result)
    ? run.result as Record<string, unknown>
    : null;
  const gaps = Array.isArray(stored?.coverageGaps)
    ? stored.coverageGaps.filter((gap): gap is string => typeof gap === "string").slice(0, 3)
    : [];
  const message = [
    "None of the repository-derived Project Facts were approved, so Workbase cannot retain or use those provisional claims.",
    gaps.length ? `Unresolved coverage: ${gaps.join("; ")}` : "Retry with a narrower question or different repository scope if you want another research pass.",
  ].join(" ");
  await failAgentRun({ runId, message, insufficient: true });
  return { status: "insufficient_context" as const, message };
}

async function setAgentRunRunning(runId: string) {
  "use step";
  return markAgentRunRunning(runId);
}

async function setAgentRunStarted(runId: string) {
  "use step";
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (run?.status === "awaiting_review") {
    return { active: true as const, status: "awaiting_review" as const };
  }
  if (
    !run ||
    ["completed", "insufficient_context", "failed", "cancelled"].includes(run.status)
  ) {
    return { active: false as const, status: run?.status ?? "missing" };
  }
  return markAgentRunRunning(runId);
}

async function runArtifactAttempt(runId: string, batchNumber: number) {
  "use step";
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  if (!run || !["queued", "running", "awaiting_review"].includes(run.status)) {
    const terminal = terminalAgentRunResult(run?.status ?? "missing");
    if (terminal.status === "completed") {
      return { status: "completed" as const, replayed: true as const };
    }
    if (terminal.status === "insufficient_context") {
      return {
        status: "insufficient_context" as const,
        message: "The artifact run already finished without sufficient context.",
        replayed: true as const,
      };
    }
    if (terminal.status === "cancelled") {
      return {
        status: "cancelled" as const,
        message: "The artifact run was cancelled.",
        replayed: true as const,
      };
    }
    return {
      status: "failed" as const,
      message: "The artifact run already failed.",
      replayed: true as const,
    };
  }
  return executeArtifactAttempt({ runId, batchNumber });
}

async function hasPendingReviewCandidates(runId: string, batchNumber: number) {
  "use step";
  return (
    (await prisma.agentRunCandidate.count({
      where: { agentRunId: runId, batchNumber, status: "pending" },
    })) > 0
  );
}

async function finishArtifactInsufficientContext(runId: string, message: string) {
  "use step";
  await failAgentRun({ runId, message, insufficient: true });
  return { status: "insufficient_context" as const, message };
}

async function failWorkflowRun(
  runId: string,
  failure: ReturnType<typeof classifyWorkflowFailure>,
  stage: string,
) {
  "use step";
  const message = [failure.message, failure.recovery].filter(Boolean).join(" ");
  await failAgentRun({
    runId,
    message,
    failure: {
      code: failure.code,
      stage,
      retryable: failure.retryable,
      recovery: failure.recovery,
    },
  });
  return message;
}

function failureStage(
  failure: ReturnType<typeof classifyWorkflowFailure>,
  operationStage: string,
) {
  return failure.code === "runtime_schema_mismatch" ||
      failure.code === "database_schema_out_of_date"
    ? "Checking application readiness"
    : operationStage;
}

async function runArtifactLifecycle(runId: string) {
  const initialTransition = await setAgentRunRunning(runId);
  if (!initialTransition.active) {
    return terminalAgentRunResult(initialTransition.status);
  }
  await emitProgress(runId, "Selecting approved highlights for the artifact.", "retrieval");

  // The third attempt never researches. It only re-evaluates the context approved
  // after the second and final review batch before declaring an evidence gap.
  for (let batchNumber = 1; batchNumber <= 3; batchNumber += 1) {
    const terminalStatus = await terminalAgentRunStatus(runId);
    if (terminalStatus) return terminalAgentRunResult(terminalStatus);
    const result = await runArtifactAttempt(runId, batchNumber);

    if (
      result.status === "completed" ||
      result.status === "clarification_required" ||
      result.status === "insufficient_context" ||
      result.status === "failed" ||
      result.status === "cancelled"
    ) {
      const message = result.status === "completed"
        ? "Artifact generated from approved highlights."
        : result.message;
      await emitProgress(
        runId,
        message,
        result.status === "completed"
          ? "complete"
          : result.status === "cancelled"
            ? "status"
            : "error",
      );
      return result;
    }

    if (result.status === "retry_research") {
      await emitProgress(runId, "Refining the repository research target.", "research");
      continue;
    }

    await emitProgress(
      runId,
      "Verified Highlights were auto-applied; waiting only on quarantined safety exceptions.",
      "candidate",
    );
    using review = createHook<{ reviewed: true }>({
      token: `agent-run:${runId}:review:${batchNumber}`,
    });
    if (await hasPendingReviewCandidates(runId, batchNumber)) {
      await review;
    }
    const resumed = await setAgentRunRunning(runId);
    if (!resumed.active) return terminalAgentRunResult(resumed.status);
    await emitProgress(runId, "Safety review complete. Rechecking auto-applied context.", "retrieval");
  }

  const message = "The artifact workflow finished without enough approved context.";
  const result = await finishArtifactInsufficientContext(runId, message);
  await emitProgress(runId, message, "error");
  return result;
}

export async function projectChatTurnWorkflow(runId: string) {
  "use workflow";

  try {
    const ownership = await claimAgentRunWorkflowOwnership(
      runId,
      getWorkflowMetadata().workflowRunId,
    );
    if (ownership.status !== "owned") {
      return inactiveWorkflowResult(ownership);
    }
    await assertApplicationRuntimeReady();
    const running = await setAgentRunStarted(runId);
    if (!running.active) return terminalAgentRunResult(running.status);
    // startRequiredKnowledgeRefresh and answerProjectQuestion both perform
    // their own terminal-state fences. Separate status-only Workflow steps
    // here added three remote round trips to every turn without closing a race
    // that those authoritative transitions did not already close.
    const refresh = await runRequiredKnowledgeRefresh(runId);
    if (refresh?.terminalStatus) {
      return terminalAgentRunResult(refresh.terminalStatus);
    }
    await emitProgress(runId, "Searching verified project memory.", "retrieval");
    let result = await answerProjectQuestion(runId);
    if (result.status === "artifact_requested") {
      await emitProgress(runId, "Starting the approval-gated artifact workflow.", "artifact");
      return await runArtifactLifecycle(runId);
    }
    if (result.status === "awaiting_review") {
      await emitProgress(
        runId,
        "Repository research found project facts. Waiting for every review decision.",
        "candidate",
      );
      using review = createHook<{ reviewed: true }>({
        token: `agent-run:${runId}:review:1`,
      });
      if (await hasPendingReviewCandidates(runId, 1)) await review;
      if (!(await approvedProjectFactCandidateCount(runId))) {
        return await finishDeniedProjectFactReview(runId);
      }
      await emitProgress(runId, "Fact review complete. Resuming the saved research and finalizing from approved facts.", "retrieval");
      result = await answerProjectQuestion(runId, true);
    }
    const progress = result.status === "completed"
      ? { message: "Answer grounded and citations attached.", type: "complete" as const }
      : result.status === "cancelled"
        ? { message: "Project chat was cancelled.", type: "status" as const }
        : result.status === "failed"
          ? { message: "Project chat failed.", type: "error" as const }
          : { message: "Project context was not sufficient for a grounded answer.", type: "error" as const };
    await emitProgress(runId, progress.message, progress.type);
    return result;
  } catch (error) {
    const terminalStatus = await terminalAgentRunStatus(runId);
    if (terminalStatus) {
      return { status: terminalStatus, replayed: true as const };
    }
    const failure = classifyWorkflowFailure(error);
    const message = await failWorkflowRun(
      runId,
      failure,
      failureStage(failure, "Running project chat"),
    );
    return { status: "failed" as const, message };
  } finally {
    await closeProgressStream();
  }
}

export async function artifactGenerationWorkflow(runId: string) {
  "use workflow";

  try {
    const ownership = await claimAgentRunWorkflowOwnership(
      runId,
      getWorkflowMetadata().workflowRunId,
    );
    if (ownership.status !== "owned") {
      return inactiveWorkflowResult(ownership);
    }
    await assertApplicationRuntimeReady();
    const running = await setAgentRunStarted(runId);
    if (!running.active) return terminalAgentRunResult(running.status);
    const refresh = await runRequiredKnowledgeRefresh(runId);
    if (refresh?.terminalStatus) {
      return terminalAgentRunResult(refresh.terminalStatus);
    }
    return await runArtifactLifecycle(runId);
  } catch (error) {
    const terminalStatus = await terminalAgentRunStatus(runId);
    if (terminalStatus) {
      return { status: terminalStatus, replayed: true as const };
    }
    const failure = classifyWorkflowFailure(error);
    const message = await failWorkflowRun(
      runId,
      failure,
      failureStage(failure, "Generating artifact"),
    );
    return { status: "failed" as const, message };
  } finally {
    await closeProgressStream();
  }
}

export async function repositoryKnowledgeRefreshWorkflow(refreshRunId: string) {
  "use workflow";

  try {
    const ownership = await claimKnowledgeRefreshWorkflowOwnership(
      refreshRunId,
      getWorkflowMetadata().workflowRunId,
    );
    if (ownership.status === "terminal") {
      return { status: ownership.runStatus, replayed: true as const };
    }
    if (ownership.status === "superseded") {
      return {
        status: "superseded" as const,
        replayed: true as const,
        attachedWorkflowId: ownership.attachedWorkflowId,
      };
    }
    const debounceDelay = repositoryKnowledgeRefreshDebounceDelay(
      await knowledgeRefreshTrigger(refreshRunId),
    );
    if (debounceDelay) await sleep(debounceDelay);
    const beforeReadiness = await terminalKnowledgeRefreshStatus(refreshRunId);
    if (beforeReadiness) {
      return { status: beforeReadiness, replayed: true as const };
    }
    await assertApplicationRuntimeReady();
    const beforeInventory = await terminalKnowledgeRefreshStatus(refreshRunId);
    if (beforeInventory) {
      return { status: beforeInventory, replayed: true as const };
    }
    await inventoryRequiredKnowledge(refreshRunId);
    let remaining = 1;
    while (remaining > 0) {
      const chunk = await analyzeRequiredKnowledgeChunk(refreshRunId);
      remaining = chunk.remaining;
    }
    await repairRequiredCoverage(refreshRunId);
    await finalizeRequiredCoverage(refreshRunId);
    return await reconcileRequiredKnowledge(refreshRunId);
  } catch (error) {
    const terminalStatus = await terminalKnowledgeRefreshStatus(refreshRunId);
    if (terminalStatus) {
      return { status: terminalStatus, replayed: true as const };
    }
    const failure = classifyWorkflowFailure(error);
    await failRequiredKnowledgeRefresh(
      refreshRunId,
      `${failure.message}${failure.recovery ? ` ${failure.recovery}` : ""}`,
    );
    throw error;
  }
}
