import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { knowledgeReviewService } from "@/src/services/knowledge-review-service";
import { repositoryKnowledgeRefreshApplicationService } from "@/src/services/repository-knowledge-refresh-application-service";
import { repositoryKnowledgeSyncService } from "@/src/services/repository-knowledge-sync-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function headsKey(targets: Array<{ sourceId: string; commitSha: string }>) {
  return createHash("sha256")
    .update(targets.map((target) => `${target.sourceId}:${target.commitSha}`).join("|"))
    .digest("hex")
    .slice(0, 24);
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const workItems = await prisma.workItem.findMany({
    where: { sources: { some: { type: "github_repo" } }, user: { githubConnection: { isNot: null } } },
    select: { id: true, userId: true },
    orderBy: { updatedAt: "desc" },
  });
  const queued: string[] = [];
  const unchanged: string[] = [];
  const failures: Array<{ workItemId: string; message: string }> = [];
  for (const workItem of workItems) {
    try {
      const targets = await repositoryKnowledgeSyncService.resolveTargetHeads({ userId: workItem.userId, workItemId: workItem.id });
      const completed = await prisma.knowledgeRefreshRun.findFirst({
        where: { workItemId: workItem.id, status: "completed" },
        orderBy: { finishedAt: "desc" },
        select: { completedHeads: true },
      });
      const completedHeads = Array.isArray(completed?.completedHeads)
        ? completed.completedHeads.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
            const value = entry as Record<string, unknown>;
            return typeof value.sourceId === "string" && typeof value.commitSha === "string"
              ? [`${value.sourceId}:${value.commitSha}`]
              : [];
          })
        : [];
      const targetHeads = targets.map((target) => `${target.sourceId}:${target.commitSha}`);
      if (completedHeads.length === targetHeads.length && targetHeads.every((head) => completedHeads.includes(head))) {
        unchanged.push(workItem.id);
        continue;
      }
      const refresh = await repositoryKnowledgeRefreshApplicationService.start({
        userId: workItem.userId,
        workItemId: workItem.id,
        trigger: "scheduled",
        idempotencyKey: `scheduled:${headsKey(targets)}`,
      });
      queued.push(refresh.runId);
    } catch (error) {
      failures.push({ workItemId: workItem.id, message: error instanceof Error ? error.message : "unknown refresh error" });
    }
  }
  const purgedEvidenceIds = await knowledgeReviewService.purgeExpiredEvidence();
  return Response.json({ ok: true, checked: workItems.length, queued, unchanged, failures, purgedEvidenceIds });
}
