import { describe, expect, it } from "vitest";
import {
  artifactAttemptResultAfterCompletion,
  artifactBriefRequiresMeasuredImpact,
} from "@/src/services/artifact-workflow-service";

describe("artifact cost routing", () => {
  it.each([
    "Write a quantified resume bullet about the latency reduction.",
    "Use the measured 37% improvement in a resume bullet.",
    "Describe the throughput increase with metrics.",
  ])("detects requests that require measured impact evidence: %s", (brief) => {
    expect(artifactBriefRequiresMeasuredImpact(brief)).toBe(true);
  });

  it("does not force metric research for an ordinary architecture artifact", () => {
    expect(artifactBriefRequiresMeasuredImpact(
      "Write two technical resume bullets about the backend architecture.",
    )).toBe(false);
  });

  it("preserves cancellation authority when it wins after artifact persistence", () => {
    expect(artifactAttemptResultAfterCompletion(
      { persisted: false, status: "cancelled" },
      { status: "completed", artifactId: "artifact-persisted-before-cancel" },
    )).toEqual({
      status: "cancelled",
      message: "The artifact run was cancelled.",
      replayed: true,
    });
  });

  it("returns the intended artifact result only when completion was persisted", () => {
    expect(artifactAttemptResultAfterCompletion(
      { persisted: true, status: "completed" },
      { status: "completed", artifactId: "artifact-1" },
    )).toEqual({
      status: "completed",
      artifactId: "artifact-1",
    });
  });

  it("surfaces an authoritative activation-time provenance failure", () => {
    expect(artifactAttemptResultAfterCompletion(
      {
        persisted: true,
        status: "insufficient_context",
        message: "The artifact was not published because supporting Evidence was excluded.",
      },
      { status: "completed", artifactId: "artifact-quarantined" },
    )).toEqual({
      status: "insufficient_context",
      message: "The artifact was not published because supporting Evidence was excluded.",
    });
  });
});
