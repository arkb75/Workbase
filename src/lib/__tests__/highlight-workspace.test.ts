import { describe, expect, it } from "vitest";
import {
  buildHighlightAtlas,
  buildHighlightCoverage,
  getHighlightWorkspaceStatus,
  groupHighlightsByTheme,
  highlightMatchesFilter,
  type HighlightWorkspaceItem,
} from "@/src/lib/highlight-workspace";

function buildItem(
  id: string,
  overrides: Partial<HighlightWorkspaceItem> = {},
): HighlightWorkspaceItem {
  return {
    id,
    workItemId: "work-item-1",
    text: `Highlight ${id}`,
    summary: `Summary ${id}`,
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    lifecycleStatus: "active",
    reviewState: "reviewed",
    visibility: "private",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: null,
    evidence: {
      summary: `Summary ${id}`,
      verificationNotes: null,
      sourceRefs: [],
    },
    tags: [],
    ...overrides,
  };
}

describe("highlight workspace model", () => {
  it.each([
    [
      { lifecycleStatus: "stale", verificationStatus: "approved", reviewState: "reviewed" },
      "lifecycle",
    ],
    [
      { lifecycleStatus: "active", verificationStatus: "rejected", reviewState: "pending_review" },
      "rejected",
    ],
    [
      { lifecycleStatus: "active", verificationStatus: "draft", reviewState: "reviewed" },
      "needs_review",
    ],
    [
      { lifecycleStatus: "active", verificationStatus: "approved", reviewState: "pending_review" },
      "needs_review",
    ],
    [
      { lifecycleStatus: "active", verificationStatus: "approved", reviewState: "reviewed" },
      "approved",
    ],
  ])("applies status precedence to %o", (input, expected) => {
    expect(getHighlightWorkspaceStatus(input)).toBe(expected);
  });

  it("chooses semantic themes deterministically and does not depend on tag order", () => {
    const tags = [
      { dimension: "emphasis", tag: "reliability", score: 0.99 },
      { dimension: "domain", tag: "systems_design", score: 0.7 },
      { dimension: "domain", tag: "backend", score: 0.8 },
    ];
    const forward = buildItem("one", { tags });
    const reversed = buildItem("two", { tags: [...tags].reverse() });

    expect(groupHighlightsByTheme([forward])[0]?.label).toBe("Backend");
    expect(groupHighlightsByTheme([reversed])[0]?.label).toBe("Backend");
  });

  it("keeps coordinates stable, gives every cluster a halo, and bounds explained edges", () => {
    const sharedReference = {
      evidenceItemId: "evidence-1",
      sourceId: "source-1",
      sourceLabel: "API repository",
      sourceType: "github_repo",
      title: "retry.ts",
      excerpt: "Retries transient failures.",
    };
    const items = [
      buildItem("a", {
        tags: [{ dimension: "domain", tag: "reliability", score: 0.9 }],
        evidence: { summary: "a", verificationNotes: null, sourceRefs: [sharedReference] },
      }),
      buildItem("b", {
        tags: [{ dimension: "domain", tag: "reliability", score: 0.8 }],
        evidence: { summary: "b", verificationNotes: null, sourceRefs: [sharedReference] },
      }),
      buildItem("c", {
        verificationStatus: "draft",
        tags: [{ dimension: "domain", tag: "delivery", score: 0.8 }],
      }),
      buildItem("d", {
        lifecycleStatus: "retired",
        tags: [{ dimension: "domain", tag: "retrieval", score: 0.8 }],
      }),
    ];

    const forward = buildHighlightAtlas(items);
    const reversed = buildHighlightAtlas([...items].reverse());
    const coordinates = (atlas: typeof forward) =>
      atlas.nodes
        .map((node) => ({ id: node.item.id, x: node.x, y: node.y }))
        .sort((left, right) => left.id.localeCompare(right.id));

    expect(coordinates(forward)).toEqual(coordinates(reversed));
    expect(forward.edges).toEqual(reversed.edges);
    expect(forward.clusters.every((cluster) => cluster.radiusX > 0 && cluster.radiusY > 0)).toBe(true);
    expect(forward.edges.length).toBeGreaterThan(0);
    expect(forward.edges.every((edge) => edge.reason.includes("shared"))).toBe(true);
    expect(forward.edges.every((edge) => edge.sourceId !== edge.targetId)).toBe(true);

    const degrees = new Map<string, number>();
    for (const edge of forward.edges) {
      degrees.set(edge.sourceId, (degrees.get(edge.sourceId) ?? 0) + 1);
      degrees.set(edge.targetId, (degrees.get(edge.targetId) ?? 0) + 1);
    }
    expect([...degrees.values()].every((degree) => degree <= 2)).toBe(true);
  });

  it("treats filtering as a view concern rather than changing Atlas placement", () => {
    const items = [
      buildItem("approved"),
      buildItem("review", { verificationStatus: "flagged" }),
    ];
    const before = buildHighlightAtlas(items).nodes.map(({ item, x, y }) => ({
      id: item.id,
      x,
      y,
    }));

    expect(items.filter((item) => highlightMatchesFilter(item, "needs_review"))).toHaveLength(1);
    expect(buildHighlightAtlas(items).nodes.map(({ item, x, y }) => ({ id: item.id, x, y }))).toEqual(before);
  });

  it("counts every highlight once in Coverage and retains explicit empty cells", () => {
    const items = [
      buildItem("approved", {
        tags: [{ dimension: "domain", tag: "reliability", score: 1 }],
      }),
      buildItem("review", {
        reviewState: "pending_review",
        tags: [{ dimension: "domain", tag: "reliability", score: 1 }],
      }),
      buildItem("lifecycle", {
        lifecycleStatus: "stale",
        tags: [{ dimension: "domain", tag: "delivery", score: 1 }],
      }),
    ];
    const rows = buildHighlightCoverage(items);
    const counted = rows.reduce(
      (total, row) =>
        total + Object.values(row.cells).reduce((sum, cell) => sum + cell.length, 0),
      0,
    );
    const delivery = rows.find((row) => row.label === "Delivery");

    expect(counted).toBe(items.length);
    expect(delivery?.cells.approved).toEqual([]);
    expect(delivery?.cells.lifecycle).toHaveLength(1);
  });
});
