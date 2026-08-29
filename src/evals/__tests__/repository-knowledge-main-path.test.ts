import { describe, expect, it } from "vitest";
import { repositorySynthesisClaimContentDigest } from "@/src/domain/repository-synthesis-attestation";
import {
  evaluateRepositoryKnowledgeMainPath,
  type RepositoryKnowledgeGenerationAuditRecord,
} from "@/src/evals/repository-knowledge-main-path";

const expectedIdentities = {
  execution_routing: { provider: "bedrock", modelId: "routing-model" },
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
  const capabilitySynthesis = kind === "capability_synthesis";
  return {
    id: `generation-${kind}`,
    kind,
    status: "success",
    provider: "bedrock",
    modelId,
    inputSummary: capabilitySynthesis
      ? {
          phase: "synthesis",
          refreshRunId: "refresh-1",
          subsystemKeys: ["project_domain:payments#scope"],
        }
      : {},
    parsedOutput: capabilitySynthesis
      ? { subsystems: [{ subsystemKey: "project_domain:payments#scope", facts: [], highlights: [] }] }
      : {},
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

function claimKeys(parsedOutput: unknown) {
  const subsystems = (parsedOutput as {
    subsystems: Array<{
      subsystemKey: string;
      facts: unknown[];
      highlights: unknown[];
    }>;
  }).subsystems;
  return subsystems.flatMap((subsystem) => [
    ...subsystem.facts.map((_claim, index) =>
      `${subsystem.subsystemKey}:fact:${index + 1}`
    ),
    ...subsystem.highlights.map((_claim, index) =>
      `${subsystem.subsystemKey}:highlight:${index + 1}`
    ),
  ]);
}

function synthesisGeneration(
  parsedOutput: unknown,
  overrides: Partial<RepositoryKnowledgeGenerationAuditRecord> = {},
) {
  const claimContentDigest = repositorySynthesisClaimContentDigest(parsedOutput);
  if (!claimContentDigest) throw new Error("Test synthesis must contain attestable claims.");
  return generation("capability_synthesis", "synthesis-model", {
    parsedOutput,
    resultRefs: {
      configuredModelId: "synthesis-model",
      requestIds: ["request-capability_synthesis"],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "json_schema",
      resultAttestation: { claimContentDigest },
    },
    ...overrides,
  });
}

function entailmentCritic(
  parsedSynthesis: unknown,
  revisionRound = 0,
  overrides: Partial<RepositoryKnowledgeGenerationAuditRecord> = {},
) {
  const expectedClaimKeys = claimKeys(parsedSynthesis);
  const claimContentDigest = repositorySynthesisClaimContentDigest(parsedSynthesis);
  if (!claimContentDigest) throw new Error("Test critic must receive attestable claims.");
  return generation("capability_synthesis", "synthesis-model", {
    id: "generation-capability-synthesis-critic",
    inputSummary: {
      phase: "entailment_critic",
      refreshRunId: "refresh-1",
      subsystemKeys: ["project_domain:payments#scope"],
      claimCount: expectedClaimKeys.length,
      claimContentDigest,
      revisionRound,
    },
    parsedOutput: {
      assessments: expectedClaimKeys.map((claimKey) => ({
        claimKey,
        supported: true,
        issues: [],
      })),
    },
    ...overrides,
  });
}

describe("repository knowledge main-path integrity", () => {
  it("accepts successful attributed model extraction and synthesis", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(synthesis),
      ],
      expectedIdentities,
      coverage: [{
        targets: [{ deterministicFallbackPathCount: 0 }],
      }],
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: { semanticOrchestrationGaps: ["One domain is thin."] },
    });

    expect(result).toEqual({
      passed: true,
      issues: [],
      metrics: {
        semanticPlanning: 1,
        semanticExtraction: 1,
        capabilitySynthesis: 1,
        entailmentCritic: 1,
        claimfulSynthesis: 1,
        criticCoveredSynthesis: 1,
        successfulGenerations: 4,
        totalGenerations: 4,
        providerAttemptCount: 4,
        schemaRepairRunCount: 0,
        deterministicSemanticPathCount: 0,
        plannerFallbackAttested: true,
        plannerFallbackUsed: false,
        deterministicSynthesis: false,
        budgetExhausted: false,
      },
    });
  });

  it("rejects claim-emitting synthesis without a matching successful entailment critic", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [{
          text: "Built receipt storage",
          summary: "The service persists payment receipts.",
          citationIndexes: [1],
        }],
      }],
    };
    const staleSynthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(staleSynthesis),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 0,
    });
  });

  it("rejects a critic whose persisted assessments do not cover every synthesized claim", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(synthesis, 0, { parsedOutput: { assessments: [] } }),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
  });

  it("rejects a stale critic with the same round, count, and keys but different claim content", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1, 2],
        }],
        highlights: [],
      }],
    };
    const staleSynthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service retrieves receipts.",
          citationIndexes: [1, 3],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis),
        entailmentCritic(staleSynthesis),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 0,
    });
  });

  it("rejects same-count critic attestations with wrong or duplicate claim keys", () => {
    const invalidAssessmentKeys = [
      [
        "project_domain:payments#scope:fact:1",
        "project_domain:payments#scope:highlight:1",
      ],
      [
        "project_domain:payments#scope:fact:1",
        "project_domain:payments#scope:fact:1",
      ],
    ];
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The payment service persists receipts.",
            citationIndexes: [1],
          },
          {
            statement: "The payment service retrieves receipts.",
            citationIndexes: [2],
          },
        ],
        highlights: [],
      }],
    };
    for (const claimKeys of invalidAssessmentKeys) {
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(synthesis),
          entailmentCritic(synthesis, 0, {
            parsedOutput: {
              assessments: claimKeys.map((claimKey) => ({
                claimKey,
                supported: true,
                issues: [],
              })),
            },
          }),
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(false);
      expect(result.metrics).toMatchObject({
        claimfulSynthesis: 1,
        criticCoveredSynthesis: 0,
      });
    }
  });

  it("accepts a revised synthesis only when its critic attests the same revision round", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis, {
          inputSummary: {
            phase: "synthesis",
            refreshRunId: "refresh-1",
            subsystemKeys: ["project_domain:payments#scope"],
            revisionRound: 1,
          },
        }),
        entailmentCritic(synthesis, 1),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 1,
    });
  });

  it("rejects a critic that only covers another synthesis revision round", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(synthesis, {
          inputSummary: {
            phase: "synthesis",
            refreshRunId: "refresh-1",
            subsystemKeys: ["project_domain:payments#scope"],
            revisionRound: 1,
          },
        }),
        entailmentCritic(synthesis),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
    expect(result.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 0,
    });
  });

  it("rejects legacy capability synthesis rows without phase attestation", () => {
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        generation("capability_synthesis", "synthesis-model", {
          inputSummary: {},
        }),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "No audited capability synthesis generation ran.",
      "1 capability synthesis generation(s) have no valid synthesis-phase attestation.",
    ]));
  });

  it("counts bounded model schema repair without confusing it with deterministic fallback", () => {
    const repairedExtraction = generation("semantic_extraction", "semantic-model", {
      resultRefs: {
        configuredModelId: "semantic-model",
        requestIds: ["generate", "repair"],
        usageComplete: true,
        failedProviderAttempts: [],
        providerAttemptCount: 2,
        transportMode: "text_repair_fallback",
      },
    });
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        repairedExtraction,
        generation("capability_synthesis", "synthesis-model"),
      ],
      expectedIdentities,
      coverage: null,
      orchestration: {
        fallbackUsed: false,
        generationRunId: "generation-execution_routing",
      },
      warnings: null,
    });

    expect(result.passed).toBe(true);
    expect(result.metrics).toMatchObject({
      providerAttemptCount: 4,
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
      orchestration: {
        fallbackUsed: true,
        generationRunId: null,
      },
      warnings: {
        synthesisCoverageGaps: [
          "Repository acme/project used deterministic subsystem synthesis because the shared repository-synthesis budget was exhausted.",
        ],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      "No audited capability synthesis generation ran.",
      "No audited semantic planning generation ran.",
      expect.stringContaining("ended with status provider_error"),
      expect.stringContaining("used provider openrouter"),
      expect.stringContaining("used model fallback-model"),
      expect.stringContaining("has no provider request ID"),
      expect.stringContaining("incomplete model-usage evidence"),
      expect.stringContaining("records failed provider attempts"),
      expect.stringContaining("stopped before a provider dispatch"),
      "2 semantic path(s) used deterministic fallback analysis.",
      "Repository semantic planning used its deterministic fallback.",
      "Repository semantic planning has no audited generation reference.",
      "At least one subsystem used deterministic synthesis.",
      "Repository generation exhausted a model budget.",
    ]));
  });

  it("fails closed when planner fallback attestation is missing or malformed", () => {
    for (const orchestration of [
      { generationRunId: "generation-execution_routing" },
      { generationRunId: "generation-execution_routing", fallbackUsed: "false" },
    ]) {
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          generation("capability_synthesis", "synthesis-model"),
        ],
        expectedIdentities,
        coverage: null,
        orchestration,
        warnings: null,
      });

      expect(result.passed).toBe(false);
      expect(result.issues).toContain(
        "Repository semantic planning has no valid fallback attestation.",
      );
    }
  });
});
