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
});
