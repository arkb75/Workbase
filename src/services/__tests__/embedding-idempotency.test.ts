import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/lib/llm-config", () => ({
  resolveWorkbaseLlmProvider: () => "mock",
  resolveBedrockEmbeddingConfig: () => ({
    modelId: "mock-titan-embed-text-v2",
    dimensions: 512,
    normalize: true,
    region: "us-west-2",
    profile: undefined,
  }),
}));

import {
  hashEmbeddingInput,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import { upsertProjectFactEmbedding } from "@/src/services/knowledge-embedding-service";

describe("embedding write idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$executeRaw.mockResolvedValue(1);
  });

  it("does not regenerate or rewrite an unchanged Highlight embedding", async () => {
    const inputText = "Durable project chat with citation-backed answers.";
    prismaMock.$queryRaw.mockResolvedValue([{
      inputHash: hashEmbeddingInput(inputText),
      modelId: "mock-titan-embed-text-v2",
      dimensions: 512,
    }]);

    const result = await upsertHighlightEmbedding({ highlightId: "highlight-1", inputText });

    expect(result).toMatchObject({ reused: true, inputHash: hashEmbeddingInput(inputText) });
    expect(result.vector).toBeNull();
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("persists a changed Project Fact embedding", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{
      inputHash: hashEmbeddingInput("older statement"),
      modelId: "mock-titan-embed-text-v2",
      dimensions: 512,
    }]);

    const result = await upsertProjectFactEmbedding({
      projectFactId: "fact-1",
      inputText: "Current statement with materially different implementation detail.",
    });

    expect(result.reused).toBe(false);
    expect(result.vector).toHaveLength(512);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
