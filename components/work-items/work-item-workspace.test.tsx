import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkItemWorkspace } from "@/components/work-items/work-item-workspace";

describe("WorkItemWorkspace", () => {
  it("renders only the server-selected panel and navigation links", () => {
    const html = renderToStaticMarkup(
      <WorkItemWorkspace
        activeTab="chat"
        tabHrefs={{
          sources: "/work-items/one?tab=sources&thread=thread-1",
          highlights: "/work-items/one?tab=highlights&thread=thread-1",
          chat: "/work-items/one?tab=chat&thread=thread-1",
          artifacts: "/work-items/one?tab=artifacts&thread=thread-1",
        }}
        sourcesPanel={null}
        highlightsPanel={null}
        chatPanel={<p>Active chat panel</p>}
        artifactsPanel={null}
      />,
    );

    expect(html).toContain("Active chat panel");
    expect(html).toContain('aria-label="Work Item sections"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(
      'href="/work-items/one?tab=artifacts&amp;thread=thread-1"',
    );
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('role="tabpanel"');
  });
});
