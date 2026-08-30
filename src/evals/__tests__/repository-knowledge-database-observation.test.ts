import { describe, expect, it } from "vitest";
import {
  modelCallsFromGenerationTelemetry,
  repositoryGenerationModelCalls,
  repositoryGenerationRunsForRefresh,
  semanticCoverageFromOrchestration,
} from "@/src/evals/repository-knowledge-database-observation";

const attempt = (requestId: string) => ({
  requestId,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
});

describe("repository knowledge database performance telemetry", () => {
  it("binds certification runs to the selected refresh instead of its time window", () => {
    const selected = repositoryGenerationRunsForRefresh([
      { id: "planner", inputSummary: { refreshRunId: "refresh-1" } },
      { id: "semantic", inputSummary: { refreshRunId: "refresh-1", path: "src/core.ts" } },
      { id: "concurrent-chat", inputSummary: { route: "repository_research" } },
      { id: "other-refresh", inputSummary: { refreshRunId: "refresh-2" } },
      { id: "malformed", inputSummary: null },
    ], "refresh-1");

    expect(selected.map((run) => run.id)).toEqual(["planner", "semantic"]);
  });

  it("counts multiple provider attempts in one generation row once each", () => {
    const tokenUsage = {
      attempts: [attempt("request-1"), attempt("request-2"), attempt("request-3")],
      providerAttemptCount: 3,
      unknownUsageAttempts: 0,
      budget: {
        modelCalls: 3,
        inputTokens: 300,
        outputTokens: 60,
        totalTokens: 360,
      },
    };

    expect(modelCallsFromGenerationTelemetry(tokenUsage)).toBe(3);
    expect(repositoryGenerationModelCalls([{ tokenUsage }])).toBe(3);
  });

  it("does not add nested attempt leaves to a matching budget counter", () => {
    const tokenUsage = {
      attempts: [attempt("request-1"), attempt("request-2")],
      synthesisBudget: {
        modelCalls: 2,
        unknownUsageCalls: 0,
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 240,
      },
    };

    expect(modelCallsFromGenerationTelemetry(tokenUsage)).toBe(2);
  });

  it("sums distinct generation rows and uses cumulative refresh usage only as a floor", () => {
    const generationRuns = [
      { tokenUsage: { providerAttemptCount: 2, attempts: [attempt("a"), attempt("b")] } },
      { tokenUsage: { providerAttemptCount: 3, attempts: [attempt("c"), attempt("d"), attempt("e")] } },
      { tokenUsage: null },
    ];

    expect(repositoryGenerationModelCalls(generationRuns, {
      actual: { modelCalls: 5, unknownUsageCalls: 0 },
    })).toBe(5);
    expect(repositoryGenerationModelCalls([{ tokenUsage: null }], {
      actual: { modelCalls: 4, unknownUsageCalls: 1 },
    })).toBe(4);
  });

  it("counts unmetered dispatched attempts without inventing a call for empty rows", () => {
    expect(modelCallsFromGenerationTelemetry({
      attempts: [],
      unknownUsageAttempts: 2,
    })).toBe(2);
    expect(modelCallsFromGenerationTelemetry(null)).toBe(0);
  });

  it("measures semantic coverage against the persisted pre-selection universe", () => {
    const coverage = semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: {
          fileSnapshotIds: ["catalog", "forecast-python", "client", "quality"],
          fileCount: 4,
        },
      },
      files: [
        { id: "catalog", path: "src/model/Catalog.java", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "forecast-python", path: "ml_service/forecast_service.py", disposition: "analyzed", semanticStatus: "not_selected" },
        { id: "client", path: "src/service/ForecastClient.java", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "quality", path: "src/test/CatalogTest.java", disposition: "analyzed", semanticStatus: "not_selected" },
      ],
    });

    expect(coverage).toEqual({
      semanticEligibleFiles: 4,
      semanticAnalyzedFiles: 2,
      semanticAnalyzedPaths: ["src/model/Catalog.java", "src/service/ForecastClient.java"],
      semanticCoverage: 0.5,
    });
  });

  it("rejects missing, duplicate, or snapshot-external semantic universe metadata", () => {
    const files = [{ id: "known", path: "src/core.ts", disposition: "analyzed", semanticStatus: "succeeded" }];
    expect(() => semanticCoverageFromOrchestration({ orchestration: {}, files }))
      .toThrow(/missing its persisted semantic evidence universe/iu);
    expect(() => semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["known", "known"], fileCount: 2 },
      },
      files,
    })).toThrow(/inconsistent persisted semantic evidence universe/iu);
    expect(() => semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["unknown"], fileCount: 1 },
      },
      files,
    })).toThrow(/outside its immutable snapshot/iu);
  });

  it("rejects a self-reported universe that omits an eligible analyzed file", () => {
    expect(() => semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["selected"], fileCount: 1 },
      },
      files: [
        { id: "selected", path: "src/core.ts", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "omitted", path: "src/worker.py", disposition: "analyzed", semanticStatus: "not_selected" },
        { id: "readme", path: "README.md", disposition: "analyzed", semanticStatus: "not_selected" },
      ],
    })).toThrow(/does not match the independently eligible snapshot files/iu);
  });

  it("uses the same cartography exclusions when independently checking the universe", () => {
    expect(semanticCoverageFromOrchestration({
      orchestration: {
        semanticEvidenceUniverse: { fileSnapshotIds: ["core"], fileCount: 1 },
      },
      files: [
        { id: "core", path: "src/core.ts", disposition: "analyzed", semanticStatus: "succeeded" },
        { id: "eval", path: "src/evals/harness.ts", disposition: "analyzed", semanticStatus: "not_selected" },
      ],
    })).toEqual(expect.objectContaining({
      semanticEligibleFiles: 1,
      semanticCoverage: 1,
    }));
  });
});
