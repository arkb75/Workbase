import { describe, expect, it } from "vitest";
import {
  applySynthesisCoverageGapsToRefreshState,
  allowsCanonicalKnowledgeReplacement,
  isNewerKnowledgeRefreshGeneration,
  repositoryHighlightPublicDisposition,
  shouldQuarantineSynthesizedCandidate,
} from "@/src/services/knowledge-reconciliation-service";

describe("repository knowledge auto-apply policy", () => {
  it("only allows canonical supersession after complete verified coverage", () => {
    expect(allowsCanonicalKnowledgeReplacement("verified")).toBe(true);
    expect(allowsCanonicalKnowledgeReplacement("degraded")).toBe(false);
    expect(allowsCanonicalKnowledgeReplacement("failed")).toBe(false);
    expect(allowsCanonicalKnowledgeReplacement(null)).toBe(false);
  });

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

  it("treats a later resolved differing head as a newer knowledge generation", () => {
    const currentCreatedAt = new Date("2026-07-16T10:00:00.000Z");
    const currentTargets = [{
      sourceId: "source-1",
      commitSha: "a".repeat(40),
      resolvedAt: "2026-07-16T10:00:00.000Z",
    }];
    expect(isNewerKnowledgeRefreshGeneration({
      currentTargets,
      candidateTargets: [{
        ...currentTargets[0],
        commitSha: "b".repeat(40),
        resolvedAt: "2026-07-16T10:01:00.000Z",
      }],
      currentCreatedAt,
      candidateCreatedAt: new Date("2026-07-16T10:01:01.000Z"),
    })).toBe(true);
    expect(isNewerKnowledgeRefreshGeneration({
      currentTargets,
      candidateTargets: currentTargets,
      currentCreatedAt,
      candidateCreatedAt: new Date("2026-07-16T10:02:00.000Z"),
    })).toBe(false);
    expect(isNewerKnowledgeRefreshGeneration({
      currentTargets,
      candidateTargets: [{
        ...currentTargets[0],
        commitSha: "0".repeat(40),
        resolvedAt: "2026-07-16T09:59:00.000Z",
      }],
      currentCreatedAt,
      candidateCreatedAt: new Date("2026-07-16T10:02:00.000Z"),
    })).toBe(false);
  });

  it("makes synthesis notebook overflow durable and partial for the affected repository", () => {
    const state = applySynthesisCoverageGapsToRefreshState({
      coverage: [{
        repository: "owner/repo-a",
        coverageStatus: "complete",
        capabilityCoverageStatus: "complete",
        coverageGaps: [],
      }, {
        repository: "owner/repo-b",
        coverageStatus: "complete",
        capabilityCoverageStatus: "complete",
        coverageGaps: [],
      }],
      warnings: { existingWarning: true },
      coverageGaps: [
        "Repository owner/repo-b could not fit inside the bounded 20-entry synthesis notebook.",
      ],
    });

    expect(state.coverage).toEqual([
      expect.objectContaining({
        repository: "owner/repo-a",
        coverageStatus: "complete",
      }),
      expect.objectContaining({
        repository: "owner/repo-b",
        coverageStatus: "partial",
        capabilityCoverageStatus: "partial",
        coverageGaps: [expect.stringContaining("could not fit")],
      }),
    ]);
    expect(state.warnings).toMatchObject({
      existingWarning: true,
      synthesisCoverageGaps: [expect.stringContaining("owner/repo-b")],
    });
  });
});
