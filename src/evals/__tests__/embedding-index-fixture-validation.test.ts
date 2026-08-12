import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { validateEmbeddingFixtureSources } from "@/src/evals/embedding-index-fixture-validation";

describe("embedding index fixture validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts only retrievable sources from one Work Item", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{
        id: "highlight-1",
        workItemId: "work-1",
        verificationStatus: "approved",
        lifecycleStatus: "active",
      }])
      .mockResolvedValueOnce([{
        id: "fact-1",
        workItemId: "work-1",
        status: "approved",
        lifecycleStatus: "active",
      }])
      .mockResolvedValueOnce([{
        id: "evidence-1",
        workItemId: "work-1",
        included: true,
        lifecycleStatus: "active",
      }])
      .mockResolvedValueOnce([{
        id: "artifact-1",
        workItemId: "work-1",
        lifecycleStatus: "active",
      }]);

    await expect(validateEmbeddingFixtureSources({
      workItemId: "work-1",
      queries: [{
        required: {
          highlights: ["highlight-1"],
          projectFacts: ["fact-1"],
          evidence: ["evidence-1"],
          artifacts: ["artifact-1"],
        },
      }],
    })).resolves.toBe("work-1");
  });

  it.each([
    ["retired Highlight", "highlights", {
      id: "source-1",
      workItemId: "work-1",
      verificationStatus: "approved",
      lifecycleStatus: "retired",
    }],
    ["rejected ProjectFact", "projectFacts", {
      id: "source-1",
      workItemId: "work-1",
      status: "rejected",
      lifecycleStatus: "active",
    }],
    ["excluded Evidence", "evidence", {
      id: "source-1",
      workItemId: "work-1",
      included: false,
      lifecycleStatus: "active",
    }],
    ["stale Artifact", "artifacts", {
      id: "source-1",
      workItemId: "work-1",
      lifecycleStatus: "stale",
    }],
  ] as const)("rejects a %s before provider ranking", async (_label, kind, row) => {
    prismaMock.$queryRaw.mockResolvedValueOnce([row]);

    await expect(validateEmbeddingFixtureSources({
      workItemId: "work-1",
      queries: [{ required: { [kind]: ["source-1"] } }],
    })).rejects.toThrow(
      "Embedding fixture references non-retrievable required IDs: source-1.",
    );
  });
});
