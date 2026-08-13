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
    expect(html).toContain("Preparing durable analysis");
    expect(html).toContain("role=\"progressbar\"");
    expect(html).toContain("~2%");
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
    expect(html).toContain("Stage 6 of 6");
    expect(html).toContain("~94%");
    expect(html).toContain("aria-valuenow=\"94\"");
  });

  it("uses persisted file counts to refine the active progress estimate", () => {
    const html = renderToStaticMarkup(
      <RepositoryRefreshLifecycleStatus
        attachmentPending={false}
        refresh={{
          status: "analyzing",
          qualityStatus: "pending",
          progress: { repositories: 1, analyzedFiles: 18, remainingFiles: 6 },
          error: null,
        }}
      />,
    );

    expect(html).toContain("Stage 2 of 6 · 18 of 24 repository files checked");
    expect(html).toContain("~35%");
    expect(html).toContain("aria-valuenow=\"35\"");
    expect(html).toContain("approximately 35% complete");
  });

  it("shows phase-based progress when a phase has no safe item total", () => {
    const html = renderToStaticMarkup(
      <RepositoryRefreshLifecycleStatus
        attachmentPending={false}
        refresh={{
          status: "semantic_analysis",
          qualityStatus: "pending",
          progress: { analyzedFiles: 24, remainingFiles: 0 },
          error: null,
        }}
      />,
    );

    expect(html).toContain("Stage 4 of 6");
    expect(html).toContain("~66%");
    expect(html).toContain("data-refresh-progress=\"semantic_analysis\"");
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
