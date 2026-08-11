import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RepositoryRefreshLifecycleStatus } from "@/components/work-items/repository-refresh-lifecycle-status";

describe("RepositoryRefreshLifecycleStatus", () => {
  it("shows the fail-closed hand-off after evidence is ready", () => {
    const html = renderToStaticMarkup(
      <RepositoryRefreshLifecycleStatus attachmentPending refresh={null} />,
    );

    expect(html).toContain("Current-head analysis starting");
    expect(html).toContain("this page will stay updated until that phase is terminal");
  });

  it("shows the active automatic Highlight phase", () => {
    const html = renderToStaticMarkup(
      <RepositoryRefreshLifecycleStatus
        attachmentPending={false}
        refresh={{
          status: "reconciling",
          qualityStatus: "verified",
          progress: { analyzedFiles: 20 },
          error: null,
        }}
      />,
    );

    expect(html).toContain("applying automatic Highlights");
    expect(html).toContain("still validating the current repository head");
    expect(html).toContain("aria-live=\"polite\"");
  });

  it("shows durable refresh failures instead of evidence-only success", () => {
    const html = renderToStaticMarkup(
      <RepositoryRefreshLifecycleStatus
        attachmentPending={false}
        refresh={{
          status: "failed",
          qualityStatus: "failed",
          progress: null,
          error: { message: "OpenRouter generation failed" },
        }}
      />,
    );

    expect(html).toContain("analysis failed");
    expect(html).toContain("OpenRouter generation failed");
    expect(html).toContain("role=\"alert\"");
  });

  it("flags completed refreshes that omitted the automatic Highlight outcome", () => {
    const html = renderToStaticMarkup(
      <RepositoryRefreshLifecycleStatus
        attachmentPending={false}
        refresh={{
          status: "completed",
          qualityStatus: "verified",
          progress: { analyzedFiles: 20 },
          error: null,
        }}
      />,
    );

    expect(html).toContain("without a recorded automatic Highlight outcome");
    expect(html).toContain("role=\"alert\"");
  });
});
