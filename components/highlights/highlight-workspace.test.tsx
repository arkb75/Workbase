import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HighlightWorkspace } from "@/components/highlights/highlight-workspace";
import type { HighlightWorkspaceItem } from "@/src/lib/highlight-workspace";

vi.mock("@/app/actions", () => ({
  updateClaimAction: vi.fn(),
}));

function buildItem(
  id: string,
  overrides: Partial<HighlightWorkspaceItem> = {},
): HighlightWorkspaceItem {
  return {
    id,
    workItemId: "work-item-1",
    text: `Grounded highlight ${id}`,
    summary: `Evidence-backed summary ${id}.`,
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
    updatedAt: "2026-08-19T00:00:00.000Z",
    evidence: {
      summary: `Evidence-backed summary ${id}.`,
      verificationNotes: null,
      sourceRefs: [],
    },
    tags: [{ dimension: "domain", tag: "systems_design", score: 0.9 }],
    ...overrides,
  };
}

const items = [
  buildItem("review", {
    verificationStatus: "draft",
    evidence: {
      summary: "Retry behavior",
      verificationNotes: null,
      sourceRefs: [
        {
          evidenceItemId: "evidence-1",
          sourceId: "source-1",
          sourceLabel: "API repository",
          sourceType: "github_repo",
          title: "retry.ts",
          excerpt: "Retries transient failures before surfacing an error.",
        },
      ],
    },
  }),
  buildItem("approved"),
  buildItem("retired", {
    lifecycleStatus: "retired",
    tags: [{ dimension: "domain", tag: "delivery", score: 0.9 }],
  }),
];

function renderWorkspace(initialView: "atlas" | "coverage" = "atlas") {
  return renderToStaticMarkup(
    <HighlightWorkspace
      items={items}
      totalCount={72}
      overviewLimit={48}
      returnTo="/work-items/work-item-1?tab=highlights"
      initialView={initialView}
    />,
  );
}

describe("HighlightWorkspace", () => {
  it("renders an accessible Atlas with a halo for every cluster and a working inspector", () => {
    const html = renderWorkspace();

    expect(html).toContain('aria-label="Highlight Atlas"');
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/data-cluster-halo=/g)).toHaveLength(2);
    expect(html).toContain("Grounded highlight review. Needs review.");
    expect(html).toContain("API repository");
    expect(html).toContain("Approve");
    expect(html).toContain("Needs review");
    expect(html).toContain("48");
    expect(html).toContain("72");
  });

  it("renders Coverage as the second projection of the same records", () => {
    const html = renderWorkspace("coverage");

    expect(html).toContain('aria-label="Highlight Coverage"');
    expect(html).toContain("Coverage system");
    expect(html).toContain("Populated inferred groups form the rows, ordered by coverage");
    expect(html).toContain("Systems Design");
    expect(html).toContain("Delivery");
    expect(html).toContain("Unclassified");
    expect(html).not.toContain("Edit Unclassified row name");
    expect(html).not.toContain("Rename Unclassified row");
    expect(html).not.toContain("Use suggestion");
    expect(html).not.toContain("Primary angle for Grounded highlight review");
    expect(html).not.toContain("Weak framing");
  });

  it("renders a useful empty state without fake controls", () => {
    const html = renderToStaticMarkup(
      <HighlightWorkspace
        items={[]}
        totalCount={0}
        overviewLimit={48}
        returnTo="/work-items/work-item-1?tab=highlights"
      />,
    );

    expect(html).toContain("Your highlight map starts here");
    expect(html).not.toContain("Search highlights");
  });
});
