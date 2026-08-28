import { describe, expect, it } from "vitest";
import {
  applyGlobalSynthesisDiversity,
  deterministicSynthesisAnchorSubsystems,
  semanticFactsForSubsystem,
  synthesisCandidateSimilarity,
  type SynthesizedKnowledge,
} from "@/src/services/repository-knowledge-synthesis-service";

function subsystem(
  subsystemKey: string,
  path: string,
  highlights: Array<{ text: string; summary: string }>,
): SynthesizedKnowledge {
  return {
    subsystemKey,
    facts: [],
    highlights: highlights.map((highlight) => ({
      ...highlight,
      confidence: "high",
      sensitivityFlag: false,
      visibility: "private",
      citationIndexes: [1],
      productImportance: 4,
      implementationBreadth: 4,
      technicalDifficulty: 3,
      distinctiveness: 3,
    })),
    unresolvedQuestions: [],
    coverageGaps: [],
    notebook: [{
      sourceId: "source",
      repository: "example/project",
      commitSha: "a".repeat(40),
      blobSha: "b".repeat(40),
      path,
      lineStart: 1,
      lineEnd: 10,
      statement: highlights[0]?.summary ?? "Implemented behavior.",
      category: "behavior",
      confidence: "high",
      sensitivityFlag: false,
      productImportance: 4,
      implementationBreadth: 4,
      technicalDifficulty: 3,
      changeType: "added",
      semanticStatus: "succeeded",
      semanticSignals: [],
      evidenceMode: "semantic",
    }],
    tokenUsage: [],
    approvalEligible: true,
  };
}

describe("adaptive repository synthesis", () => {
  it("does not promote static inventory through product-specific anchor rules", () => {
    expect(deterministicSynthesisAnchorSubsystems({
      statement: "README.md states: a product capability is planned.",
      category: "behavior",
      confidence: "high",
      sensitivityFlag: false,
      lineStart: 1,
      lineEnd: 1,
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 3,
      subsystemKeys: ["product_surface"],
      evidenceMode: "static",
      path: "README.md",
    }, "README.md")).toEqual([]);
  });

  it("does not promote cached documentation-only semantic claims", () => {
    expect(semanticFactsForSubsystem({
      path: "README.md",
      summary: "Documents checkout.",
      subsystemKeys: ["product_surface"],
      responsibilities: [],
      symbols: [],
      dependencies: [],
      architectureSignals: [],
      userFacingCapabilities: [],
      facts: [{
        statement: "The product supports checkout.",
        category: "behavior",
        confidence: "high",
        sensitivityFlag: false,
        lineStart: 2,
        lineEnd: 2,
        productImportance: 4,
        implementationBreadth: 3,
        technicalDifficulty: 2,
        subsystemKeys: ["product_surface"],
        evidenceMode: "semantic",
        path: "README.md",
      }],
      unresolvedQuestions: [],
      chunksAnalyzed: 1,
      tokenUsage: [],
      analysisMode: "semantic",
      semanticStatus: "succeeded",
      semanticSource: "model",
    }, "product_surface")).toEqual([]);
  });

  it("detects paraphrased accomplishment duplicates", () => {
    expect(synthesisCandidateSimilarity(
      "Built hybrid artifact retrieval using lexical, PostgreSQL, and vector similarity ranking",
      "Hybrid artifact retrieval combines vector-similarity signals with PostgreSQL lexical ranking",
    )).toBeGreaterThan(0.66);
  });

  it("deduplicates across capability boundaries while retaining distinct domains", () => {
    const diversified = applyGlobalSynthesisDiversity([
      subsystem("intelligence_search", "src/search/retriever.ts", [{
        text: "Built hybrid artifact retrieval with lexical and vector ranking",
        summary: "Combines PostgreSQL lexical ranking with vector similarity for artifacts.",
      }]),
      subsystem("project_domain:artifacts", "src/search/retriever.ts", [{
        text: "Implemented artifact retrieval using vector and lexical ranking",
        summary: "Ranks artifacts with vector similarity and PostgreSQL lexical scores.",
      }]),
      subsystem("project_domain:onboarding", "src/onboarding/invite-service.ts", [{
        text: "Implemented invitation-based team onboarding",
        summary: "Creates expiring invitations and atomically joins accepted members.",
      }]),
    ]);

    expect(diversified.flatMap((entry) => entry.highlights)).toHaveLength(2);
    expect(diversified.flatMap((entry) => entry.highlights).map((entry) => entry.text).join(" "))
      .toMatch(/retrieval/);
    expect(diversified.flatMap((entry) => entry.highlights).map((entry) => entry.text).join(" "))
      .toMatch(/onboarding/);
  });
});
