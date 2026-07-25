import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  workItem: { findMany: vi.fn() },
  knowledgeRefreshRun: { findFirst: vi.fn() },
}));
const configureAttachedMock = vi.hoisted(() => vi.fn());
const maintainDeliveriesMock = vi.hoisted(() => vi.fn());
const startRefreshMock = vi.hoisted(() => vi.fn());
const resolveTargetsMock = vi.hoisted(() => vi.fn());
const purgeEvidenceMock = vi.hoisted(() => vi.fn());
const resolveWebhookConfigMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/github-config", () => ({
  resolveGitHubWebhookRegistrationConfig: resolveWebhookConfigMock,
}));
vi.mock("@/src/services/github-webhook-service", () => ({
  githubWebhookService: {
    configureAttachedRepository: configureAttachedMock,
    maintainDeliveries: maintainDeliveriesMock,
  },
}));
vi.mock("@/src/services/repository-knowledge-refresh-application-service", () => ({
  repositoryKnowledgeRefreshApplicationService: { start: startRefreshMock },
}));
vi.mock("@/src/services/repository-knowledge-sync-service", () => ({
  repositoryKnowledgeSyncService: { resolveTargetHeads: resolveTargetsMock },
}));
vi.mock("@/src/services/knowledge-review-service", () => ({
  knowledgeReviewService: { purgeExpiredEvidence: purgeEvidenceMock },
}));

import { GET } from "@/app/api/cron/repository-knowledge/route";

const target = {
  sourceId: "source-1",
  repository: "workbase/demo",
  branch: "main",
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  committedAt: "2026-07-25T10:00:00.000Z",
  resolvedAt: "2026-07-25T10:01:00.000Z",
};

function cronRequest(secret = "cron-secret") {
  return new NextRequest("https://workbase.example/api/cron/repository-knowledge", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe("repository knowledge cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret";
    resolveWebhookConfigMock.mockReturnValue({
      configured: true,
      configurationFingerprint: "fingerprint-1",
    });
    prismaMock.workItem.findMany.mockResolvedValue([{
      id: "work-item-1",
      userId: "user-1",
      sources: [{
        id: "source-1",
        metadata: {
          webhook: {
            status: "configured",
            configurationFingerprint: "fingerprint-1",
            configuredAt: new Date().toISOString(),
          },
        },
      }],
    }]);
    resolveTargetsMock.mockResolvedValue([target]);
    prismaMock.knowledgeRefreshRun.findFirst.mockResolvedValue({
      completedHeads: [target],
    });
    configureAttachedMock.mockResolvedValue({
      status: "configured",
      hookId: "42",
      created: true,
      configuredAt: "2026-07-25T10:02:00.000Z",
      configurationFingerprint: "fingerprint-1",
    });
    maintainDeliveriesMock.mockResolvedValue({ released: 0, purged: 0 });
    purgeEvidenceMock.mockResolvedValue([]);
    startRefreshMock.mockResolvedValue({
      runId: "refresh-1",
      workflowId: "workflow-1",
      status: "queued",
    });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("rejects unauthenticated maintenance requests", async () => {
    const response = await GET(cronRequest("wrong"));
    expect(response.status).toBe(401);
    expect(prismaMock.workItem.findMany).not.toHaveBeenCalled();
  });

  it("does no GitHub or model work when hook configuration and repository heads are current", async () => {
    const response = await GET(cronRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      unchanged: ["work-item-1"],
      queued: [],
      webhookRegistrations: [],
      webhookDeliveryMaintenance: { released: 0, purged: 0 },
    });
    expect(configureAttachedMock).not.toHaveBeenCalled();
    expect(startRefreshMock).not.toHaveBeenCalled();
  });

  it("backfills a missing hook and queues only when the immutable head changed", async () => {
    prismaMock.workItem.findMany.mockResolvedValue([{
      id: "work-item-1",
      userId: "user-1",
      sources: [{ id: "source-1", metadata: { status: "imported" } }],
    }]);
    prismaMock.knowledgeRefreshRun.findFirst.mockResolvedValue({
      completedHeads: [{ ...target, commitSha: "c".repeat(40) }],
    });

    const response = await GET(cronRequest());
    expect(response.status).toBe(200);
    expect(configureAttachedMock).toHaveBeenCalledWith({
      userId: "user-1",
      sourceId: "source-1",
    });
    expect(startRefreshMock).toHaveBeenCalledWith({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "scheduled",
      idempotencyKey: expect.stringMatching(/^scheduled:/),
    });
    expect(await response.json()).toMatchObject({
      queued: ["refresh-1"],
      webhookRegistrations: [{
        sourceId: "source-1",
        status: "configured",
      }],
    });
  });

  it("backs off permission failures for a day while retaining scheduled freshness checks", async () => {
    prismaMock.workItem.findMany.mockResolvedValue([{
      id: "work-item-1",
      userId: "user-1",
      sources: [{
        id: "source-1",
        metadata: {
          webhook: {
            status: "unavailable",
            reasonCode: "repository_admin_permission_required",
            configurationFingerprint: "fingerprint-1",
            checkedAt: new Date().toISOString(),
          },
        },
      }],
    }]);

    await GET(cronRequest());

    expect(configureAttachedMock).not.toHaveBeenCalled();
    expect(resolveTargetsMock).toHaveBeenCalledOnce();
  });

  it("renews configured hooks weekly so deleted hooks and rotated settings recover", async () => {
    prismaMock.workItem.findMany.mockResolvedValue([{
      id: "work-item-1",
      userId: "user-1",
      sources: [{
        id: "source-1",
        metadata: {
          webhook: {
            status: "configured",
            configurationFingerprint: "fingerprint-1",
            configuredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
          },
        },
      }],
    }]);

    await GET(cronRequest());

    expect(configureAttachedMock).toHaveBeenCalledOnce();
    expect(startRefreshMock).not.toHaveBeenCalled();
  });

  it("never lets optional hook registration block the scheduled freshness safety net", async () => {
    prismaMock.workItem.findMany.mockResolvedValue([{
      id: "work-item-1",
      userId: "user-1",
      sources: [{ id: "source-1", metadata: { status: "imported" } }],
    }]);
    configureAttachedMock.mockRejectedValue(new Error("GitHub hook API unavailable"));
    prismaMock.knowledgeRefreshRun.findFirst.mockResolvedValue({
      completedHeads: [{ ...target, commitSha: "c".repeat(40) }],
    });

    const response = await GET(cronRequest());

    expect(resolveTargetsMock).toHaveBeenCalledOnce();
    expect(startRefreshMock).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      queued: ["refresh-1"],
      webhookRegistrations: [{
        sourceId: "source-1",
        status: "unavailable",
        reasonCode: "registration_attempt_failed",
      }],
    });
  });
});
