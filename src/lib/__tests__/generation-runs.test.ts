import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  generationRun: {
    create: vi.fn(),
  },
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { createGenerationRun } from "@/src/lib/generation-runs";

describe("generation run telemetry privacy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps prompt and generated content out of deployment logs", async () => {
    const sentinel = "PRIVATE_REPOSITORY_SENTINEL";
    prismaMock.generationRun.create.mockResolvedValue({
      id: "generation-1",
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: { prompt: sentinel },
      rawOutput: `raw ${sentinel}`,
      parsedOutput: { answer: sentinel },
      validationErrors: null,
      resultRefs: null,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      estimatedCostUsd: 0.001,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await createGenerationRun({
      workItemId: "work-item-1",
      kind: "artifact_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputSummary: { prompt: sentinel },
      rawOutput: `raw ${sentinel}`,
      parsedOutput: { answer: sentinel },
    });

    const serialized = info.mock.calls.flat().join(" ");
    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("rawOutputHash");
    expect(serialized).toContain("generation-1");
  });
});
