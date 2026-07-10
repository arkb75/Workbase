import { getRun } from "workflow/api";
import type { ChatProgressEvent } from "@/src/domain/project-chat";
import { getDemoUser } from "@/src/lib/demo-user";
import { prisma } from "@/src/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getDemoUser();
  const agentRun = await prisma.agentRun.findFirst({
    where: { id, userId: user.id },
    select: { workflowId: true },
  });

  if (!agentRun?.workflowId) {
    return Response.json({ error: "Agent run not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  const lastEventId = request.headers.get("last-event-id");
  const rawIndex = url.searchParams.get("startIndex");
  const parsedIndex = lastEventId
    ? Number.parseInt(lastEventId, 10) + 1
    : rawIndex == null
      ? 0
      : Number.parseInt(rawIndex, 10);
  const startIndex = Number.isFinite(parsedIndex) ? parsedIndex : 0;
  const source = getRun(agentRun.workflowId).getReadable<ChatProgressEvent>({ startIndex });
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
