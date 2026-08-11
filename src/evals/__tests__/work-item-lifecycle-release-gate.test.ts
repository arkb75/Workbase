import { describe, expect, it } from "vitest";
import {
  PREVIOUS_WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
  WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
  evaluateWorkItemLifecycleObservation,
  evaluateWorkItemLifecycleReleaseGate,
  workItemLifecycleScenarioIds,
  type WorkItemLifecycleObservation,
  type WorkItemLifecycleScenarioId,
} from "@/src/evals/work-item-lifecycle-release-gate";

const CURRENT_SHA = "a".repeat(40);
const PRIOR_SHA = "b".repeat(40);

function lineage(prefix: string) {
  return {
    workItemId: `${prefix}-work-item`,
    sourceIds: [`${prefix}-source`],
    refreshRunIds: [`${prefix}-refresh`],
    snapshotIds: [`${prefix}-snapshot`],
    evidenceItemIds: [`${prefix}-evidence-1`, `${prefix}-evidence-2`],
    highlightIds: [`${prefix}-highlight-1`, `${prefix}-highlight-2`],
    projectFactIds: [`${prefix}-fact`],
    generationRunIds: [`${prefix}-generation`, `${prefix}-verification`],
  };
}

type ManualObservation = Extract<
  WorkItemLifecycleObservation,
  { scenarioId: "manual_only_create" }
>;
type RepositoryScenarioId = Exclude<
  WorkItemLifecycleScenarioId,
  "manual_only_create"
>;
type RepositoryObservation = Exclude<
  WorkItemLifecycleObservation,
  ManualObservation
>;

function repositoryGenerationRun(
  id: string,
  kind: string,
  modelId: string,
  profile: string,
): RepositoryObservation["automation"]["generationRuns"][number] {
  return {
    id,
    kind,
    status: "success",
    provider: "openrouter",
    configuredProvider: "openrouter",
    modelId,
    profile,
    configuredModelId: modelId,
    requestIds: [`request-${id}`],
    tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    tokenUsagePresent: true,
    estimatedCostUsd: 0.01,
    usageComplete: true,
    auditAttemptCount: 1,
    providerAttemptCount: 1,
    failedProviderAttempts: 0,
    unknownUsageAttempts: 0,
    auditEvidenceTruncated: false,
    agentRunId: null,
    role: "provider_call",
    authoritativeGenerationRunId: null,
    providerBatchGenerationRunIds: [],
  };
}

function manualObservation(): ManualObservation {
  const current = lineage("current-manual-only-create");
  const sourceId = current.sourceIds[0];
  const evidenceItemId = current.evidenceItemIds[0];
  const highlightId = current.highlightIds[0];
  const agentRunId = "manual-only-create-agent-run";
  const generationRunId = "manual-only-create-highlight-generation";
  const verificationRunId = "manual-only-create-highlight-verification";
  current.highlightIds = [highlightId];
  current.evidenceItemIds = [evidenceItemId];
  current.generationRunIds = [generationRunId, verificationRunId];
  const generationRun = (
    kind: "highlight_generation" | "highlight_verification",
    id: string,
  ): ManualObservation["manualAgentRun"]["generationRuns"][number] => ({
    id,
    kind,
    status: "success",
    provider: "openrouter",
    configuredProvider: "openrouter",
    modelId: kind === "highlight_generation"
      ? "openai/gpt-5.4-mini"
      : "openai/gpt-5.4-nano",
    profile: kind === "highlight_generation" ? "drafting" : "verification",
    configuredModelId: kind === "highlight_generation"
      ? "openai/gpt-5.4-mini"
      : "openai/gpt-5.4-nano",
    requestIds: [`request-${id}`],
    tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    tokenUsagePresent: true,
    estimatedCostUsd: 0.001,
    usageComplete: true,
    auditAttemptCount: 1,
    providerAttemptCount: 1,
    failedProviderAttempts: 0,
    unknownUsageAttempts: 0,
    auditEvidenceTruncated: false,
    agentRunId,
    role: "provider_call",
    authoritativeGenerationRunId: null,
    providerBatchGenerationRunIds: [],
  });
  return {
    schemaVersion: WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
    scenarioId: "manual_only_create",
    provider: "openrouter",
    observedAt: "2026-08-09T18:00:00.000Z",
    initialState: {
      workItemExisted: false,
      sourceCount: 0,
      highlightCount: 0,
    },
    terminalOutcome: { status: "completed", message: null },
    manualEvidence: {
      sourceIds: [sourceId],
      evidenceItemIds: [evidenceItemId],
    },
    manualAgentRun: {
      id: agentRunId,
      kind: "manual_evidence_highlights",
      status: "completed",
      workflowId: "workflow-manual-only-create",
      error: null,
      request: {
        trigger: "work_item_create",
        sourceIds: [sourceId],
        evidenceItemIds: [evidenceItemId],
        inputFingerprint: "manual-fingerprint",
      },
      result: {
        terminalOutcome: "ready",
        createdHighlightIds: [highlightId],
        replayedHighlightIds: [],
        deduplicatedHighlightIds: [],
        suggestionIds: [],
        suppressedHighlightIds: [],
        generationRunIds: [generationRunId, verificationRunId],
        managedBy: "manual_evidence_highlight_workflow",
        inputFingerprint: "manual-fingerprint",
      },
      generationRuns: [
        generationRun("highlight_generation", generationRunId),
        generationRun("highlight_verification", verificationRunId),
      ],
      expectedModelIds: {
        drafting: "openai/gpt-5.4-mini",
        verification: "openai/gpt-5.4-nano",
      },
    },
    automaticHighlights: [{
      id: highlightId,
      text: "Led a grounded migration with durable provider quality gates.",
      lifecycleStatus: "active",
      verificationStatus: "approved",
      reviewState: "pending_review",
      approvalSource: "automation",
      managedBy: "manual_evidence_highlight_workflow",
      originatingAgentRunId: agentRunId,
      supersedesHighlightId: null,
      evidenceItemIds: [evidenceItemId],
      evidence: [{
        evidenceItemId,
        sourceId,
        sourceType: "manual_note",
      }],
      validatedThroughSha: null,
      validationHeads: [],
    }],
    currentLineage: current,
    leakedPriorEntityIds: [],
    sloMs: {
      agentRunTerminal: 120_000,
      automaticHighlightsTerminal: 120_000,
      total: 120_000,
    },
    timingsMs: {
      actionAcknowledged: 500,
      sourceReserved: 200,
      agentRunReserved: 300,
      agentRunTerminal: 12_000,
      automaticHighlightsTerminal: 12_000,
      total: 12_000,
    },
  };
}

function observation(scenarioId: "manual_only_create"): ManualObservation;
function observation(scenarioId: RepositoryScenarioId): RepositoryObservation;
function observation(
  scenarioId: WorkItemLifecycleScenarioId,
): WorkItemLifecycleObservation;
function observation(
  scenarioId: WorkItemLifecycleScenarioId,
): WorkItemLifecycleObservation {
  if (scenarioId === "manual_only_create") return manualObservation();
  const current = lineage(`current-${scenarioId}`);
  const semanticExtractionRunId = `${scenarioId}-semantic-extraction`;
  const capabilitySynthesisRunId = `${scenarioId}-capability-synthesis`;
  current.generationRunIds = [
    semanticExtractionRunId,
    capabilitySynthesisRunId,
  ];
  const sourceId = current.sourceIds[0];
  const head = {
    sourceId,
    repositoryId: "repo-workbase",
    repository: "arkb75/Workbase",
    commitSha: CURRENT_SHA,
  };
  const manualSourceId = `current-${scenarioId}-manual-source`;
  const manualEvidenceId = `current-${scenarioId}-manual-evidence`;
  const manualHighlightId = `current-${scenarioId}-manual-highlight`;
  const manualAgentRunId = `current-${scenarioId}-manual-agent-run`;
  const baselineAutomaticHighlights = scenarioId === "existing_attach"
    ? [{
        id: manualHighlightId,
        text: "Implemented durable current-head repository import fencing.",
        lifecycleStatus: "active",
        verificationStatus: "approved",
        reviewState: "pending_review",
        approvalSource: "automation",
        managedBy: "manual_evidence_highlight_workflow",
        originatingAgentRunId: manualAgentRunId,
        supersedesHighlightId: null,
        evidenceItemIds: [manualEvidenceId],
        evidence: [{
          evidenceItemId: manualEvidenceId,
          sourceId: manualSourceId,
          sourceType: "manual_note",
        }],
        validatedThroughSha: null,
        validationHeads: [],
      }]
    : [];
  if (scenarioId === "existing_attach") {
    current.sourceIds.push(manualSourceId);
    current.evidenceItemIds.push(manualEvidenceId);
    current.highlightIds.push(manualHighlightId);
  }
  return {
    schemaVersion: WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
    scenarioId,
    provider: "openrouter",
    observedAt: "2026-08-09T18:00:00.000Z",
    initialState: {
      workItemExisted: scenarioId !== "empty_create_attach",
      sourceCount: 0,
      highlightCount: baselineAutomaticHighlights.length,
    },
    repository: {
      repositoryId: "repo-workbase",
      fullName: "arkb75/Workbase",
      configuredFullName: "arkb75/Workbase",
      canonicalized: false,
      expectedHeadSha: CURRENT_SHA,
      sourceId,
      sourceRevisionSha: CURRENT_SHA,
      targetHeads: [head],
      completedHeads: [head],
    },
    repositoryImport: {
      requestId: `request-${scenarioId}`,
      workflowId: `import-workflow-${scenarioId}`,
      refreshRunId: current.refreshRunIds[0],
      status: "evidence_ready",
      error: null,
      evidenceCount: 42,
    },
    refresh: {
      id: current.refreshRunIds[0],
      status: "completed",
      qualityStatus: "verified",
      error: null,
    },
    snapshots: [{
      id: current.snapshotIds[0],
      sourceId,
      commitSha: CURRENT_SHA,
      inventoryComplete: true,
      analysisComplete: true,
      coverageComplete: true,
    }],
    baselineAutomaticHighlights,
    automaticHighlights: [
      ...baselineAutomaticHighlights.map((highlight) => ({
        ...highlight,
        evidenceItemIds: [...highlight.evidenceItemIds],
        evidence: highlight.evidence.map((entry) => ({ ...entry })),
        validationHeads: [...highlight.validationHeads],
      })),
      {
        id: current.highlightIds[0],
        text: "Built current repository intelligence with exact revision fences.",
        lifecycleStatus: "active",
        verificationStatus: "approved",
        reviewState: "pending_review",
        approvalSource: "automation",
        managedBy: "repository_knowledge_sync",
        originatingAgentRunId: null,
        supersedesHighlightId: null,
        evidenceItemIds: [current.evidenceItemIds[0]],
        evidence: [{
          evidenceItemId: current.evidenceItemIds[0],
          sourceId,
          sourceType: "github_repo",
        }],
        validatedThroughSha: CURRENT_SHA,
        validationHeads: [head],
      },
      {
        id: current.highlightIds[1],
        text: "Added grounded automatic Highlights with durable evidence.",
        lifecycleStatus: "active",
        verificationStatus: "approved",
        reviewState: "pending_review",
        approvalSource: "automation",
        managedBy: "repository_knowledge_sync",
        originatingAgentRunId: null,
        supersedesHighlightId: null,
        evidenceItemIds: [current.evidenceItemIds[1]],
        evidence: [{
          evidenceItemId: current.evidenceItemIds[1],
          sourceId,
          sourceType: "github_repo",
        }],
        validatedThroughSha: CURRENT_SHA,
        validationHeads: [head],
      },
    ],
    automation: {
      status: "completed",
      repositorySynthesisMode: "model",
      expectedDeepSynthesisModelId: "openai/gpt-5.6-terra",
      generationRunIds: [...current.generationRunIds],
      failedGenerationRunIds: [],
      semanticExtractionRunIds: [semanticExtractionRunId],
      failedSemanticExtractionRunIds: [],
      capabilitySynthesisRuns: [repositoryGenerationRun(
        capabilitySynthesisRunId,
        "capability_synthesis",
        "openai/gpt-5.6-terra",
        "deep_synthesis",
      ) as RepositoryObservation["automation"]["capabilitySynthesisRuns"][number]],
      generationRuns: [
        repositoryGenerationRun(
          semanticExtractionRunId,
          "semantic_extraction",
          "openai/gpt-5.4-mini",
          "code_extraction",
        ),
        repositoryGenerationRun(
          capabilitySynthesisRunId,
          "capability_synthesis",
          "openai/gpt-5.6-terra",
          "deep_synthesis",
        ),
      ],
      observedProviders: ["openrouter"],
      observedModelIds: ["openai/gpt-5.6-terra"],
    },
    terminalOutcome: {
      status: "completed",
      message: null,
    },
    currentLineage: current,
    priorLineage: scenarioId === "completed_delete_readd_same_repo"
      ? (() => {
          const prior = lineage("prior");
          const priorSemanticRunId = "prior-semantic-extraction";
          const priorSynthesisRunId = "prior-capability-synthesis";
          prior.generationRunIds = [priorSemanticRunId, priorSynthesisRunId];
          return {
            ...prior,
            repositoryId: "repo-workbase",
            repository: "arkb75/Workbase",
            completedBeforeDeletion: true,
            completedHeadSha: CURRENT_SHA,
            automaticHighlightCount: 2,
            generationRuns: [
              repositoryGenerationRun(
                priorSemanticRunId,
                "semantic_extraction",
                "openai/gpt-5.4-mini",
                "code_extraction",
              ),
              repositoryGenerationRun(
                priorSynthesisRunId,
                "capability_synthesis",
                "openai/gpt-5.6-terra",
                "deep_synthesis",
              ),
            ],
            deleted: true,
          };
        })()
      : null,
    leakedPriorEntityIds: [],
    sloMs: {
      evidenceReady: 120_000,
      refreshTerminal: 600_000,
      automaticHighlightsTerminal: 600_000,
      total: 600_000,
    },
    timingsMs: {
      actionAcknowledged: 500,
      sourceReserved: 250,
      evidenceReady: 2_000,
      refreshTerminal: 40_000,
      automaticHighlightsTerminal: 45_000,
      total: 45_000,
    },
  };
}

describe("work-item lifecycle release gate", () => {
  it.each(workItemLifecycleScenarioIds)(
    "accepts a complete, current, duplicate-free %s observation",
    (scenarioId) => {
      const result = evaluateWorkItemLifecycleObservation(
        observation(scenarioId),
      );
      expect(
        result.passed,
        JSON.stringify(result.checks.filter((check) => !check.passed)),
      ).toBe(true);
      expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    },
  );

  it("rejects a manual path without a terminal durable AgentRun", () => {
    const input = observation("manual_only_create");
    input.manualAgentRun.status = "running";
    input.manualAgentRun.workflowId = null;
    input.manualAgentRun.result = null;
    input.terminalOutcome = {
      status: "timed_out",
      message: "manual_agent_run_timed_out",
    };

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "terminal_outcome_completed",
        "terminal_outcome_has_no_error",
        "manual_agent_run_completed",
        "manual_agent_run_has_durable_workflow",
        "manual_agent_run_result_is_ready",
      ]));
  });

  it("requires attributed successful generation and verification for manual Highlights", () => {
    const input = observation("manual_only_create");
    const generation = input.manualAgentRun.generationRuns[0];
    generation.provider = "bedrock";
    generation.requestIds = [];
    generation.usageComplete = false;
    generation.failedProviderAttempts = [{ requestId: "failed-request" }] as
      unknown as number;
    input.manualAgentRun.generationRuns = [generation];
    input.manualAgentRun.result!.generationRunIds = [generation.id];
    input.currentLineage.generationRunIds = [generation.id];

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "manual_highlight_generation_and_verification_ran",
        "manual_generation_runs_are_attributed_and_metered",
      ]));
    expect(
      result.observation.scenarioId === "manual_only_create" &&
        result.observation.manualAgentRun.generationRuns[0]
          ?.failedProviderAttempts,
    ).toBe(1);
  });

  it("accepts metered provider verification batches behind one deterministic aggregate", () => {
    const input = observation("manual_only_create");
    const generation = input.manualAgentRun.generationRuns[0]!;
    const firstVerification = input.manualAgentRun.generationRuns[1]!;
    const aggregateId = "manual-only-create-verification-aggregate";
    const secondVerificationId = "manual-only-create-highlight-verification-2";
    firstVerification.authoritativeGenerationRunId = aggregateId;
    const secondVerification = {
      ...firstVerification,
      id: secondVerificationId,
      requestIds: [`request-${secondVerificationId}`],
    };
    const aggregate: typeof firstVerification = {
      id: aggregateId,
      kind: "highlight_verification",
      role: "verification_aggregate",
      status: "success",
      provider: "deterministic",
      modelId: "highlight-verification-aggregate-v1",
      profile: "verification",
      configuredProvider: "openrouter",
      configuredModelId: "openai/gpt-5.4-nano",
      requestIds: firstVerification.requestIds.concat(
        secondVerification.requestIds,
      ),
      tokenUsage: null,
      tokenUsagePresent: false,
      estimatedCostUsd: null,
      usageComplete: true,
      auditAttemptCount: 0,
      providerAttemptCount: 0,
      failedProviderAttempts: 0,
      unknownUsageAttempts: 0,
      auditEvidenceTruncated: false,
      agentRunId: input.manualAgentRun.id,
      authoritativeGenerationRunId: null,
      providerBatchGenerationRunIds: [
        firstVerification.id,
        secondVerification.id,
      ],
    };
    input.manualAgentRun.generationRuns = [
      generation,
      firstVerification,
      secondVerification,
      aggregate,
    ];
    input.manualAgentRun.result!.generationRunIds = [
      generation.id,
      aggregate.id,
    ];
    input.currentLineage.generationRunIds = input.manualAgentRun.generationRuns
      .map((run) => run.id);

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(true);
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);

    aggregate.providerBatchGenerationRunIds = [firstVerification.id];
    const incomplete = evaluateWorkItemLifecycleObservation(input);
    expect(incomplete.passed).toBe(false);
    expect(incomplete.checks.find((check) =>
      check.id === "manual_verification_authority_is_complete"
    )?.passed).toBe(false);
  });

  it("rejects manual Highlights with unknown ownership or ungrounded evidence", () => {
    const input = observation("manual_only_create");
    const highlight = input.automaticHighlights[0];
    highlight.reviewState = "reviewed";
    highlight.managedBy = "repository_knowledge_sync";
    highlight.evidence[0].sourceType = "github_repo";

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "manual_highlights_include_active_grounded_pending_review_result",
        "manual_highlights_have_no_unknown_ownership_or_evidence",
      ]));
  });

  it("hard-gates manual action, Source, and AgentRun reservation at five seconds", () => {
    const input = observation("manual_only_create");
    input.timingsMs.actionAcknowledged = 5_001;
    input.timingsMs.sourceReserved = 5_001;
    input.timingsMs.agentRunReserved = 5_001;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "manual_path_action_acknowledged_within_5s",
        "manual_path_source_reserved_within_5s",
        "manual_path_agent_run_reserved_within_5s",
      ]));
  });

  it("allows an existing Work Item to retain pre-attach Highlights", () => {
    const input = observation("existing_attach");

    expect(evaluateWorkItemLifecycleObservation(input).passed).toBe(true);
  });

  it("accepts quarantined manual baseline rows alongside new repository Highlights", () => {
    const input = observation("existing_attach");
    const quarantined = {
      ...input.baselineAutomaticHighlights[0],
      id: "quarantined-manual-baseline",
      text: "Captured a sensitive operational detail for explicit review.",
      lifecycleStatus: "quarantined",
      verificationStatus: "flagged",
      evidenceItemIds: ["quarantined-manual-evidence"],
      evidence: [{
        evidenceItemId: "quarantined-manual-evidence",
        sourceId: "quarantined-manual-source",
        sourceType: "manual_note",
      }],
    };
    input.baselineAutomaticHighlights.push(quarantined);
    input.automaticHighlights.unshift(quarantined);
    input.initialState.highlightCount += 1;
    input.currentLineage.sourceIds.push("quarantined-manual-source");
    input.currentLineage.evidenceItemIds.push("quarantined-manual-evidence");
    input.currentLineage.highlightIds.push(quarantined.id);

    expect(evaluateWorkItemLifecycleObservation(input).passed).toBe(true);
  });

  it("accepts a same-ID manual baseline Highlight transitioned to current-head evidence", () => {
    const input = observation("existing_attach");
    const baseline = input.baselineAutomaticHighlights[0];
    const final = input.automaticHighlights.find((highlight) =>
      highlight.id === baseline.id
    )!;
    final.validatedThroughSha = CURRENT_SHA;
    final.validationHeads = [input.repository.targetHeads[0]];
    final.evidenceItemIds.push(input.currentLineage.evidenceItemIds[0]);
    final.evidence.push({
      evidenceItemId: input.currentLineage.evidenceItemIds[0],
      sourceId: input.repository.sourceId,
      sourceType: "github_repo",
    });
    input.automaticHighlights = input.automaticHighlights.filter((highlight) =>
      highlight.managedBy !== "repository_knowledge_sync"
    );

    expect(evaluateWorkItemLifecycleObservation(input).passed).toBe(true);
  });

  it("rejects missing baseline rows and unknown post-attach Highlight ownership", () => {
    const input = observation("existing_attach");
    const baselineId = input.baselineAutomaticHighlights[0].id;
    input.automaticHighlights = input.automaticHighlights.filter((highlight) =>
      highlight.id !== baselineId
    );
    input.automaticHighlights[0].managedBy = "legacy_bootstrap";

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "existing_attach_preserves_every_baseline_highlight",
        "existing_attach_has_no_unknown_highlight_ownership",
      ]));
  });

  it("rejects a terminal-looking run whose current-head fields disagree", () => {
    const input = observation("empty_create_attach");
    input.repository.sourceRevisionSha = PRIOR_SHA;
    input.repository.completedHeads[0].commitSha = PRIOR_SHA;
    input.automaticHighlights[0].validatedThroughSha = PRIOR_SHA;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "source_revision_matches_expected_head",
        "completed_heads_are_exactly_current",
        "automatic_highlights_are_validated_at_exact_current_head",
      ]));
  });

  it("retains canonical repository diagnostics and rejects a contradictory flag", () => {
    const input = observation("empty_create_attach");
    input.repository.configuredFullName = "rafaykhurram/Workbase";
    input.repository.canonicalized = true;

    const canonical = evaluateWorkItemLifecycleObservation(input);
    expect(canonical.passed).toBe(true);
    if (canonical.observation.scenarioId === "manual_only_create") {
      throw new Error("Expected a repository lifecycle observation.");
    }
    expect(canonical.observation.repository).toMatchObject({
      configuredFullName: "rafaykhurram/Workbase",
      fullName: "arkb75/Workbase",
      canonicalized: true,
    });

    input.repository.canonicalized = false;
    const contradictory = evaluateWorkItemLifecycleObservation(input);
    expect(contradictory.passed).toBe(false);
    expect(contradictory.checks.find((check) =>
      check.id === "canonical_repository_identity_is_explicit"
    )?.passed).toBe(false);
  });

  it("normalizes compatible v2 observations but rejects unverifiable legacy repository identity", () => {
    const compatibleRepository = {
      ...observation("empty_create_attach"),
      schemaVersion:
        PREVIOUS_WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
    };
    const compatibleManual = {
      ...observation("manual_only_create"),
      schemaVersion:
        PREVIOUS_WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
    };

    expect(evaluateWorkItemLifecycleObservation(compatibleRepository)
      .observation.schemaVersion).toBe(
        WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
      );
    expect(evaluateWorkItemLifecycleObservation(compatibleManual)
      .observation.schemaVersion).toBe(
        WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
      );

    const unverifiable = structuredClone(compatibleRepository) as unknown as {
      repository: Record<string, unknown>;
    };
    delete unverifiable.repository.configuredFullName;
    delete unverifiable.repository.canonicalized;

    expect(() => evaluateWorkItemLifecycleObservation(unverifiable)).toThrow(
      /v2 repository observations predate.*canonical.*Rerun.*v3 evidence/iu,
    );
  });

  it("rejects normalized duplicate Highlights", () => {
    const input = observation("existing_attach");
    input.automaticHighlights[2].text =
      "BUILT current repository-intelligence with exact revision fences!";

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "automatic_highlights_have_no_duplicate_text",
      passed: false,
    }));
  });

  it("rejects any automatic Highlight created outside repository reconciliation", () => {
    const input = observation("existing_attach");
    input.automaticHighlights.push({
      ...input.automaticHighlights[0],
      id: "legacy-bootstrap-highlight",
      text: "A legacy plain-create bootstrap generated this automatic Highlight.",
      managedBy: "legacy_bootstrap",
      validatedThroughSha: null,
      validationHeads: [],
    });

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "automatic_highlights_are_validated_at_exact_current_head",
        "automatic_highlights_are_active_approved_automatic_and_grounded",
      ]));
  });

  it("requires an explicit successful terminal outcome and automation result", () => {
    const input = observation("existing_attach");
    input.terminalOutcome = {
      status: "timed_out",
      message: "The scenario never reached a terminal application state.",
    };
    input.automation.status = "pending";

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "terminal_outcome_completed",
        "terminal_outcome_has_no_error",
        "automatic_highlight_generation_completed",
      ]));
  });

  it("fails the gate on semantic extraction failures", () => {
    const input = observation("empty_create_attach");
    input.automation.failedSemanticExtractionRunIds = [
      input.automation.semanticExtractionRunIds[0],
    ];

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "semantic_extraction_has_no_failed_runs",
      passed: false,
    }));
  });

  it("fails closed when semantic extraction cost telemetry is missing", () => {
    const input = observation("empty_create_attach");
    const semanticRun = input.automation.generationRuns.find((run) =>
      run.kind === "semantic_extraction"
    )!;
    semanticRun.estimatedCostUsd = null;
    semanticRun.usageComplete = false;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "all_repository_provider_runs_have_complete_attribution_and_cost",
      passed: false,
    }));
  });

  it("requires deleted-lineage provider costs to be captured before cascade deletion", () => {
    const input = observation("completed_delete_readd_same_repo");
    input.priorLineage!.generationRuns = [];

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "deleted_prior_lineage_provider_cost_was_captured_before_deletion",
      passed: false,
    }));
  });

  it("rejects deterministic synthesis as non-representative", () => {
    const input = observation("empty_create_attach");
    input.automation.repositorySynthesisMode = "deterministic";

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "repository_synthesis_mode_is_model",
      passed: false,
    }));
  });

  it("requires a successful deep-synthesis GenerationRun", () => {
    const input = observation("empty_create_attach");
    input.automation.capabilitySynthesisRuns = [];

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "model_backed_capability_synthesis_ran",
        "capability_synthesis_attribution_and_usage_are_authoritative",
      ]));
  });

  it("rejects failed or incomplete capability synthesis", () => {
    const input = observation("empty_create_attach");
    const run = input.automation.capabilitySynthesisRuns[0]!;
    run.status = "provider_error";
    run.usageComplete = false;
    run.failedProviderAttempts = 1;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "model_backed_capability_synthesis_ran",
        "capability_synthesis_has_no_failed_runs",
        "capability_synthesis_attribution_and_usage_are_authoritative",
      ]));
  });

  it("normalizes audit-shaped failed-provider attempt arrays while retaining numeric observations", () => {
    const noFailures = observation("empty_create_attach") as unknown as {
      automation: {
        capabilitySynthesisRuns: Array<{ failedProviderAttempts: unknown }>;
      };
    };
    noFailures.automation.capabilitySynthesisRuns[0]!.failedProviderAttempts = [];

    const normalized = evaluateWorkItemLifecycleObservation(noFailures);
    expect(normalized.passed).toBe(true);
    if (normalized.observation.scenarioId === "manual_only_create") {
      throw new Error("Expected a repository lifecycle observation.");
    }
    expect(
      normalized.observation.automation.capabilitySynthesisRuns[0]
        ?.failedProviderAttempts,
    ).toBe(0);

    const withFailure = observation("empty_create_attach") as unknown as {
      automation: {
        capabilitySynthesisRuns: Array<{ failedProviderAttempts: unknown }>;
      };
    };
    withFailure.automation.capabilitySynthesisRuns[0]!.failedProviderAttempts = [{
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      requestId: "failed-request",
    }];

    const rejected = evaluateWorkItemLifecycleObservation(withFailure);
    expect(rejected.passed).toBe(false);
    if (rejected.observation.scenarioId === "manual_only_create") {
      throw new Error("Expected a repository lifecycle observation.");
    }
    expect(
      rejected.observation.automation.capabilitySynthesisRuns[0]
        ?.failedProviderAttempts,
    ).toBe(1);
    expect(rejected.checks).toContainEqual(expect.objectContaining({
      id: "capability_synthesis_attribution_and_usage_are_authoritative",
      passed: false,
    }));
  });

  it("rejects mismatched or incomplete synthesis attribution", () => {
    const input = observation("empty_create_attach");
    const run = input.automation.capabilitySynthesisRuns[0]!;
    run.modelId = "anthropic/claude-sonnet-5";
    run.requestIds = [];
    run.tokenUsagePresent = false;
    run.estimatedCostUsd = null;
    run.unknownUsageAttempts = 1;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "capability_synthesis_attribution_and_usage_are_authoritative",
      passed: false,
    }));
  });

  it("rejects environment labels that disagree with persisted generation runs", () => {
    const input = observation("empty_create_attach");
    input.automation.observedProviders = ["bedrock"];
    input.automation.observedModelIds = [];

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "generation_runs_match_declared_provider",
        "generation_runs_record_model_identity",
      ]));
  });

  it("enforces acknowledgement, reservation, and configured cold-path SLOs", () => {
    const input = observation("existing_attach");
    input.timingsMs.actionAcknowledged = 5_001;
    input.timingsMs.sourceReserved = 5_001;
    input.timingsMs.evidenceReady = input.sloMs.evidenceReady + 1;
    input.timingsMs.refreshTerminal = input.sloMs.refreshTerminal + 1;
    input.timingsMs.automaticHighlightsTerminal =
      input.sloMs.automaticHighlightsTerminal + 1;
    input.timingsMs.total = input.sloMs.total + 1;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "cold_path_action_acknowledged_within_5s",
        "cold_path_source_reserved_within_5s",
        "cold_path_evidence_ready_within_configured_slo",
        "cold_path_refresh_terminal_within_configured_slo",
        "cold_path_automatic_highlights_within_configured_slo",
        "cold_path_total_within_configured_slo",
      ]));
  });

  it("rejects a lifecycle that never completed durable cold import", () => {
    const input = observation("empty_create_attach");
    input.repositoryImport.status = "importing";
    input.repositoryImport.workflowId = null;
    input.repositoryImport.refreshRunId = null;
    input.repositoryImport.evidenceCount = 0;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "repository_import_reached_evidence_ready",
        "repository_import_has_durable_request_and_workflow_ids",
        "repository_import_links_completed_refresh",
        "repository_import_has_evidence_and_no_error",
      ]));
  });

  it("rejects delete/re-add lineage reuse or leakage", () => {
    const input = observation("completed_delete_readd_same_repo");
    const priorSourceId = input.priorLineage!.sourceIds[0];
    input.currentLineage.sourceIds = [priorSourceId];
    input.leakedPriorEntityIds = [input.priorLineage!.highlightIds[0]];

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "replacement_lineage_is_disjoint",
        "no_prior_lineage_ids_leaked",
      ]));
  });

  it("requires proof that the deleted lineage had completed at the same head", () => {
    const input = observation("completed_delete_readd_same_repo");
    input.priorLineage!.completedBeforeDeletion = false;
    input.priorLineage!.completedHeadSha = PRIOR_SHA;
    input.priorLineage!.automaticHighlightCount = 0;

    const result = evaluateWorkItemLifecycleObservation(input);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.passed).map((check) => check.id))
      .toEqual(expect.arrayContaining([
        "prior_lineage_completed_before_deletion",
        "prior_lineage_completed_at_expected_head",
        "prior_lineage_had_automatic_highlights",
      ]));
  });

  it("requires exactly one observation for every release-blocking scenario", () => {
    const complete = evaluateWorkItemLifecycleReleaseGate({
      observations: workItemLifecycleScenarioIds.map(observation),
    });
    expect(complete.passed).toBe(true);

    const incomplete = evaluateWorkItemLifecycleReleaseGate({
      observations: [
        observation("empty_create_attach"),
        observation("empty_create_attach"),
      ],
    });
    expect(incomplete.passed).toBe(false);
    expect(incomplete.missingScenarioIds).toEqual([
      "manual_only_create",
      "existing_attach",
      "completed_delete_readd_same_repo",
    ]);
    expect(incomplete.duplicateScenarioIds).toEqual([
      "empty_create_attach",
    ]);
  });
});
