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

  it("quarantines candidates whose cited semantic extraction degraded", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "The service defines a bounded retry loop.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "src/retry.ts",
      statement: "The service defines a bounded retry loop.",
      semanticStatus: "degraded",
    }])).toBe(true);
  });

  it("quarantines modal workflow claims supported only by documentation", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "Every repository fact is automatically approved.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "README.md",
      statement: "Every repository fact is automatically approved.",
    }])).toBe(true);
  });

  it("allows a modal workflow claim when executable code corroborates it", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "Artifacts are only generated from approved Highlights.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "src/services/artifact-workflow-service.ts",
      statement: "The query uses only approved Highlights before artifact generation.",
    }])).toBe(false);
  });

  it("blocks unprovable overclaims even when code is cited", () => {
    expect(shouldQuarantineSynthesizedCandidate({
      statement: "The fallback always produces calibrated output with tamper-evident provenance.",
      confidence: "high",
      sensitivityFlag: false,
    }, [{
      path: "src/services/project-chat-agent-service.ts",
      statement: "The service contains a fallback branch.",
    }])).toBe(true);
  });

  it("keeps repository-only Highlights private until ownership context is reviewed", () => {
    expect(repositoryHighlightPublicDisposition(false)).toMatchObject({
      eligible: false,
      reasons: [expect.stringContaining("requires reviewed ownership context")],
    });
  });
});
