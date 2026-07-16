import { beforeEach, describe, expect, it, vi } from "vitest";

const target = {
  sourceId: "source-1",
  repository: "workbase/demo",
  branch: "main",
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  committedAt: "2026-07-16T10:00:00.000Z",
  resolvedAt: "2026-07-16T10:01:00.000Z",
};

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  workItem: {
    findFirst: vi.fn(),
  },
  knowledgeRefreshRun: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const resolveTargetHeadsMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveBedrockConfig: () => ({ modelId: "us.anthropic.claude-sonnet-4-6" }),
  resolveWorkbaseLlmProvider: () => "mock",
}));
vi.mock("@/src/services/repository-knowledge-sync-service", () => ({
  REPOSITORY_SEMANTIC_ANALYZER_VERSION: "repository-coverage-v14",
  REPOSITORY_STATIC_ANALYZER_VERSION: "repository-coverage-v14",
  repositoryKnowledgeSyncService: {
    resolveTargetHeads: resolveTargetHeadsMock,
  },
}));

import { startKnowledgeRefresh } from "@/src/services/knowledge-refresh-service";

describe("knowledge refresh start coalescing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (
      operation: (client: typeof prismaMock) => Promise<unknown>,
    ) => operation(prismaMock));
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.workItem.findFirst.mockResolvedValue({ id: "work-item-1" });
    resolveTargetHeadsMock.mockResolvedValue([target]);
    prismaMock.knowledgeRefreshRun.findMany.mockResolvedValue([]);
    prismaMock.knowledgeRefreshRun.findFirst.mockResolvedValue(null);
    prismaMock.knowledgeRefreshRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.knowledgeRefreshRun.upsert.mockImplementation(async ({ create }: {
      create: { idempotencyKey: string; trigger: string };
    }) => ({
      id: "refresh-created",
      status: "queued",
      idempotencyKey: create.idempotencyKey,
      trigger: create.trigger,
      createdAt: new Date("2026-07-16T10:03:00.000Z"),
    }));
  });

  it("returns an active same-head policy run across ordinary trigger surfaces", async () => {
    prismaMock.knowledgeRefreshRun.findMany.mockResolvedValue([{
      id: "refresh-active",
      status: "semantic_analysis",
      targetHeads: [target],
      completedHeads: null,
      qualityStatus: "pending",
      warnings: null,
      finishedAt: null,
      createdAt: new Date("2026-07-16T10:02:00.000Z"),
    }]);

    await expect(startKnowledgeRefresh({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "scheduled",
      idempotencyKey: "scheduled:requested",
    })).resolves.toMatchObject({
      runId: "refresh-active",
      status: "semantic_analysis",
      coalesced: true,
    });
    expect(prismaMock.knowledgeRefreshRun.upsert).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeRefreshRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: {
        id: true,
        status: true,
        targetHeads: true,
        completedHeads: true,
        qualityStatus: true,
        warnings: true,
        finishedAt: true,
        createdAt: true,
      },
    }));
  });

  it("acquires the work-item generation lock before selecting an active run", async () => {
    const order: string[] = [];
    prismaMock.$queryRaw.mockImplementation(async () => {
      order.push("lock");
      return [{ locked: 1 }];
    });
    prismaMock.knowledgeRefreshRun.findMany.mockImplementation(async ({ where }: {
      where: { idempotencyKey?: unknown };
    }) => {
      order.push(where.idempotencyKey ? "policy-runs" : "active-runs");
      return [];
    });

    await startKnowledgeRefresh({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "manual",
      idempotencyKey: "manual:locked",
    });

    expect(order[0]).toBe("lock");
    expect(order).toContain("policy-runs");
    expect(order).toContain("active-runs");
    expect(prismaMock.knowledgeRefreshRun.upsert).toHaveBeenCalledOnce();
  });

  it("uses one deterministic first-attempt key for attach, manual, scheduled, and chat races", async () => {
    for (const [trigger, idempotencyKey] of [
      ["repository_attach", "attach:requested"],
      ["scheduled", "scheduled:requested"],
      ["manual", "manual:requested"],
      ["chat_freshness", "agent-run:requested"],
    ] as const) {
      await startKnowledgeRefresh({
        userId: "user-1",
        workItemId: "work-item-1",
        trigger,
        idempotencyKey,
      });
    }

    const keys = prismaMock.knowledgeRefreshRun.upsert.mock.calls.map(
      ([input]) => input.create.idempotencyKey as string,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(
      /^repository_heads:[a-f0-9]{64}:after:initial:policy:[a-f0-9]{16}$/,
    );
  });

  it("coalesces concurrent retries behind the same terminal predecessor", async () => {
    const failedRun = {
      id: "refresh-failed",
      status: "failed",
      targetHeads: [target],
      completedHeads: null,
      qualityStatus: "failed",
      warnings: null,
      finishedAt: new Date("2026-07-16T10:05:00.000Z"),
      createdAt: new Date("2026-07-16T10:02:00.000Z"),
    };
    prismaMock.knowledgeRefreshRun.findMany.mockImplementation(async ({ where }: {
      where: { idempotencyKey?: unknown };
    }) => where.idempotencyKey ? [failedRun] : []);

    await startKnowledgeRefresh({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "manual",
      idempotencyKey: "manual:first",
    });
    await startKnowledgeRefresh({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "scheduled",
      idempotencyKey: "scheduled:first",
    });

    const keys = prismaMock.knowledgeRefreshRun.upsert.mock.calls.map(
      ([input]) => input.create.idempotencyKey as string,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(":after:refresh-failed:policy:");
  });

  it("keeps explicit backfills isolated from ordinary active refreshes", async () => {
    await startKnowledgeRefresh({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "backfill",
      idempotencyKey: "knowledge-edit:fact-1:first",
    });
    await startKnowledgeRefresh({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "backfill",
      idempotencyKey: "knowledge-edit:fact-1:second",
    });

    const keys = prismaMock.knowledgeRefreshRun.upsert.mock.calls.map(
      ([input]) => input.create.idempotencyKey as string,
    );
    expect(keys[0]).toMatch(/^knowledge-edit:fact-1:first:policy:/);
    expect(keys[1]).toMatch(/^knowledge-edit:fact-1:second:policy:/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(prismaMock.knowledgeRefreshRun.findMany).toHaveBeenCalledTimes(4);
    expect(prismaMock.knowledgeRefreshRun.findMany.mock.calls.every(
      ([query]) => !query.where.idempotencyKey,
    )).toBe(true);
  });

  it("cancels an active older-head generation after creating a newer run", async () => {
    const olderTarget = {
      ...target,
      commitSha: "c".repeat(40),
      resolvedAt: "2026-07-16T09:55:00.000Z",
    };
    const olderRun = {
      id: "refresh-older",
      trigger: "chat_freshness",
      status: "analyzing",
      targetHeads: [olderTarget],
      createdAt: new Date("2026-07-16T09:56:00.000Z"),
    };
    prismaMock.knowledgeRefreshRun.findMany.mockImplementation(async ({ where }: {
      where: { status?: unknown };
    }) => where.status ? [olderRun] : []);

    await startKnowledgeRefresh({
      userId: "user-1",
      workItemId: "work-item-1",
      trigger: "manual",
      idempotencyKey: "manual:new-head",
    });

    expect(prismaMock.knowledgeRefreshRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["refresh-older"] },
        workItemId: "work-item-1",
        status: {
          in: [
            "queued",
            "inventorying",
            "analyzing",
            "routing",
            "semantic_analysis",
            "auditing",
            "reconciling",
          ],
        },
      },
      data: expect.objectContaining({
        status: "cancelled",
        error: {
          message: "Superseded by newer repository refresh refresh-created.",
        },
      }),
    });
  });
});
