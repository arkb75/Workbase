import { createHash } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import { knowledgeRefreshService } from "@/src/services/knowledge-refresh-service";
import { knowledgeReconciliationService } from "@/src/services/knowledge-reconciliation-service";
import { knowledgeStalenessService } from "@/src/services/knowledge-staleness-service";

async function main() {
  const workItems = await prisma.workItem.findMany({
    where: {
      ...(process.env.WORK_ITEM_ID ? { id: process.env.WORK_ITEM_ID } : {}),
      sources: { some: { type: "github_repo" } },
      user: { githubConnection: { isNot: null } },
    },
    select: { id: true, userId: true },
    orderBy: { createdAt: "asc" },
  });

  const queued = [];
  const failed: Array<{ workItemId: string; message: string }> = [];
  for (const workItem of workItems) {
    try {
      const idempotencyKey = `backfill:v6:${createHash("sha256").update(workItem.id).digest("hex").slice(0, 20)}`;
      const refresh = await knowledgeRefreshService.start({
        userId: workItem.userId,
        workItemId: workItem.id,
        trigger: "backfill",
        idempotencyKey,
      });
      if (refresh.status !== "completed") {
        await knowledgeRefreshService.inventory(refresh.runId);
        let remaining = 1;
        while (remaining > 0) {
          remaining = (await knowledgeRefreshService.analyzeBatch({ runId: refresh.runId, batchSize: 8 })).remaining;
        }
        await knowledgeRefreshService.finalizeCoverage(refresh.runId);
        const reconciled = await knowledgeReconciliationService.reconcile(refresh.runId);
        await knowledgeStalenessService.reconcile({
          runId: refresh.runId,
          appliedFactIds: reconciled.appliedFactIds,
          appliedHighlightIds: reconciled.appliedHighlightIds,
        });
        await knowledgeRefreshService.complete(refresh.runId);
      }
      queued.push({ ...refresh, status: "completed" });
    } catch (error) {
      failed.push({
        workItemId: workItem.id,
        message: error instanceof Error ? error.message : "Unknown backfill error.",
      });
    }
  }

  process.stdout.write(`${JSON.stringify({ queued: queued.length, failed: failed.length, refreshes: queued, failures: failed }, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
