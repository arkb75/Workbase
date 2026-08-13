import { FatalError, getWorkflowMetadata, sleep } from "workflow";
import { classifyWorkflowFailure } from "@/src/lib/error-message";
import { prisma } from "@/src/lib/prisma";
import {
  MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
  finalizeManualEvidenceHighlights,
  persistManualEvidenceHighlights,
  prepareManualEvidenceHighlights,
  type ManualEvidenceHighlightPersistenceResult,
  type ManualEvidenceHighlightPreparedPlan,
} from "@/src/services/manual-evidence-highlight-service";
import {
  appendAgentRunEvent,
  failAgentRun,
  markAgentRunRunning,
} from "@/src/services/project-chat-store";
import { runtimeReadinessService } from "@/src/services/runtime-readiness-service";

type TerminalAgentRunStatus =
  | "completed"
  | "insufficient_context"
  | "failed"
  | "cancelled";

type ManualWorkflowOwnership =
  | { status: "owned" }
  | { status: "superseded"; attachedWorkflowId: string | null }
  | { status: "terminal"; runStatus: TerminalAgentRunStatus };

const ACTIVE_RUN_STATUSES = ["queued", "running", "awaiting_review"] as const;
const TERMINAL_RUN_STATUSES = [
  "completed",
  "insufficient_context",
  "failed",
  "cancelled",
] as const;
const MAX_REPOSITORY_REFRESH_WAIT_ATTEMPTS = 240;

function classifyOwnership(
  run: { workflowId: string | null; status: string; kind: string } | null,
  workflowRunId: string,
): ManualWorkflowOwnership | { status: "starting"; reservation: string } {
  if (!run || run.kind !== MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND) {
    return { status: "superseded", attachedWorkflowId: null };
  }
  if (TERMINAL_RUN_STATUSES.includes(
    run.status as (typeof TERMINAL_RUN_STATUSES)[number],
  )) {
    return {
      status: "terminal",
      runStatus: run.status as TerminalAgentRunStatus,
    };
  }
  if (run.workflowId === workflowRunId) return { status: "owned" };
  if (run.workflowId?.startsWith("starting:")) {
    return { status: "starting", reservation: run.workflowId };
  }
  return { status: "superseded", attachedWorkflowId: run.workflowId };
}

export async function claimManualEvidenceHighlightWorkflowOwnership(
  runId: string,
  workflowRunId: string,
): Promise<ManualWorkflowOwnership> {
  "use step";

  const current = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { workflowId: true, status: true, kind: true },
  });
  const ownership = classifyOwnership(current, workflowRunId);
  if (ownership.status !== "starting") return ownership;
  const attached = await prisma.agentRun.updateMany({
    where: {
      id: runId,
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      workflowId: ownership.reservation,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    data: { workflowId: workflowRunId },
  });
  if (attached.count) return { status: "owned" };

  const winner = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { workflowId: true, status: true, kind: true },
  });
  const resolved = classifyOwnership(winner, workflowRunId);
  return resolved.status === "starting"
    ? { status: "superseded", attachedWorkflowId: resolved.reservation }
    : resolved;
}

async function assertApplicationRuntimeReady() {
  "use step";

  const readiness = await runtimeReadinessService.check();
  if (readiness.ready) return;
  const message = `${readiness.reason}: ${readiness.message} ${readiness.recovery}`;
  if (!readiness.retryable) throw new FatalError(message);
  throw new Error(message);
}

async function markManualEvidenceHighlightRunRunning(runId: string) {
  "use step";
  const running = await markAgentRunRunning(runId);
  if (running.active) {
    await appendAgentRunEvent({
      runId,
      type: "progress",
      message: "Analyzing the current manual Evidence snapshot for grounded Highlights.",
    });
  }
  return running;
}

async function emitManualEvidenceHighlightProgress(runId: string, message: string) {
  "use step";
  await appendAgentRunEvent({
    runId,
    type: "progress",
    message,
  });
}

async function terminalManualEvidenceHighlightStatus(runId: string) {
  "use step";
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  return run && TERMINAL_RUN_STATUSES.includes(
    run.status as (typeof TERMINAL_RUN_STATUSES)[number],
  )
    ? run.status as TerminalAgentRunStatus
    : null;
}

async function prepareManualEvidenceHighlightPlan(runId: string) {
  "use step";
  return prepareManualEvidenceHighlights(runId);
}
prepareManualEvidenceHighlightPlan.maxRetries = 2;

async function persistManualEvidenceHighlightPlan(input: {
  runId: string;
  plan: ManualEvidenceHighlightPreparedPlan;
}) {
  "use step";
  return persistManualEvidenceHighlights(input);
}
persistManualEvidenceHighlightPlan.maxRetries = 2;

async function finalizeManualEvidenceHighlightRun(input: {
  runId: string;
  plan: ManualEvidenceHighlightPreparedPlan | null;
  result: Exclude<
    ManualEvidenceHighlightPersistenceResult,
    { status: "deferred_repository_refresh" } | { status: "inactive" }
  >;
}) {
  "use step";
  const finalized = await finalizeManualEvidenceHighlights(input);
  if (finalized.persisted) {
    await appendAgentRunEvent({
      runId: input.runId,
      type: "status_change",
      message:
        input.result.terminalOutcome === "ready"
          ? "Manual Evidence Highlight analysis completed."
          : input.result.terminalOutcome === "superseded_input"
            ? "A newer manual Evidence snapshot superseded this analysis."
            : "Manual Evidence analysis completed without a safe Highlight candidate.",
    });
  }
  return finalized;
}
finalizeManualEvidenceHighlightRun.maxRetries = 2;

async function failManualEvidenceHighlightRun(runId: string, error: unknown) {
  "use step";
  const failure = classifyWorkflowFailure(error);
  await failAgentRun({
    runId,
    message: failure.message,
    failure: {
      code: failure.code,
      stage: "manual_evidence_highlights",
      retryable: failure.retryable,
      recovery: failure.recovery,
    },
  });
  await appendAgentRunEvent({
    runId,
    type: "error",
    message: failure.message,
  });
  return failure;
}

function inactiveResult(ownership: Exclude<ManualWorkflowOwnership, { status: "owned" }>) {
  return ownership.status === "terminal"
    ? { status: ownership.runStatus, replayed: true as const }
    : {
        status: "superseded" as const,
        replayed: true as const,
        attachedWorkflowId: ownership.attachedWorkflowId,
      };
}

export async function manualEvidenceHighlightWorkflow(runId: string) {
  "use workflow";

  try {
    // This exact-ID handshake runs before readiness checks or provider work.
    // It lets startAgentRunWorkflowOnce distinguish a remotely accepted run
    // from an orphan after a transport timeout or deletion race.
    const ownership = await claimManualEvidenceHighlightWorkflowOwnership(
      runId,
      getWorkflowMetadata().workflowRunId,
    );
    if (ownership.status !== "owned") return inactiveResult(ownership);
    await assertApplicationRuntimeReady();
    const running = await markManualEvidenceHighlightRunRunning(runId);
    if (!running.active) {
      return { status: running.status, replayed: true as const };
    }

    const prepared = await prepareManualEvidenceHighlightPlan(runId);
    if (prepared.status === "inactive") {
      return { status: prepared.runStatus, replayed: true as const };
    }
    if (prepared.status === "superseded_input") {
      const result = {
        status: "superseded_input" as const,
        terminalOutcome: "superseded_input" as const,
        createdHighlightIds: [] as [],
        replayedHighlightIds: [] as [],
        deduplicatedHighlightIds: [] as [],
        suggestionIds: [] as [],
        suppressedHighlightIds: [] as [],
      };
      await finalizeManualEvidenceHighlightRun({ runId, plan: null, result });
      return { status: "completed" as const, terminalOutcome: result.terminalOutcome };
    }

    let persisted = await persistManualEvidenceHighlightPlan({
      runId,
      plan: prepared.plan,
    });
    let waitAttempts = 0;
    while (persisted.status === "deferred_repository_refresh") {
      if (waitAttempts >= MAX_REPOSITORY_REFRESH_WAIT_ATTEMPTS) {
        throw new Error(
          "The active repository refresh did not finish within the durable manual Highlight wait window.",
        );
      }
      if (waitAttempts === 0) {
        await emitManualEvidenceHighlightProgress(
          runId,
          "Repository reconciliation is active; waiting to apply manual Evidence without crossing ownership boundaries.",
        );
      }
      waitAttempts += 1;
      await sleep("5s");
      persisted = await persistManualEvidenceHighlightPlan({
        runId,
        plan: prepared.plan,
      });
    }
    if (persisted.status === "inactive") {
      return { status: persisted.runStatus, replayed: true as const };
    }
    await finalizeManualEvidenceHighlightRun({
      runId,
      plan: prepared.plan,
      result: persisted,
    });
    return {
      status: "completed" as const,
      terminalOutcome: persisted.terminalOutcome,
      createdHighlightIds: persisted.createdHighlightIds,
      replayedHighlightIds: persisted.replayedHighlightIds,
      suggestionIds: persisted.suggestionIds,
    };
  } catch (error) {
    const terminalStatus = await terminalManualEvidenceHighlightStatus(runId);
    if (terminalStatus) {
      return { status: terminalStatus, replayed: true as const };
    }
    const failure = await failManualEvidenceHighlightRun(runId, error);
    return { status: "failed" as const, message: failure.message };
  }
}
