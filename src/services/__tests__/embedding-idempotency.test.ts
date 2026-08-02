import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import {
  awaitPendingEmbeddingShadowWrites,
  hashEmbeddingInput,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import { upsertProjectFactEmbedding } from "@/src/services/knowledge-embedding-service";

describe("embedding write idempotency", () => {
  const activeIndex = {
    id: "legacy-bedrock-titan-v2-512",
    key: "legacy-bedrock-titan-v2-512",
    provider: "mock",
    modelId: "mock-workbase-embed-v1",
    dimensions: 512,
    status: "active",
    writeEnabled: true,
    baseActivationEpoch: 0,
    qualityGatePassed: true,
    activationEpoch: 0,
    writeSetEpoch: 0,
    isActive: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$transaction.mockImplementation(async (task) => task(prismaMock));
  });

  it("does not regenerate or rewrite an unchanged Highlight embedding", async () => {
    const inputText = "Durable project chat with citation-backed answers.";
    prismaMock.$queryRaw
      .mockResolvedValueOnce([activeIndex])
      .mockResolvedValueOnce([{
        indexVersionId: activeIndex.id,
        inputHash: hashEmbeddingInput(inputText),
        modelId: activeIndex.modelId,
        dimensions: 512,
      }]);

    const result = await upsertHighlightEmbedding({ highlightId: "highlight-1", inputText });

    expect(result).toMatchObject({ reused: true, inputHash: hashEmbeddingInput(inputText) });
    expect(result.vector).toBeNull();
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("persists a changed Project Fact embedding", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([activeIndex])
      .mockResolvedValueOnce([{
        indexVersionId: activeIndex.id,
        inputHash: hashEmbeddingInput("older statement"),
        modelId: activeIndex.modelId,
        dimensions: 512,
      }])
      .mockResolvedValueOnce([{ writeSetEpoch: 0 }]);

    const result = await upsertProjectFactEmbedding({
      projectFactId: "fact-1",
      inputText: "Current statement with materially different implementation detail.",
    });

    expect(result.reused).toBe(false);
    expect(result.vector).toHaveLength(512);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("writes a missing building version without rewriting the fresh active version", async () => {
    const inputText = "Citation-backed semantic retrieval.";
    const candidate = {
      ...activeIndex,
      id: "openrouter-small-512",
      key: "openrouter-small-512",
      provider: "mock",
      modelId: "mock-workbase-shadow-v2",
      status: "building",
      qualityGatePassed: false,
      isActive: false,
    };
    prismaMock.$queryRaw
      .mockResolvedValueOnce([activeIndex, candidate])
      .mockResolvedValueOnce([{
        indexVersionId: activeIndex.id,
        inputHash: hashEmbeddingInput(inputText),
        modelId: activeIndex.modelId,
        dimensions: 512,
      }])
      .mockResolvedValueOnce([{ writeSetEpoch: 0 }]);

    const result = await upsertHighlightEmbedding({
      highlightId: "highlight-1",
      inputText,
    });
    await awaitPendingEmbeddingShadowWrites();

    expect(result.reused).toBe(true);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("persists a stale active vector even when an OpenRouter shadow is unavailable", async () => {
    const priorKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const candidate = {
      ...activeIndex,
      id: "openrouter-small-512",
      key: "openrouter-small-512",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      status: "building",
      qualityGatePassed: false,
      isActive: false,
    };
    prismaMock.$queryRaw
      .mockResolvedValueOnce([activeIndex, candidate])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ writeSetEpoch: 0 }]);

    try {
      const result = await upsertHighlightEmbedding({
        highlightId: "highlight-1",
        inputText: "The active write must survive a shadow outage.",
      });
      await awaitPendingEmbeddingShadowWrites();

      expect(result).toMatchObject({ id: activeIndex.id, reused: false });
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
      const statements = prismaMock.$executeRaw.mock.calls
        .map((call) => call[0].join(""))
        .join("\n");
      expect(statements).toContain('UPDATE "EmbeddingIndexVersion"');
      expect(statements).toContain('INSERT INTO "HighlightEmbedding"');
      expect(statements).not.toContain(candidate.modelId);
    } finally {
      if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = priorKey;
    }
  });

  it("commits and returns the active write while a shadow request remains pending", async () => {
    const priorKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "private-test-key";
    let resolveShadow!: (response: Response) => void;
    const shadowResponse = new Promise<Response>((resolve) => {
      resolveShadow = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => shadowResponse));
    const candidate = {
      ...activeIndex,
      id: "openrouter-pending-512",
      key: "openrouter-pending-512",
      provider: "openrouter",
      modelId: "openai/text-embedding-3-small",
      status: "building",
      qualityGatePassed: false,
      isActive: false,
    };
    prismaMock.$queryRaw
      .mockResolvedValueOnce([activeIndex, candidate])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ writeSetEpoch: 0 }]);

    try {
      const operation = upsertHighlightEmbedding({
        highlightId: "highlight-pending",
        inputText: "Commit active before a slow shadow.",
      });
      const result = await Promise.race([
        operation,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("active write waited for shadow")), 100)
        ),
      ]);

      expect(result).toMatchObject({ id: activeIndex.id, reused: false });
      expect(prismaMock.$executeRaw).toHaveBeenCalledOnce();
      expect(prismaMock.$executeRaw.mock.calls[0][0].join("")).toContain(
        'INSERT INTO "HighlightEmbedding"',
      );

      resolveShadow(new Response(JSON.stringify({
        data: [{
          embedding: Array.from({ length: 512 }, (_, index) => index ? 0 : 1),
        }],
      }), { status: 200 }));
      await awaitPendingEmbeddingShadowWrites();
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = priorKey;
    }
  });
});
