import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeUpdateInbox } from "@/components/knowledge/knowledge-update-inbox";

vi.mock("@/app/actions", () => ({
  resolveKnowledgeChangeAction: vi.fn(),
  startProjectKnowledgeRefreshAction: vi.fn(),
}));

function buildChange(lifecycleStatus: string, action = "created") {
  return {
    id: `change-${lifecycleStatus}`,
    entityId: `highlight-${lifecycleStatus}`,
    entityKind: "highlight" as const,
    action,
    reason: "Automated repository review created this version.",
    createdAt: "2026-07-12T00:00:00.000Z",
    primary: "A repository-backed highlight",
    secondary: "Supporting summary",
    primaryField: "text" as const,
    secondaryField: "summary" as const,
    category: null,
    visibility: "private",
    sensitivityFlag: false,
    lifecycleStatus,
    publicSafetyStatus: lifecycleStatus === "quarantined" ? "failed" : "verified",
    beforeSnapshot: null,
    afterSnapshot: null,
    provenance: null,
    downstreamImpact: null,
  };
}

describe("KnowledgeUpdateInbox quarantine actions", () => {
  it("does not offer Keep for quarantined items and explains recovery choices", () => {
    const html = renderToStaticMarkup(
      <KnowledgeUpdateInbox
        workItemId="work-item-1"
        refreshes={[]}
        changes={[buildChange("quarantined", "quarantined")]}
      />,
    );

    expect(html).not.toContain(">Keep<");
    expect(html).toContain("Edit into a reviewed successor");
    expect(html).toContain(">Revert<");
    expect(html).toContain(">Retire<");
    expect(html).toContain("failed an automatic safety or validation gate");
  });

  it("continues to offer Keep for active reviewed updates", () => {
    const html = renderToStaticMarkup(
      <KnowledgeUpdateInbox
        workItemId="work-item-1"
        refreshes={[]}
        changes={[buildChange("active")]}
      />,
    );

    expect(html).toContain(">Keep<");
    expect(html).toContain("Edit and keep");
  });

  it("bounds user-facing cards and collapses exact Evidence provenance into its own queue", () => {
    const knowledge = Array.from({ length: 30 }, (_, index) => ({
      ...buildChange("active"),
      id: `knowledge-change-${index}`,
      entityId: `highlight-${index}`,
      primary: `Knowledge item ${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 12, 0, 0, index)).toISOString(),
    }));
    const provenance = Array.from({ length: 12 }, (_, index) => ({
      ...buildChange("active"),
      id: `evidence-change-${index}`,
      entityId: `evidence-${index}`,
      entityKind: "evidence" as const,
      primary: `Evidence item ${index}`,
      primaryField: "title" as const,
      secondaryField: "content" as const,
      createdAt: new Date(Date.UTC(2026, 6, 12, 0, 1, index)).toISOString(),
    }));

    const html = renderToStaticMarkup(
      <KnowledgeUpdateInbox
        workItemId="work-item-1"
        refreshes={[]}
        changes={[...knowledge, ...provenance]}
      />,
    );

    expect(html).toContain("6 more knowledge updates are safely queued");
    expect(html).toContain("Review 12 exact evidence provenance updates");
    expect(html).toContain("4 more provenance updates are preserved");
    expect(html).toContain(">Knowledge item 29<");
    expect(html).not.toContain(">Knowledge item 5<");
    expect(html).toContain(">Evidence item 11<");
    expect(html).not.toContain(">Evidence item 3<");
  });

  it("renders exact pending totals supplied separately from the bounded records", () => {
    const html = renderToStaticMarkup(
      <KnowledgeUpdateInbox
        workItemId="work-item-1"
        refreshes={[]}
        changes={[buildChange("active")]}
        counts={{
          totalKnowledgeCount: 73,
          totalProvenanceCount: 65,
          newOrUpdatedKnowledgeCount: 40,
          needsAttentionCount: 33,
        }}
      />,
    );

    expect(html).toContain(">40<");
    expect(html).toContain(">33<");
    expect(html).toContain("Review 65 exact evidence provenance updates");
    expect(html).toContain("72 more knowledge updates are safely queued");
    expect(html).toContain("65 more provenance updates are preserved");
  });
});
