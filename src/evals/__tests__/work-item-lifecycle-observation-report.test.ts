import { describe, expect, it } from "vitest";
import {
  appendLifecycleObservationToReport,
  removeLifecycleObservationFromReport,
} from "@/tests/e2e/work-item-lifecycle-observation-report.mjs";

const SCHEMA_VERSION = "workbase-work-item-lifecycle-release-gate-v3";

function observation(scenarioId: string, workItemId: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId,
    currentLineage: { workItemId },
  };
}

describe("live lifecycle observation report persistence", () => {
  it("preserves prior observations when a Playwright worker restarts", () => {
    const first = appendLifecycleObservationToReport({
      priorReport: undefined,
      schemaVersion: SCHEMA_VERSION,
      baseUrl: "http://127.0.0.1:3100",
      observation: observation("manual_only_create", "work-item-1"),
    });

    // A restarted worker has no module-local observation array. Its only
    // durable state is the report parsed from disk.
    const afterRestart = appendLifecycleObservationToReport({
      priorReport: JSON.parse(JSON.stringify(first)),
      schemaVersion: SCHEMA_VERSION,
      baseUrl: "http://127.0.0.1:3100",
      observation: observation("empty_create_attach", "work-item-2"),
    });

    expect(afterRestart).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      live: true,
      baseUrl: "http://127.0.0.1:3100",
    });
    expect(afterRestart.observations).toEqual([
      observation("manual_only_create", "work-item-1"),
      observation("empty_create_attach", "work-item-2"),
    ]);
  });

  it("removes only the temporary completed lineage observation", () => {
    const priorReport = {
      schemaVersion: SCHEMA_VERSION,
      live: true,
      baseUrl: "http://127.0.0.1:3100",
      runLabel: "retained diagnostic",
      observations: [
        observation("manual_only_create", "work-item-1"),
        observation("empty_create_attach", "temporary-work-item"),
      ],
    };

    expect(removeLifecycleObservationFromReport({
      priorReport,
      workItemId: "temporary-work-item",
    })).toEqual({
      ...priorReport,
      observations: [observation("manual_only_create", "work-item-1")],
    });
  });
});
