import { getRun, start } from "workflow/api";
import type { ChatProgressEvent } from "@/src/domain/project-chat";
import { getDemoUser } from "@/src/lib/demo-user";
import { prisma } from "@/src/lib/prisma";
import { recoverTerminalWorkflowForActiveAgentRun } from "@/src/services/agent-run-workflow-start-service";
import {
  artifactGenerationWorkflow,
  projectChatTurnWorkflow,
} from "@/workflows/project-chat";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getDemoUser();
  const agentRun = await prisma.agentRun.findFirst({
    where: { id, userId: user.id },
    select: { workflowId: true, kind: true, status: true },
  });

  if (!agentRun?.workflowId) {
    return Response.json({ error: "Agent run not found." }, { status: 404 });
  }

  let workflowId = agentRun.workflowId;
  let recoveredWorkflow = false;
  if (
    ["chat_turn", "artifact_workflow"].includes(agentRun.kind) &&
    ["queued", "running", "awaiting_review"].includes(agentRun.status)
  ) {
    const recovery = await recoverTerminalWorkflowForActiveAgentRun({
      runId: id,
      startWorkflow: () => agentRun.kind === "artifact_workflow"
        ? start(artifactGenerationWorkflow, [id])
        : start(projectChatTurnWorkflow, [id]),
    }).catch(() => null);
    workflowId = recovery?.workflowId ?? workflowId;
    recoveredWorkflow = recovery?.recovered === true;
  }

  const url = new URL(request.url);
  const lastEventId = request.headers.get("last-event-id");
  const rawIndex = url.searchParams.get("startIndex");
  const parsedIndex = lastEventId
    ? Number.parseInt(lastEventId, 10) + 1
    : rawIndex == null
      ? 0
      : Number.parseInt(rawIndex, 10);
  const startIndex = recoveredWorkflow
    ? 0
    : Number.isFinite(parsedIndex) ? parsedIndex : 0;
  const source = getRun(workflowId).getReadable<ChatProgressEvent>({ startIndex });
  const encoder = new TextEncoder();
  let nextIndex = startIndex;
  const body = source.pipeThrough(
    new TransformStream<ChatProgressEvent, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(
          encoder.encode(`id: ${nextIndex}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`),
        );
        nextIndex += 1;
      },
    }),
  );

  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
