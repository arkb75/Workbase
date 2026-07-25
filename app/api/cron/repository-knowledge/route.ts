import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/src/lib/prisma";
import { knowledgeReviewService } from "@/src/services/knowledge-review-service";
import { repositoryKnowledgeRefreshApplicationService } from "@/src/services/repository-knowledge-refresh-application-service";
import { repositoryKnowledgeSyncService } from "@/src/services/repository-knowledge-sync-service";
import { githubWebhookService } from "@/src/services/github-webhook-service";
import { resolveGitHubWebhookRegistrationConfig } from "@/src/lib/github-config";

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
    select: {
      id: true,
      userId: true,
      sources: {
        where: { type: "github_repo" },
        select: { id: true, metadata: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  const queued: string[] = [];
  const unchanged: string[] = [];
  const failures: Array<{ workItemId: string; message: string }> = [];
  const webhookRegistrations: Array<{
    sourceId: string;
    status: string;
    reasonCode?: string;
  }> = [];
  const webhookConfig = (() => {
    try {
      return resolveGitHubWebhookRegistrationConfig();
    } catch {
      return { configured: false as const };
    }
  })();
  for (const workItem of workItems) {
    try {
      for (const source of workItem.sources) {
        const metadata = source.metadata &&
            typeof source.metadata === "object" &&
            !Array.isArray(source.metadata)
          ? source.metadata as Record<string, unknown>
          : {};
        const webhook = metadata.webhook &&
            typeof metadata.webhook === "object" &&
            !Array.isArray(metadata.webhook)
          ? metadata.webhook as Record<string, unknown>
          : {};
        if (!webhookConfig.configured) continue;
        const configuredAt = typeof webhook.configuredAt === "string"
          ? new Date(webhook.configuredAt).getTime()
          : Number.NaN;
        const registrationStillFresh = Number.isFinite(configuredAt) &&
          Date.now() - configuredAt < 7 * 24 * 60 * 60 * 1_000;
        if (
          webhook.status === "configured" &&
          webhook.configurationFingerprint === webhookConfig.configurationFingerprint &&
          registrationStillFresh
        ) {
          continue;
        }
        const checkedAt = typeof webhook.checkedAt === "string"
          ? new Date(webhook.checkedAt).getTime()
          : Number.NaN;
        const retrySuppressed = webhook.status === "unavailable" &&
          webhook.configurationFingerprint === webhookConfig.configurationFingerprint &&
          Number.isFinite(checkedAt) &&
          Date.now() - checkedAt < 24 * 60 * 60 * 1_000;
        if (retrySuppressed) continue;
        try {
          const registration = await githubWebhookService.configureAttachedRepository({
            userId: workItem.userId,
            sourceId: source.id,
          });
          webhookRegistrations.push({
            sourceId: source.id,
            status: registration.status,
            ...("reasonCode" in registration
              ? { reasonCode: registration.reasonCode }
              : {}),
          });
        } catch {
          // Registration is an acceleration layer. The scheduled latest-head
          // check below remains the quality/freshness safety net and must run
          // even if GitHub hook administration or metadata persistence fails.
          webhookRegistrations.push({
            sourceId: source.id,
            status: "unavailable",
            reasonCode: "registration_attempt_failed",
          });
        }
      }
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
  const webhookDeliveryMaintenance =
    await githubWebhookService.maintainDeliveries();
  const purgedEvidenceIds = await knowledgeReviewService.purgeExpiredEvidence();
  return Response.json({
    ok: true,
    checked: workItems.length,
    queued,
    unchanged,
    failures,
    webhookRegistrations,
    webhookDeliveryMaintenance,
    purgedEvidenceIds,
  });
}
