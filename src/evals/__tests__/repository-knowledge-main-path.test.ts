import { describe, expect, it } from "vitest";
import {
  repositorySynthesisClaimContentDigest,
  repositorySynthesisCriticClaimContentDigest,
} from "@/src/domain/repository-synthesis-attestation";
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

function entailmentCriticRejecting(
  parsedSynthesis: unknown,
  rejectedClaimKeys: readonly string[],
  revisionRound = 0,
) {
  const rejected = new Set(rejectedClaimKeys);
  return entailmentCritic(parsedSynthesis, revisionRound, {
    parsedOutput: {
      assessments: claimKeys(parsedSynthesis).map((claimKey) => ({
        claimKey,
        supported: !rejected.has(claimKey),
        issues: rejected.has(claimKey) ? ["unsupported_detail"] : [],
      })),
    },
  });
}

type DeltaCriticClaim = {
  claimKey: string;
  kind: "fact" | "highlight";
  claim: { statement: string } | { text: string; summary: string };
  citationIndexes: number[];
};

type RevisionPatch = {
  factRevisions: Array<{
    claimKey: string;
    replacement: Record<string, unknown> | null;
  }>;
  highlightRevisions: Array<{
    claimKey: string;
    replacement: Record<string, unknown> | null;
  }>;
};

function deltaRevisionGeneration(
  priorSynthesis: unknown,
  revisedSynthesis: unknown,
  revisionPatch: RevisionPatch,
  criticClaims: DeltaCriticClaim[],
  revisionRound = 1,
) {
  const claimContentDigest =
    repositorySynthesisClaimContentDigest(revisedSynthesis);
  const priorClaimContentDigest =
    repositorySynthesisClaimContentDigest(priorSynthesis);
  const criticClaimContentDigest =
    repositorySynthesisCriticClaimContentDigest(criticClaims);
  if (!claimContentDigest || !priorClaimContentDigest) {
    throw new Error("Test revision must contain attestable repository payloads.");
  }
  if (
    !revisedSynthesis ||
    typeof revisedSynthesis !== "object" ||
    Array.isArray(revisedSynthesis)
  ) {
    throw new Error("Test revision must be an object payload.");
  }
  const auditedRevisionPatch = [
    ...revisionPatch.factRevisions.map((entry) => ({
      claimKey: entry.claimKey,
      kind: "fact" as const,
      replacement: entry.replacement === null
        ? null
        : structuredClone(entry.replacement),
    })),
    ...revisionPatch.highlightRevisions.map((entry) => ({
      claimKey: entry.claimKey,
      kind: "highlight" as const,
      replacement: entry.replacement === null
        ? null
        : structuredClone(entry.replacement),
    })),
  ];
  return synthesisGeneration({
    ...revisedSynthesis,
    revisionPatch: auditedRevisionPatch,
  }, {
    id: "generation-capability-synthesis-revision-" + revisionRound,
    inputSummary: {
      phase: "synthesis",
      refreshRunId: "refresh-1",
      subsystemKeys: ["project_domain:payments#scope"],
      revisionRound,
      revisionContract: "rejected_claim_patch_v2_delta_critic",
    },
    resultRefs: {
      configuredModelId: "synthesis-model",
      requestIds: ["request-capability_synthesis-revision-" + revisionRound],
      usageComplete: true,
      failedProviderAttempts: [],
      providerAttemptCount: 1,
      transportMode: "json_schema",
      resultAttestation: {
        claimContentDigest,
        priorClaimContentDigest,
        criticScope: "changed_claims",
        criticClaimCount: criticClaims.length,
        criticClaimKeys: criticClaims.map((claim) => claim.claimKey),
        criticClaimContentDigest,
      },
    },
  });
}

function deltaEntailmentCritic(
  criticClaims: DeltaCriticClaim[],
  revisionRound = 1,
) {
  const claimContentDigest =
    repositorySynthesisCriticClaimContentDigest(criticClaims);
  if (!claimContentDigest) {
    throw new Error("Test delta critic must receive at least one claim.");
  }
  return generation("capability_synthesis", "synthesis-model", {
    id: "generation-capability-synthesis-delta-critic-" + revisionRound,
    inputSummary: {
      phase: "entailment_critic",
      refreshRunId: "refresh-1",
      subsystemKeys: ["project_domain:payments#scope"],
      claimCount: criticClaims.length,
      claimContentDigest,
      revisionRound,
      criticScope: "changed_claims",
    },
    parsedOutput: {
      assessments: criticClaims.map((claim) => ({
        claimKey: claim.claimKey,
        supported: true,
        issues: [],
      })),
    },
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

  it("rejects a revision round that masquerades as a full synthesis", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          { statement: "The service records request latency.", citationIndexes: [2] },
          { statement: "The service persists payment receipts.", citationIndexes: [1] },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[0]],
        highlights: [],
      }],
    };
    const revision = synthesisGeneration(revised, {
      id: "generation-capability-synthesis-revision-1",
      inputSummary: {
        phase: "synthesis",
        refreshRunId: "refresh-1",
        subsystemKeys: ["project_domain:payments#scope"],
        revisionRound: 1,
      },
    });
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCritic(initial),
        revision,
        entailmentCritic(revised, 1),
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
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("rejects synthesis content that differs from its persisted attestation", () => {
    const attested = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service persists payment receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const synthesis = synthesisGeneration(attested);
    synthesis.parsedOutput = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service deletes every customer account.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesis,
        entailmentCritic(attested),
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
      "1 synthesis generation(s) do not attest their emitted claim count.",
    );
  });

  it("rejects duplicate or mislabeled synthesis subsystem batches", () => {
    const synthesisA = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{ statement: "The service persists receipts.", citationIndexes: [1] }],
        highlights: [],
      }],
    };
    const changedA = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{ statement: "The service deletes receipts.", citationIndexes: [1] }],
        highlights: [],
      }],
    };
    for (const secondSubsystemKeys of [
      ["project_domain:payments#scope"],
      ["project_domain:orders#scope"],
    ]) {
      const second = synthesisGeneration(changedA, {
        id: "generation-capability-synthesis-second",
        inputSummary: {
          phase: "synthesis",
          refreshRunId: "refresh-1",
          subsystemKeys: secondSubsystemKeys,
          revisionRound: 0,
        },
      });
      const secondCritic = entailmentCritic(changedA);
      secondCritic.inputSummary = {
        ...(secondCritic.inputSummary as Record<string, unknown>),
        subsystemKeys: secondSubsystemKeys,
      };
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(synthesisA),
          entailmentCritic(synthesisA),
          second,
          secondCritic,
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
    }
  });

  it("rejects revision-only metadata on an initial synthesis", () => {
    const parsedOutput = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{ statement: "The service persists receipts.", citationIndexes: [1] }],
        highlights: [],
      }],
    };
    for (const mutation of ["contract", "scope", "patch"] as const) {
      const synthesis = synthesisGeneration(parsedOutput);
      if (mutation === "contract") {
        synthesis.inputSummary = {
          ...(synthesis.inputSummary as Record<string, unknown>),
          revisionContract: "rejected_claim_patch_v2_delta_critic",
        };
      } else if (mutation === "scope") {
        const refs = synthesis.resultRefs as {
          resultAttestation: Record<string, unknown>;
        };
        refs.resultAttestation.criticScope = "changed_claims";
      } else {
        synthesis.parsedOutput = { ...parsedOutput, revisionPatch: [] };
      }
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesis,
          entailmentCritic(parsedOutput),
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
        "1 initial synthesis generation(s) declare revision-only metadata.",
      );
    }
  });

  it("accepts a chained revision critic that verifies only changed claims", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The service records request latency.",
            citationIndexes: [2],
          },
          {
            statement: "The service encrypts every receipt.",
            citationIndexes: [1],
          },
          {
            statement: "The service publishes a payment receipt.",
            citationIndexes: [1],
          },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          initial.subsystems[0]!.facts[0],
          {
            statement: "The service records an idempotency key.",
            citationIndexes: [1],
          },
          initial.subsystems[0]!.facts[2],
        ],
        highlights: [],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:2",
      kind: "fact",
      claim: { statement: revised.subsystems[0]!.facts[1]!.statement },
      citationIndexes: [1],
    }];
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey: changedClaims[0]!.claimKey,
        replacement: revised.subsystems[0]!.facts[1]!,
      }],
      highlightRevisions: [],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [changedClaims[0]!.claimKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          revisionPatch,
          changedClaims,
        ),
        deltaEntailmentCritic(changedClaims),
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
      capabilitySynthesis: 2,
      entailmentCritic: 2,
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 2,
    });
  });

  it("re-keys a later revision after an earlier positional removal", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          { statement: "The service encrypts every receipt.", citationIndexes: [1] },
          { statement: "The service records request latency.", citationIndexes: [2] },
          { statement: "The service publishes every receipt.", citationIndexes: [1] },
        ],
        highlights: [],
      }],
    };
    const firstReplacement = {
      statement: "The service publishes a payment receipt.",
      citationIndexes: [1],
    };
    const firstRevision = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[1], firstReplacement],
        highlights: [],
      }],
    };
    const firstChangedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:3",
      kind: "fact",
      claim: { statement: firstReplacement.statement },
      citationIndexes: [1],
    }];
    const firstPatch: RevisionPatch = {
      factRevisions: [
        {
          claimKey: "project_domain:payments#scope:fact:1",
          replacement: null,
        },
        {
          claimKey: "project_domain:payments#scope:fact:3",
          replacement: firstReplacement,
        },
      ],
      highlightRevisions: [],
    };
    const firstCritic = deltaEntailmentCritic(firstChangedClaims, 1);
    firstCritic.parsedOutput = {
      assessments: [{
        claimKey: firstChangedClaims[0]!.claimKey,
        supported: false,
        issues: ["unsupported_detail"],
      }],
    };
    const finalReplacement = {
      statement: "The service records an idempotency key.",
      citationIndexes: [1],
    };
    const finalRevision = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [firstRevision.subsystems[0]!.facts[0], finalReplacement],
        highlights: [],
      }],
    };

    for (const [secondPatchKey, expectedPass] of [
      ["project_domain:payments#scope:fact:2", true],
      ["project_domain:payments#scope:fact:3", false],
    ] as const) {
      const secondChangedClaims: DeltaCriticClaim[] = [{
        claimKey: secondPatchKey,
        kind: "fact",
        claim: { statement: finalReplacement.statement },
        citationIndexes: [1],
      }];
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisGeneration(initial),
          entailmentCriticRejecting(initial, [
            "project_domain:payments#scope:fact:1",
            "project_domain:payments#scope:fact:3",
          ]),
          deltaRevisionGeneration(
            initial,
            firstRevision,
            firstPatch,
            firstChangedClaims,
            1,
          ),
          firstCritic,
          deltaRevisionGeneration(
            firstRevision,
            finalRevision,
            {
              factRevisions: [{
                claimKey: secondPatchKey,
                replacement: finalReplacement,
              }],
              highlightRevisions: [],
            },
            secondChangedClaims,
            2,
          ),
          deltaEntailmentCritic(secondChangedClaims, 2),
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

      expect(result.passed).toBe(expectedPass);
      if (!expectedPass) {
        expect(result.issues).toContain(
          "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
        );
      }
    }
  });

  it("rejects a missing or mismatched changed-claim critic", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service encrypts every receipt.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service records an idempotency key.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:1",
      kind: "fact",
      claim: { statement: revised.subsystems[0]!.facts[0]!.statement },
      citationIndexes: [1],
    }];
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey: changedClaims[0]!.claimKey,
        replacement: revised.subsystems[0]!.facts[0]!,
      }],
      highlightRevisions: [],
    };
    const revision = deltaRevisionGeneration(
      initial,
      revised,
      revisionPatch,
      changedClaims,
    );
    const mismatchedCritic = deltaEntailmentCritic(changedClaims);
    mismatchedCritic.inputSummary = {
      ...(mismatchedCritic.inputSummary as Record<string, unknown>),
      claimContentDigest: "0".repeat(64),
    };
    const malformedCritic = deltaEntailmentCritic(changedClaims);
    malformedCritic.parsedOutput = {
      assessments: [{
        claimKey: changedClaims[0]!.claimKey,
        supported: false,
        issues: ["invented_issue"],
      }],
    };
    const baseRuns = [
      generation("execution_routing", "routing-model"),
      generation("semantic_extraction", "semantic-model"),
      synthesisGeneration(initial),
      entailmentCriticRejecting(initial, [changedClaims[0]!.claimKey]),
      revision,
    ];
    for (const criticRuns of [[], [mismatchedCritic], [malformedCritic]]) {
      const result = evaluateRepositoryKnowledgeMainPath({
        generationRuns: [...baseRuns, ...criticRuns],
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
        claimfulSynthesis: 2,
        criticCoveredSynthesis: 1,
      });
      expect(result.issues).toContain(
        "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
      );
    }
  });

  it("rejects a revision whose replacement differs from its delta critic payload", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service encrypts every receipt.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service records an idempotency key.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const claimKey = "project_domain:payments#scope:fact:1";
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey,
        replacement: revised.subsystems[0]!.facts[0]!,
      }],
      highlightRevisions: [],
    };
    const mismatchedCriticClaims: DeltaCriticClaim[] = [{
      claimKey,
      kind: "fact",
      claim: { statement: "The service stores payment receipts." },
      citationIndexes: [1],
    }];
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [claimKey]),
        deltaRevisionGeneration(
          initial,
          revised,
          revisionPatch,
          mismatchedCriticClaims,
        ),
        deltaEntailmentCritic(mismatchedCriticClaims),
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
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 1,
    });
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("rejects an all-null revision that removes a supported claim", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The service records request latency.",
            citationIndexes: [2],
          },
          {
            statement: "The service encrypts every receipt.",
            citationIndexes: [1],
          },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[0]],
        highlights: [],
      }],
    };
    const removedClaimKey = "project_domain:payments#scope:fact:2";
    const revisionPatch: RevisionPatch = {
      factRevisions: [{ claimKey: removedClaimKey, replacement: null }],
      highlightRevisions: [],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCritic(initial),
        deltaRevisionGeneration(initial, revised, revisionPatch, []),
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
      capabilitySynthesis: 2,
      entailmentCritic: 1,
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 1,
    });
    expect(result.issues).toContain(
      "1 changed-claim synthesis revision(s) do not chain to the exact prior subsystem payload.",
    );
  });

  it("accepts an authorized all-null revision without an empty critic call", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [
          {
            statement: "The service records request latency.",
            citationIndexes: [2],
          },
          {
            statement: "The service encrypts every receipt.",
            citationIndexes: [1],
          },
        ],
        highlights: [],
      }],
    };
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [initial.subsystems[0]!.facts[0]],
        highlights: [],
      }],
    };
    const removedClaimKey = "project_domain:payments#scope:fact:2";
    const revisionPatch: RevisionPatch = {
      factRevisions: [{ claimKey: removedClaimKey, replacement: null }],
      highlightRevisions: [],
    };
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [removedClaimKey]),
        deltaRevisionGeneration(initial, revised, revisionPatch, []),
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
      capabilitySynthesis: 2,
      entailmentCritic: 1,
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 2,
    });
  });

  it("rejects a delta revision whose prior-payload chain is not attested", () => {
    const initial = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const changedClaims: DeltaCriticClaim[] = [{
      claimKey: "project_domain:payments#scope:fact:1",
      kind: "fact",
      claim: { statement: "The service stores payment receipts." },
      citationIndexes: [1],
    }];
    const revised = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The service stores payment receipts.",
          citationIndexes: [1],
        }],
        highlights: [],
      }],
    };
    const revisionPatch: RevisionPatch = {
      factRevisions: [{
        claimKey: changedClaims[0]!.claimKey,
        replacement: revised.subsystems[0]!.facts[0]!,
      }],
      highlightRevisions: [],
    };
    const revision = deltaRevisionGeneration(
      initial,
      revised,
      revisionPatch,
      changedClaims,
    );
    const refs = revision.resultRefs as {
      resultAttestation: Record<string, unknown>;
    };
    refs.resultAttestation.priorClaimContentDigest = "0".repeat(64);
    const result = evaluateRepositoryKnowledgeMainPath({
      generationRuns: [
        generation("execution_routing", "routing-model"),
        generation("semantic_extraction", "semantic-model"),
        synthesisGeneration(initial),
        entailmentCriticRejecting(initial, [changedClaims[0]!.claimKey]),
        revision,
        deltaEntailmentCritic(changedClaims),
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
      claimfulSynthesis: 2,
      criticCoveredSynthesis: 1,
    });
    expect(result.issues).toContain(
      "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
    );
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

  it("accepts an initial synthesis only when its critic attests the same revision round", () => {
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
            revisionRound: 0,
          },
        }),
        entailmentCritic(synthesis, 0),
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

  it("requires an exact successful critic attestation", () => {
    const synthesis = {
      subsystems: [{
        subsystemKey: "project_domain:payments#scope",
        facts: [{
          statement: "The payment service persists receipts.",
          citationIndexes: [1],
        }],
        highlights: [{
          text: "Built durable receipt storage",
          summary: "The payment service persists receipts for later retrieval.",
          citationIndexes: [1],
        }],
      }],
    };
    const synthesisRun = synthesisGeneration(synthesis, {
      inputSummary: {
        phase: "synthesis",
        refreshRunId: "refresh-1",
        subsystemKeys: ["project_domain:payments#scope"],
        revisionRound: 0,
      },
    });
    const matchingCritic = entailmentCritic(synthesis, 0);
    const evaluate = (critic: RepositoryKnowledgeGenerationAuditRecord) =>
      evaluateRepositoryKnowledgeMainPath({
        generationRuns: [
          generation("execution_routing", "routing-model"),
          generation("semantic_extraction", "semantic-model"),
          synthesisRun,
          critic,
        ],
        expectedIdentities,
        coverage: null,
        orchestration: {
          fallbackUsed: false,
          generationRunId: "generation-execution_routing",
        },
        warnings: null,
      });

    const accepted = evaluate(matchingCritic);
    expect(accepted.passed).toBe(true);
    expect(accepted.metrics).toMatchObject({
      claimfulSynthesis: 1,
      criticCoveredSynthesis: 1,
    });

    const criticSummary = matchingCritic.inputSummary as Record<string, unknown>;
    const mismatches: RepositoryKnowledgeGenerationAuditRecord[] = [
      {
        ...matchingCritic,
        inputSummary: {
          ...criticSummary,
          subsystemKeys: ["project_domain:refunds#scope"],
        },
      },
      {
        ...matchingCritic,
        inputSummary: {
          ...criticSummary,
          claimCount: 1,
        },
      },
      {
        ...matchingCritic,
        parsedOutput: {
          assessments: [
            {
              claimKey: "project_domain:payments#scope:fact:1",
              supported: true,
              issues: [],
            },
            {
              claimKey: "project_domain:payments#scope:fact:1",
              supported: true,
              issues: [],
            },
          ],
        },
      },
      {
        ...matchingCritic,
        inputSummary: {
          ...criticSummary,
          claimContentDigest: "0".repeat(64),
        },
      },
      {
        ...matchingCritic,
        status: "provider_error",
      },
    ];
    for (const mismatch of mismatches) {
      const rejected = evaluate(mismatch);
      expect(rejected.passed).toBe(false);
      expect(rejected.issues).toContain(
        "1 claim-emitting synthesis generation(s) lack a successful entailment critic for the same subsystem batch, revision round, and exact claim payload.",
      );
      expect(rejected.metrics).toMatchObject({
        claimfulSynthesis: 1,
        criticCoveredSynthesis: 0,
      });
    }
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
        synthesisGeneration({
          subsystems: [{
            subsystemKey: "project_domain:payments#scope",
            facts: [],
            highlights: [],
          }],
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
