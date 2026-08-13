import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions", () => ({
  retryManualEvidenceHighlightsAction: "/retry-manual-highlights",
}));

import { ManualEvidenceHighlightStatus } from "@/components/work-items/manual-evidence-highlight-status";

function render(run: Parameters<typeof ManualEvidenceHighlightStatus>[0]["run"]) {
  return renderToStaticMarkup(
    <ManualEvidenceHighlightStatus
      run={run}
      workItemId="work-1"
      returnTo="/work-items/work-1?tab=highlights"
    />,
  );
}

describe("ManualEvidenceHighlightStatus", () => {
  it("shows active durable analysis and enables page polling semantics", () => {
    const html = render({
      id: "run-1",
      status: "running",
      result: null,
      error: null,
      attemptNumber: 0,
    });
    expect(html).toContain("grounding automatic Highlights");
    expect(html).toContain("complete current manual Evidence snapshot");
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps a replayed persisted Highlight visibly terminal-ready", () => {
    const html = render({
      id: "run-1",
      status: "completed",
      result: {
        terminalOutcome: "ready",
        createdHighlightIds: [],
        replayedHighlightIds: ["highlight-1"],
        persistedHighlightIds: ["highlight-1"],
        suggestionIds: [],
      },
      error: null,
      attemptNumber: 0,
    });
    expect(html).toContain("1 grounded automatic Highlight is ready for review");
    expect(html).toContain("complete");
    expect(html).not.toContain("did not safely support");
  });

  it("distinguishes no-safe-candidate completion from operational failure", () => {
    const html = render({
      id: "run-1",
      status: "completed",
      result: { terminalOutcome: "no_safe_candidates" },
      error: null,
      attemptNumber: 0,
    });
    expect(html).toContain("did not safely support a new automatic Highlight");
    expect(html).toContain("Evidence remains saved");
    expect(html).not.toContain("Retry automatic Highlights");
  });

  it("explains supersession and guarantees that stale output was not applied", () => {
    const html = render({
      id: "run-old",
      status: "completed",
      result: { terminalOutcome: "superseded_input" },
      error: null,
      attemptNumber: 0,
    });
    expect(html).toContain("newer manual Evidence snapshot replaced this run");
    expect(html).toContain("No stale Highlight was applied");
  });

  it("shows exclude-last reconciliation and stale retrieval removal explicitly", () => {
    const html = render({
      id: "run-empty",
      status: "completed",
      result: {
        terminalOutcome: "no_evidence",
        retiredHighlightIds: ["highlight-stale"],
      },
      error: null,
      attemptNumber: 0,
    });
    expect(html).toContain("No included manual Evidence remains");
    expect(html).toContain("removed from retrieval");
    expect(html).not.toContain("Retry automatic Highlights");
  });

  it("renders an explicit retry for operational failure", () => {
    const html = render({
      id: "run-failed",
      status: "failed",
      result: null,
      error: {
        message: "Provider did not complete",
        recovery: "Retry after checking provider access.",
      },
      attemptNumber: 1,
    });
    expect(html).toContain("Automatic Highlight analysis did not complete");
    expect(html).toContain("Retry after checking provider access");
    expect(html).toContain("Retry automatic Highlights");
    expect(html).toContain('name="runId" value="run-failed"');
  });
});
