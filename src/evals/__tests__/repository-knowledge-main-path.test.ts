import { describe, expect, it } from "vitest";
import {
  evaluateRepositoryKnowledgeMainPath,
  type RepositoryKnowledgeGenerationAuditRecord,
} from "@/src/evals/repository-knowledge-main-path";

const expectedIdentities = {
  semantic_extraction: { provider: "bedrock", modelId: "semantic-model" },
  semantic_repair: { provider: "bedrock", modelId: "semantic-model" },
  capability_synthesis: { provider: "bedrock", modelId: "synthesis-model" },
  coverage_audit: { provider: "bedrock", modelId: "verification-model" },
};

function generation(
  kind: RepositoryKnowledgeGenerationAuditRecord["kind"],
  modelId: string,
  overrides: Partial<RepositoryKnowledgeGenerationAuditRecord> = {},
): RepositoryKnowledgeGenerationAuditRecord {
  return {
    kind,
    status: "success",
    provider: "bedrock",
    modelId,
    resultRefs: {
      configuredModelId: modelId,
      requestIds: [`request-${kind}`],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "json_schema",
    },
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      unknownUsageAttempts: 0,
    },
    ...overrides,
  };
}

describe("repository knowledge main-path integrity", () => {
  it("accepts successful attributed model extraction and synthesis", () => {
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("semantic_extraction", "semantic-model"),
        generation("capability_synthesis", "synthesis-model"),
      ],
      expectedIdentities,
      coverage: [{
        targets: [{ deterministicFallbackPathCount: 0 }],
      }],
      warnings: { semanticOrchestrationGaps: ["One domain is thin."] },
    });

    expect(result).toEqual({
      passed: true,
      issues: [],
      metrics: {
        semanticExtraction: 1,
        capabilitySynthesis: 1,
        successfulGenerations: 2,
        totalGenerations: 2,
        providerAttemptCount: 2,
        schemaRepairRunCount: 0,
        deterministicSemanticPathCount: 0,
        deterministicSynthesis: false,
        budgetExhausted: false,
      },
    });
  });

  it("counts bounded model schema repair without confusing it with deterministic fallback", () => {
    const synthesis = generation("capability_synthesis", "synthesis-model", {
      resultRefs: {
        configuredModelId: "synthesis-model",
        requestIds: ["generate", "repair"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 2,
        transportMode: "text_repair_fallback",
      },
    });
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("semantic_extraction", "semantic-model"),
        synthesis,
      ],
      expectedIdentities,
      coverage: null,
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      providerAttemptCount: 3,
      schemaRepairRunCount: 1,
      deterministicSynthesis: false,
    });
  });

  it("rejects failed or substituted generations and deterministic completion", () => {
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("semantic_extraction", "fallback-model", {
          provider: "openrouter",
          status: "provider_error",
          resultRefs: {
            configuredModelId: "semantic-model",
            requestIds: [],
            usageComplete: false,
            failedProviderAttempts: [{ provider: "bedrock" }],
            admissionFailure: true,
          },
          tokenUsage: { unknownUsageAttempts: 1 },
        }),
      ],
      expectedIdentities,
      coverage: [{
        targets: [{ deterministicFallbackPathCount: 2 }],
      }],
      warnings: {
        synthesisCoverageGaps: [
          "Repository acme/project used deterministic subsystem synthesis because the shared repository-synthesis budget was exhausted.",
        ],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "No audited capability synthesis generation ran.",
      expect.stringContaining("ended with status provider_error"),
      expect.stringContaining("used provider openrouter"),
      expect.stringContaining("used model fallback-model"),
      expect.stringContaining("has no provider request ID"),
      expect.stringContaining("incomplete model-usage evidence"),
      expect.stringContaining("records failed provider attempts"),
      expect.stringContaining("stopped before a provider dispatch"),
      "2 semantic path(s) used deterministic fallback analysis.",
      "At least one subsystem used deterministic synthesis.",
      "Repository generation exhausted a model budget.",
    ]));
  });
});
