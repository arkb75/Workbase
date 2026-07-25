import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  source: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  gitHubWebhookDelivery: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
const ensureWebhookMock = vi.hoisted(() => vi.fn());
const getTokenMock = vi.hoisted(() => vi.fn());
const startRefreshMock = vi.hoisted(() => vi.fn());
const resolveRegistrationConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/github-config", () => ({
  resolveGitHubWebhookRegistrationConfig: resolveRegistrationConfigMock,
}));
vi.mock("@/src/services/github-client", () => ({
  ensureGitHubRepositoryPushWebhook: ensureWebhookMock,
  getGitHubAccessTokenForUser: getTokenMock,
}));
vi.mock("@/src/services/repository-knowledge-refresh-application-service", () => ({
  repositoryKnowledgeRefreshApplicationService: { start: startRefreshMock },
}));

import {
  configureAttachedRepositoryPushWebhook,
  configureRepositoryPushWebhook,
  maintainGitHubWebhookDeliveries,
  processGitHubPushDelivery,
  verifyGitHubWebhookSignature,
} from "@/src/services/github-webhook-service";

const payload = {
  ref: "refs/heads/main",
  after: "a".repeat(40),
  deleted: false,
  repository: {
    id: "repo-1",
    full_name: "workbase/demo",
    default_branch: "main",
  },
};

describe("GitHub webhook service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRegistrationConfigMock.mockReturnValue({
      configured: true,
      callbackUrl: "https://workbase.example/api/github/webhook",
      secret: "s".repeat(32),
      configurationFingerprint: "fingerprint-1",
    });
    prismaMock.$transaction.mockImplementation(async (operations: unknown[]) =>
      Promise.all(operations)
    );
    prismaMock.source.findMany.mockResolvedValue([{
      id: "source-1",
      workItemId: "work-item-1",
      workItem: { userId: "user-1" },
    }]);
    prismaMock.gitHubWebhookDelivery.upsert.mockResolvedValue({
      id: "delivery-row-1",
      status: "received",
      refreshRunId: null,
    });
    prismaMock.gitHubWebhookDelivery.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.gitHubWebhookDelivery.update.mockResolvedValue({});
    prismaMock.gitHubWebhookDelivery.deleteMany.mockResolvedValue({ count: 0 });
    startRefreshMock.mockResolvedValue({
      runId: "refresh-1",
      workflowId: "workflow-1",
      status: "queued",
    });
  });

  it("matches GitHub's published HMAC-SHA256 validation vector", () => {
    expect(verifyGitHubWebhookSignature({
      secret: "It's a Secret to Everybody",
      payload: "Hello, World!",
      signature:
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    })).toBe(true);
    expect(verifyGitHubWebhookSignature({
      secret: "It's a Secret to Everybody",
      payload: "Hello, World?",
      signature:
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    })).toBe(false);
  });

  it("configures a push-only repository webhook without exposing its secret", async () => {
    ensureWebhookMock.mockResolvedValue({ hookId: "42", created: true });

    await expect(configureRepositoryPushWebhook({
      token: "github-token",
      owner: "workbase",
      repo: "demo",
    })).resolves.toMatchObject({
      status: "configured",
      hookId: "42",
      created: true,
      configurationFingerprint: "fingerprint-1",
    });
    expect(ensureWebhookMock).toHaveBeenCalledWith({
      token: "github-token",
      owner: "workbase",
      repo: "demo",
      callbackUrl: "https://workbase.example/api/github/webhook",
      secret: "s".repeat(32),
    });
  });

  it("queues one durable refresh for an attached project", async () => {
    const result = await processGitHubPushDelivery({
      deliveryId: "delivery-1",
      payload,
    });

    expect(result).toMatchObject({
      attachedProjects: 1,
      queued: 1,
      deduplicated: 0,
      failed: 0,
    });
    expect(startRefreshMock).toHaveBeenCalledWith({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "webhook_push",
      idempotencyKey:
        `github-push:delivery-1:source-1:${"a".repeat(40)}`,
    });
    expect(prismaMock.gitHubWebhookDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-row-1" },
      data: expect.objectContaining({
        status: "queued",
        refreshRunId: "refresh-1",
      }),
    });
  });

  it("deduplicates a redelivery without starting another workflow", async () => {
    prismaMock.gitHubWebhookDelivery.upsert.mockResolvedValue({
      id: "delivery-row-1",
      status: "queued",
      refreshRunId: "refresh-existing",
    });

    await expect(processGitHubPushDelivery({
      deliveryId: "delivery-1",
      payload,
    })).resolves.toMatchObject({ queued: 0, deduplicated: 1, failed: 0 });
    expect(startRefreshMock).not.toHaveBeenCalled();
    expect(prismaMock.gitHubWebhookDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("allows a failed delivery to be claimed again while same-head refresh coalescing remains authoritative", async () => {
    prismaMock.gitHubWebhookDelivery.upsert.mockResolvedValue({
      id: "delivery-row-1",
      status: "failed",
      refreshRunId: null,
    });

    await processGitHubPushDelivery({ deliveryId: "delivery-1", payload });

    expect(prismaMock.gitHubWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "delivery-row-1",
          OR: expect.arrayContaining([{ status: "failed" }]),
        }),
      }),
    );
    expect(startRefreshMock).toHaveBeenCalledOnce();
  });

  it("records a sanitized failure and leaves the delivery retryable", async () => {
    startRefreshMock.mockRejectedValue(new Error("GitHub API request failed (403) token=secret"));

    await expect(processGitHubPushDelivery({
      deliveryId: "delivery-1",
      payload,
    })).resolves.toMatchObject({ queued: 0, failed: 1 });
    expect(prismaMock.gitHubWebhookDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-row-1" },
      data: expect.objectContaining({
        status: "failed",
        error: { code: "repository_provider_unavailable" },
      }),
    });
  });

  it("backfills webhook registration for an already attached repository", async () => {
    prismaMock.source.findFirst.mockResolvedValue({
      id: "source-1",
      label: "workbase/demo",
      metadata: {
        repository: { owner: "workbase", name: "demo" },
        status: "imported",
      },
    });
    prismaMock.source.update.mockResolvedValue({});
    getTokenMock.mockResolvedValue("github-token");
    ensureWebhookMock.mockResolvedValue({ hookId: "42", created: false });

    await expect(configureAttachedRepositoryPushWebhook({
      userId: "user-1",
      sourceId: "source-1",
    })).resolves.toMatchObject({ status: "configured", hookId: "42" });
    expect(prismaMock.source.update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: {
        metadata: expect.objectContaining({
          status: "imported",
          webhook: expect.objectContaining({ status: "configured" }),
        }),
      },
    });
  });

  it("uses constant-time digest comparison for arbitrary valid signatures", () => {
    const body = JSON.stringify(payload);
    const secret = "q".repeat(32);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGitHubWebhookSignature({ secret, payload: body, signature })).toBe(true);
  });

  it("releases abandoned delivery claims and bounds the delivery audit trail", async () => {
    prismaMock.gitHubWebhookDelivery.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.gitHubWebhookDelivery.deleteMany.mockResolvedValue({ count: 7 });
    const now = new Date("2026-07-25T12:00:00.000Z");

    await expect(maintainGitHubWebhookDeliveries(now)).resolves.toEqual({
      released: 2,
      purged: 7,
    });
    expect(prismaMock.gitHubWebhookDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        status: "processing",
        processingStartedAt: {
          lt: new Date("2026-07-25T11:58:00.000Z"),
        },
      },
      data: {
        status: "failed",
        processedAt: now,
        error: { code: "processing_lease_expired" },
      },
    });
    expect(prismaMock.gitHubWebhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: expect.arrayContaining([
          expect.objectContaining({ status: { in: ["queued", "ignored"] } }),
          expect.objectContaining({ status: "failed" }),
        ]),
      },
    });
  });
});
