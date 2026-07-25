import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import { classifyWorkflowFailure } from "@/src/lib/error-message";
import { resolveGitHubWebhookRegistrationConfig } from "@/src/lib/github-config";
import { prisma } from "@/src/lib/prisma";
import {
  ensureGitHubRepositoryPushWebhook,
  getGitHubAccessTokenForUser,
} from "@/src/services/github-client";
import { repositoryKnowledgeRefreshApplicationService } from "@/src/services/repository-knowledge-refresh-application-service";

const WEBHOOK_PROCESSING_LEASE_MS = 2 * 60 * 1_000;
const WEBHOOK_TARGET_CONCURRENCY = 4;

type PushPayload = {
  ref: string;
  after: string;
  deleted: boolean;
  repository: {
    id: string;
    full_name: string;
    default_branch: string;
  };
};

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function webhookFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/\(401\)|bad credentials|requires authentication/i.test(message)) {
    return "github_authentication_failed";
  }
  if (/\(403\)|\(404\)|permission|not found/i.test(message)) {
    return "repository_admin_permission_required";
  }
  if (/rate limit/i.test(message)) return "github_rate_limited";
  if (/WORKBASE_GITHUB_WEBHOOK_URL|GITHUB_WEBHOOK_SECRET|HTTPS/i.test(message)) {
    return "webhook_configuration_invalid";
  }
  return "webhook_registration_failed";
}

export function verifyGitHubWebhookSignature(input: {
  secret: string;
  signature: string | null;
  payload: string;
}) {
  if (!input.signature?.startsWith("sha256=")) return false;
  const suppliedHex = input.signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = createHmac("sha256", input.secret)
    .update(input.payload, "utf8")
    .digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function configureRepositoryPushWebhook(input: {
  token: string;
  owner: string;
  repo: string;
}) {
  let configurationFingerprint: string | undefined;
  try {
    const config = resolveGitHubWebhookRegistrationConfig();
    if (!config.configured) {
      return {
        status: "not_configured" as const,
        reasonCode: "webhook_url_not_configured",
      };
    }
    configurationFingerprint = config.configurationFingerprint;
    const hook = await ensureGitHubRepositoryPushWebhook({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      callbackUrl: config.callbackUrl,
      secret: config.secret,
    });
    return {
      status: "configured" as const,
      hookId: hook.hookId,
      created: hook.created,
      configuredAt: new Date().toISOString(),
      configurationFingerprint,
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      reasonCode: webhookFailureCode(error),
      checkedAt: new Date().toISOString(),
      ...(configurationFingerprint ? { configurationFingerprint } : {}),
    };
  }
}

export async function configureAttachedRepositoryPushWebhook(input: {
  userId: string;
  sourceId: string;
}) {
  const source = await prisma.source.findFirst({
    where: {
      id: input.sourceId,
      type: "github_repo",
      workItem: { userId: input.userId },
    },
    select: {
      id: true,
      label: true,
      metadata: true,
    },
  });
  if (!source) {
    return {
      status: "unavailable" as const,
      reasonCode: "attached_repository_not_found",
      checkedAt: new Date().toISOString(),
    };
  }
  const metadata = source.metadata &&
      typeof source.metadata === "object" &&
      !Array.isArray(source.metadata)
    ? source.metadata as Record<string, unknown>
    : {};
  const repository = metadata.repository &&
      typeof metadata.repository === "object" &&
      !Array.isArray(metadata.repository)
    ? metadata.repository as Record<string, unknown>
    : {};
  const [labelOwner, labelRepo] = source.label.split("/");
  const owner = typeof repository.owner === "string" ? repository.owner : labelOwner;
  const repo = typeof repository.name === "string" ? repository.name : labelRepo;
  const token = await getGitHubAccessTokenForUser(input.userId);
  const registration = !token
    ? {
        status: "unavailable" as const,
        reasonCode: "github_authentication_failed",
        checkedAt: new Date().toISOString(),
      }
    : !owner || !repo
      ? {
          status: "unavailable" as const,
          reasonCode: "repository_identity_missing",
          checkedAt: new Date().toISOString(),
        }
      : await configureRepositoryPushWebhook({ token, owner, repo });
  await prisma.source.update({
    where: { id: source.id },
    data: {
      metadata: inputJson({
        ...metadata,
        webhook: registration,
      }),
    },
  });
  return registration;
}

async function processAttachedSource(input: {
  deliveryId: string;
  payload: PushPayload;
  source: {
    id: string;
    workItemId: string;
    workItem: { userId: string };
  };
}) {
  const delivery = await prisma.gitHubWebhookDelivery.upsert({
    where: {
      deliveryId_sourceId: {
        deliveryId: input.deliveryId,
        sourceId: input.source.id,
      },
    },
    create: {
      deliveryId: input.deliveryId,
      sourceId: input.source.id,
      workItemId: input.source.workItemId,
      event: "push",
      repositoryId: input.payload.repository.id,
      repositoryFullName: input.payload.repository.full_name,
      ref: input.payload.ref,
      afterSha: input.payload.after,
    },
    update: {},
    select: {
      id: true,
      status: true,
      refreshRunId: true,
    },
  });
  if (delivery.status === "queued") {
    return {
      status: "deduplicated" as const,
      deliveryRecordId: delivery.id,
      refreshRunId: delivery.refreshRunId,
    };
  }

  const now = new Date();
  const claimed = await prisma.gitHubWebhookDelivery.updateMany({
    where: {
      id: delivery.id,
      OR: [
        { status: "received" },
        { status: "failed" },
        {
          status: "processing",
          processingStartedAt: {
            lt: new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS),
          },
        },
      ],
    },
    data: {
      status: "processing",
      attemptCount: { increment: 1 },
      processingStartedAt: now,
      processedAt: null,
      error: Prisma.DbNull,
    },
  });
  if (!claimed.count) {
    const current = await prisma.gitHubWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { status: true, refreshRunId: true },
    });
    return {
      status: "deduplicated" as const,
      deliveryRecordId: delivery.id,
      refreshRunId: current.refreshRunId,
      deliveryStatus: current.status,
    };
  }

  try {
    const refresh = await repositoryKnowledgeRefreshApplicationService.start({
      userId: input.source.workItem.userId,
      workItemId: input.source.workItemId,
      trigger: "webhook_push",
      idempotencyKey:
        `github-push:${input.deliveryId}:${input.source.id}:${input.payload.after}`,
    });
    await prisma.gitHubWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "queued",
        refreshRunId: refresh.runId,
        processedAt: new Date(),
        error: Prisma.DbNull,
      },
    });
    return {
      status: "queued" as const,
      deliveryRecordId: delivery.id,
      refreshRunId: refresh.runId,
      workflowId: refresh.workflowId,
      refreshStatus: refresh.status,
    };
  } catch (error) {
    const code = classifyWorkflowFailure(error).code;
    await prisma.gitHubWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "failed",
        processedAt: new Date(),
        error: inputJson({ code }),
      },
    });
    return {
      status: "failed" as const,
      deliveryRecordId: delivery.id,
      code,
    };
  }
}

export async function processGitHubPushDelivery(input: {
  deliveryId: string;
  payload: PushPayload;
}) {
  const sources = await prisma.source.findMany({
    where: {
      type: "github_repo",
      externalId: input.payload.repository.id,
    },
    select: {
      id: true,
      workItemId: true,
      workItem: { select: { userId: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const results: Awaited<ReturnType<typeof processAttachedSource>>[] = [];
  for (let offset = 0; offset < sources.length; offset += WEBHOOK_TARGET_CONCURRENCY) {
    results.push(...await Promise.all(
      sources.slice(offset, offset + WEBHOOK_TARGET_CONCURRENCY).map((source) =>
        processAttachedSource({
          deliveryId: input.deliveryId,
          payload: input.payload,
          source,
        })
      ),
    ));
  }
  return {
    attachedProjects: sources.length,
    queued: results.filter((result) => result.status === "queued").length,
    deduplicated: results.filter((result) => result.status === "deduplicated").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

export async function maintainGitHubWebhookDeliveries(now = new Date()) {
  const staleProcessingBefore = new Date(now.getTime() - WEBHOOK_PROCESSING_LEASE_MS);
  const completedBefore = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
  const failedBefore = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000);
  const [released, purged] = await prisma.$transaction([
    prisma.gitHubWebhookDelivery.updateMany({
      where: {
        status: "processing",
        processingStartedAt: { lt: staleProcessingBefore },
      },
      data: {
        status: "failed",
        processedAt: now,
        error: inputJson({ code: "processing_lease_expired" }),
      },
    }),
    prisma.gitHubWebhookDelivery.deleteMany({
      where: {
        OR: [
          {
            status: { in: ["queued", "ignored"] },
            processedAt: { lt: completedBefore },
          },
          {
            status: "failed",
            processedAt: { lt: failedBefore },
          },
        ],
      },
    }),
  ]);
  return { released: released.count, purged: purged.count };
}

export const githubWebhookService = {
  configureRepository: configureRepositoryPushWebhook,
  configureAttachedRepository: configureAttachedRepositoryPushWebhook,
  processPush: processGitHubPushDelivery,
  maintainDeliveries: maintainGitHubWebhookDeliveries,
  verifySignature: verifyGitHubWebhookSignature,
};
