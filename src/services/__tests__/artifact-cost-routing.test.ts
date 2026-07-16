import { describe, expect, it } from "vitest";
import { artifactBriefRequiresMeasuredImpact } from "@/src/services/artifact-workflow-service";

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
});
