import { describe, expect, it } from "vitest";
import {
  mergeRepositoryImportMetadata,
  readRepositoryImportState,
  repositoryBackgroundLifecycleIsActive,
  repositoryImportIsActive,
  repositoryRefreshIsActive,
} from "@/src/lib/github-repository-import-state";

describe("repository import state", () => {
  it("round-trips a durable request while preserving unrelated source metadata", () => {
    const state = {
      requestId: "request-1",
      status: "queued" as const,
      requestedAt: "2026-08-09T00:00:00.000Z",
    };
    const metadata = mergeRepositoryImportMetadata(
      { repository: { fullName: "workbase/demo" }, custom: "preserved" },
      state,
      { importedAt: "2026-08-09T00:01:00.000Z" },
    );

    expect(readRepositoryImportState(metadata)).toEqual(state);
    expect(metadata).toMatchObject({
      status: "queued",
      custom: "preserved",
      importedAt: "2026-08-09T00:01:00.000Z",
      repository: { fullName: "workbase/demo" },
    });
    expect(repositoryImportIsActive(readRepositoryImportState(metadata))).toBe(true);
  });

  it("treats terminal and malformed values as non-active", () => {
    expect(repositoryImportIsActive(readRepositoryImportState({
      repositoryImport: {
        requestId: "request-1",
        status: "evidence_ready",
        requestedAt: "2026-08-09T00:00:00.000Z",
      },
    }))).toBe(false);
    expect(readRepositoryImportState({
      repositoryImport: { status: "importing" },
    })).toBeNull();
  });

  it("keeps Sources polling after evidence is ready while its refresh remains active", () => {
    const imported = readRepositoryImportState({
      repositoryImport: {
        requestId: "request-1",
        status: "evidence_ready",
        requestedAt: "2026-08-09T00:00:00.000Z",
        refreshRunId: "refresh-1",
      },
    });

    expect(repositoryRefreshIsActive("reconciling")).toBe(true);
    expect(repositoryBackgroundLifecycleIsActive({
      imports: [imported],
      refreshes: [{ id: "refresh-1", status: "reconciling" }],
    })).toBe(true);
  });

  it("fails closed during the evidence-ready to refresh attachment hand-off", () => {
    const imported = readRepositoryImportState({
      repositoryImport: {
        requestId: "request-1",
        status: "evidence_ready",
        requestedAt: "2026-08-09T00:00:00.000Z",
      },
    });

    expect(repositoryBackgroundLifecycleIsActive({
      imports: [imported],
      refreshes: [],
    })).toBe(true);
  });

  it("stops polling only after the attached refresh is terminal", () => {
    const imported = readRepositoryImportState({
      repositoryImport: {
        requestId: "request-1",
        status: "evidence_ready",
        requestedAt: "2026-08-09T00:00:00.000Z",
        refreshRunId: "refresh-1",
      },
    });

    expect(repositoryRefreshIsActive("completed")).toBe(false);
    expect(repositoryBackgroundLifecycleIsActive({
      imports: [imported],
      refreshes: [{ id: "refresh-1", status: "completed" }],
    })).toBe(false);
  });
});
