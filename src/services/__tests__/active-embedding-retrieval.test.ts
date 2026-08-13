import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));

import { findNearestProjectKnowledge } from "@/src/services/knowledge-embedding-service";

describe("active embedding retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{
        id: "active-index-v2",
        key: "active-index-v2",
        provider: "mock",
        modelId: "mock-workbase-embed-v1",
        dimensions: 512,
        status: "active",
        writeEnabled: true,
        baseActivationEpoch: 0,
        qualityGatePassed: true,
        activationEpoch: 1,
        writeSetEpoch: 2,
        isActive: true,
      }])
      .mockResolvedValue([]);
  });

  it("filters all four vector searches to the one active index version", async () => {
    await findNearestProjectKnowledge({
      workItemId: "work-item-1",
      query: "How does grounded retrieval work?",
      limit: 10,
    });

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(5);
    for (const call of prismaMock.$queryRaw.mock.calls.slice(1)) {
      expect(call[0].join("")).toContain('"indexVersionId" = ');
      expect(call).toContain("active-index-v2");
    }
    const [highlightSql, projectFactSql, evidenceSql, artifactSql] =
      prismaMock.$queryRaw.mock.calls.slice(1).map((call) => call[0].join(""));
    expect(highlightSql).toContain('"Claim"."verificationStatus" = \'approved\'');
    expect(highlightSql).toContain('"Claim"."lifecycleStatus" = \'active\'');
    expect(projectFactSql).toContain('"ProjectFact"."status" = \'approved\'');
    expect(projectFactSql).toContain('"ProjectFact"."lifecycleStatus" = \'active\'');
    expect(evidenceSql).toContain('"EvidenceItem"."included" = true');
    expect(evidenceSql).toContain('"EvidenceItem"."lifecycleStatus" = \'active\'');
    expect(artifactSql).toContain('"Artifact"."lifecycleStatus" = \'active\'');
  });
});
