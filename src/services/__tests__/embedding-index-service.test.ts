import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import {
  activateEmbeddingIndex,
  EmbeddingWriteFenceChangedError,
  persistBackfillEmbeddingRecord,
  reconcileEmbeddingIndex,
  registerEmbeddingIndexCandidate,
  resolveEmbeddingWriteSet,
  runFencedEmbeddingWrite,
} from "@/src/services/embedding-index-service";

const active = {
  id: "legacy-titan",
  key: "legacy-titan",
  provider: "bedrock" as const,
  modelId: "amazon.titan-embed-text-v2:0",
  dimensions: 512,
  status: "active" as const,
  writeEnabled: true,
  baseActivationEpoch: 0,
  qualityGatePassed: true,
  activationEpoch: 2,
  writeSetEpoch: 4,
  isActive: true,
};

const candidate = {
  ...active,
  id: "openrouter-small",
  key: "openrouter-small",
  provider: "openrouter" as const,
  modelId: "openai/text-embedding-3-small",
  status: "building" as const,
  qualityGatePassed: false,
  isActive: false,
};

describe("versioned embedding index lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$transaction.mockImplementation(async (task) => task(prismaMock));
  });

  it("resolves one active vector space and all enabled build targets", async () => {
    prismaMock.$queryRaw.mockResolvedValue([active, candidate]);

    await expect(resolveEmbeddingWriteSet()).resolves.toEqual({
      active: expect.objectContaining({ id: active.id, status: "active" }),
      targets: [
        expect.objectContaining({ id: active.id }),
        expect.objectContaining({ id: candidate.id, status: "building" }),
      ],
      activationEpoch: 2,
      writeSetEpoch: 4,
    });
  });

  it("registers the same model identity idempotently", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ activationEpoch: 2, writeSetEpoch: 4 }])
      .mockResolvedValueOnce([candidate]);

    const result = await registerEmbeddingIndexCandidate({
      key: candidate.key,
      provider: "openrouter",
      modelId: candidate.modelId,
    });

    expect(result).toMatchObject({
      registered: false,
      version: { id: candidate.id, modelId: candidate.modelId },
    });
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("enforces the configured registration write-target limit", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ activationEpoch: 2, writeSetEpoch: 4 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 3 }]);

    await expect(registerEmbeddingIndexCandidate({
      key: "fourth-index",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-large",
    })).rejects.toThrow("target limit");
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects a stale application write fence", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ writeSetEpoch: 5 }]);

    await expect(runFencedEmbeddingWrite({
      expectedWriteSetEpoch: 4,
      write: vi.fn(),
    })).rejects.toBeInstanceOf(EmbeddingWriteFenceChangedError);
  });

  it("rejects a late backfill write after activation changes the write-set epoch", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ writeSetEpoch: 5 }]);

    await expect(persistBackfillEmbeddingRecord({
      writeSet: {
        active,
        targets: [active, candidate],
        activationEpoch: 2,
        writeSetEpoch: 4,
      },
      target: candidate,
      kind: "projectFact",
      entityId: "fact-1",
      embedding: {
        id: candidate.id,
        key: candidate.key,
        provider: "openrouter",
        modelId: candidate.modelId,
        dimensions: 512,
        inputHash: "hash",
        inputText: "stale backfill",
        vector: Array.from({ length: 512 }, () => 0),
        usage: { inputTokens: 2, totalTokens: 2, costUsd: 0.000001 },
      },
    })).rejects.toBeInstanceOf(EmbeddingWriteFenceChangedError);
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("will not activate a candidate before its quality gate passes", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ activeVersionId: active.id, activationEpoch: 2 }])
      .mockResolvedValueOnce([{
        ...candidate,
        status: "ready",
        baseActivationEpoch: 2,
        qualityGatePassed: false,
      }]);

    await expect(activateEmbeddingIndex({
      key: candidate.key,
      expectedActivationEpoch: 2,
    })).rejects.toThrow("quality gate");
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("marks a structurally complete candidate ready at the current epoch", async () => {
    const complete = {
      activeRows: 4,
      candidateRows: 4,
      missingRows: 0,
      hashMismatches: 0,
    };
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ activeVersionId: active.id, activationEpoch: 2 }])
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([complete])
      .mockResolvedValueOnce([complete])
      .mockResolvedValueOnce([complete])
      .mockResolvedValueOnce([complete]);

    const result = await reconcileEmbeddingIndex({ key: candidate.key });

    expect(result).toMatchObject({ complete: true, activationEpoch: 2 });
    expect(prismaMock.$executeRaw).toHaveBeenCalledOnce();
    expect(prismaMock.$executeRaw.mock.calls[0][0].join("")).toContain(
      '"status" = ',
    );
  });

  it("rejects activation when the expected epoch is stale", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ activeVersionId: active.id, activationEpoch: 3 }]);

    await expect(activateEmbeddingIndex({
      key: candidate.key,
      expectedActivationEpoch: 2,
    })).rejects.toThrow("changed from 2 to 3");
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("rechecks corpus parity under the activation lock", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ activeVersionId: active.id, activationEpoch: 2 }])
      .mockResolvedValueOnce([{
        ...candidate,
        status: "ready",
        baseActivationEpoch: 2,
        qualityGatePassed: true,
      }])
      .mockResolvedValueOnce([{
        activeRows: 4,
        candidateRows: 3,
        missingRows: 1,
        hashMismatches: 0,
      }])
      .mockResolvedValueOnce([{
        activeRows: 4,
        candidateRows: 4,
        missingRows: 0,
        hashMismatches: 0,
      }])
      .mockResolvedValueOnce([{
        activeRows: 4,
        candidateRows: 4,
        missingRows: 0,
        hashMismatches: 0,
      }])
      .mockResolvedValueOnce([{
        activeRows: 4,
        candidateRows: 4,
        missingRows: 0,
        hashMismatches: 0,
      }]);

    await expect(activateEmbeddingIndex({
      key: candidate.key,
      expectedActivationEpoch: 2,
    })).rejects.toThrow("changed after reconciliation");
    expect(prismaMock.$executeRaw).toHaveBeenCalledOnce();
  });

  it("atomically activates a fully gated version and leaves the previous index rollback-eligible", async () => {
    const complete = {
      activeRows: 4,
      candidateRows: 4,
      missingRows: 0,
      hashMismatches: 0,
    };
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce([{ activeVersionId: active.id, activationEpoch: 2 }])
      .mockResolvedValueOnce([{
        ...candidate,
        status: "ready",
        baseActivationEpoch: 2,
        qualityGatePassed: true,
      }])
      .mockResolvedValueOnce([complete])
      .mockResolvedValueOnce([complete])
      .mockResolvedValueOnce([complete])
      .mockResolvedValueOnce([complete]);

    const result = await activateEmbeddingIndex({
      key: candidate.key,
      expectedActivationEpoch: 2,
    });

    expect(result).toMatchObject({
      previousActiveVersionId: active.id,
      activeVersionId: candidate.id,
      activationEpoch: 3,
    });
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(3);
    const previousVersionUpdate = prismaMock.$executeRaw.mock.calls[0][0].join("");
    const targetVersionUpdate = prismaMock.$executeRaw.mock.calls[1][0].join("");
    const controlUpdate = prismaMock.$executeRaw.mock.calls[2][0].join("");
    expect(previousVersionUpdate).toContain('"status" = \'ready\'');
    expect(previousVersionUpdate).not.toContain('"writeEnabled" = false');
    expect(targetVersionUpdate).toContain('"writeEnabled" = true');
    expect(controlUpdate).toContain('"writeSetEpoch" = "writeSetEpoch" + 1');

    prismaMock.$queryRaw.mockReset().mockResolvedValue([{ writeSetEpoch: 5 }]);
    await expect(runFencedEmbeddingWrite({
      expectedWriteSetEpoch: 4,
      write: vi.fn(),
    })).rejects.toBeInstanceOf(EmbeddingWriteFenceChangedError);
  });
});
