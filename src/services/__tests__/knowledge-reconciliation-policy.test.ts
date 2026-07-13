import { describe, expect, it } from "vitest";
import {
  repositoryHighlightPublicDisposition,
  shouldQuarantineSynthesizedCandidate,
} from "@/src/services/knowledge-reconciliation-service";

describe("repository knowledge auto-apply policy", () => {
  it("does not quarantine a supported deterministic fallback merely because model synthesis failed", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      confidence: "medium",
      sensitivityFlag: false,
    })).toBe(false);
  });

  it("still quarantines low-confidence or sensitive candidates", () => {
    expect(shouldQuarantineSynthesizedCandidate({ confidence: "low", sensitivityFlag: false })).toBe(true);
    expect(shouldQuarantineSynthesizedCandidate({ confidence: "high", sensitivityFlag: true })).toBe(true);
  });

  it("keeps repository-only Highlights private until ownership context is reviewed", () => {
    expect(repositoryHighlightPublicDisposition(false)).toMatchObject({
      eligible: false,
      reasons: [expect.stringContaining("requires reviewed ownership context")],
    });
  });
});
