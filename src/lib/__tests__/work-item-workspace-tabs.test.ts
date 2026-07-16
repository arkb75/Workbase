import { describe, expect, it } from "vitest";
import {
  buildWorkItemWorkspaceHref,
  buildWorkItemWorkspaceTabHrefs,
  readWorkItemWorkspacePage,
  readWorkItemWorkspaceTab,
} from "@/src/lib/work-item-workspace-tabs";

describe("work item workspace tabs", () => {
  it("defaults invalid or missing tabs to sources", () => {
    expect(readWorkItemWorkspaceTab(undefined)).toBe("sources");
    expect(readWorkItemWorkspaceTab("unknown")).toBe("sources");
    expect(readWorkItemWorkspaceTab("chat")).toBe("chat");
  });

  it("preserves the current query while changing only the active tab", () => {
    const hrefs = buildWorkItemWorkspaceTabHrefs({
      pathname: "/work-items/work-item-1",
      searchParams: {
        tab: "chat",
        thread: "thread-1",
        result: "artifact-started",
        repeated: ["first", "second"],
      },
    });

    expect(hrefs.highlights).toBe(
      "/work-items/work-item-1?tab=highlights&thread=thread-1&result=artifact-started&repeated=first&repeated=second",
    );
    expect(hrefs.artifacts).toBe(
      "/work-items/work-item-1?tab=artifacts&thread=thread-1&result=artifact-started&repeated=first&repeated=second",
    );
  });

  it("normalizes page numbers and preserves query state in page links", () => {
    expect(readWorkItemWorkspacePage(undefined)).toBe(1);
    expect(readWorkItemWorkspacePage("0")).toBe(1);
    expect(readWorkItemWorkspacePage("not-a-page")).toBe(1);
    expect(readWorkItemWorkspacePage("2abc")).toBe(1);
    expect(readWorkItemWorkspacePage("3")).toBe(3);

    expect(buildWorkItemWorkspaceHref({
      pathname: "/work-items/work-item-1",
      searchParams: {
        tab: "sources",
        repoQuery: "workbase",
        repoList: "1",
        evidencePage: "2",
      },
      updates: {
        evidencePage: 3,
      },
    })).toBe(
      "/work-items/work-item-1?tab=sources&repoQuery=workbase&repoList=1&evidencePage=3",
    );
    expect(buildWorkItemWorkspaceHref({
      pathname: "/work-items/work-item-1",
      searchParams: {
        tab: "highlights",
        knowledgePage: "2",
      },
      updates: {
        knowledgePage: null,
      },
    })).toBe("/work-items/work-item-1?tab=highlights");
    expect(buildWorkItemWorkspaceHref({
      pathname: "/work-items/work-item-1",
      searchParams: {
        tab: "sources",
        repoQuery: "workbase",
        repoList: "1",
      },
      updates: {
        evidencePage: 2,
        repoQuery: null,
        repoList: null,
      },
    })).toBe("/work-items/work-item-1?tab=sources&evidencePage=2");
  });
});
