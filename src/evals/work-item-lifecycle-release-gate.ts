import { z } from "zod";

export const WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION =
  "workbase-work-item-lifecycle-release-gate-v2" as const;

export const workItemLifecycleScenarioIds = [
  "manual_only_create",
  "empty_create_attach",
  "existing_attach",
  "completed_delete_readd_same_repo",
] as const;

export type WorkItemLifecycleScenarioId =
  (typeof workItemLifecycleScenarioIds)[number];

const shaSchema = z.string().regex(
  /^[a-f0-9]{40}$/iu,
  "Expected a full 40-character Git commit SHA.",
);

const identifierSchema = z.string().trim().min(1).max(300);

const repositoryHeadSchema = z.object({
  sourceId: identifierSchema,
  repositoryId: identifierSchema,
  repository: identifierSchema,
  commitSha: shaSchema,
});

const lineageSchema = z.object({
  workItemId: identifierSchema,
  sourceIds: z.array(identifierSchema),
  refreshRunIds: z.array(identifierSchema),
  snapshotIds: z.array(identifierSchema),
  evidenceItemIds: z.array(identifierSchema),
  highlightIds: z.array(identifierSchema),
  projectFactIds: z.array(identifierSchema),
  generationRunIds: z.array(identifierSchema),
});

const highlightEvidenceSchema = z.object({
  evidenceItemId: identifierSchema,
  sourceId: identifierSchema,
  sourceType: identifierSchema,
});

const highlightSchema = z.object({
  id: identifierSchema,
  text: z.string().trim().min(1),
  lifecycleStatus: z.string().trim().min(1),
  verificationStatus: z.string().trim().min(1),
  reviewState: z.string().trim().min(1),
  approvalSource: z.string().trim().min(1),
  managedBy: z.string().trim().min(1),
  originatingAgentRunId: identifierSchema.nullable(),
  supersedesHighlightId: identifierSchema.nullable(),
  evidenceItemIds: z.array(identifierSchema),
  evidence: z.array(highlightEvidenceSchema),
  validatedThroughSha: shaSchema.nullable(),
  validationHeads: z.array(repositoryHeadSchema),
});

const failedProviderAttemptCountSchema = z.preprocess(
  (value) => Array.isArray(value) ? value.length : value,
  z.number().int().nonnegative().nullable(),
);

const capabilitySynthesisRunSchema = z.object({
  id: identifierSchema,
  status: identifierSchema,
  provider: identifierSchema,
  modelId: identifierSchema,
  profile: identifierSchema.nullable(),
  configuredModelId: identifierSchema.nullable(),
  requestIds: z.array(identifierSchema),
  tokenUsagePresent: z.boolean(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  usageComplete: z.boolean().nullable(),
  auditAttemptCount: z.number().int().nonnegative().nullable(),
  providerAttemptCount: z.number().int().nonnegative().nullable(),
  failedProviderAttempts: failedProviderAttemptCountSchema,
  unknownUsageAttempts: z.number().int().nonnegative().nullable(),
  auditEvidenceTruncated: z.boolean().nullable(),
});

const manualGenerationRunSchema = capabilitySynthesisRunSchema.extend({
  kind: z.enum(["highlight_generation", "highlight_verification"]),
  agentRunId: identifierSchema.nullable(),
  role: z.enum(["provider_call", "verification_aggregate"]),
  configuredProvider: identifierSchema.nullable(),
  authoritativeGenerationRunId: identifierSchema.nullable(),
  providerBatchGenerationRunIds: z.array(identifierSchema),
});

const observationIdentitySchema = z.object({
  schemaVersion: z.literal(WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION),
  provider: z.enum(["bedrock", "openrouter"]),
  observedAt: z.string().datetime({ offset: true }),
  initialState: z.object({
    workItemExisted: z.boolean(),
    sourceCount: z.number().int().nonnegative(),
    highlightCount: z.number().int().nonnegative(),
  }),
  terminalOutcome: z.object({
    status: z.enum(["completed", "failed", "cancelled", "timed_out"]),
    message: z.string().max(1_000).nullable(),
  }),
  currentLineage: lineageSchema,
  leakedPriorEntityIds: z.array(identifierSchema),
});

const repositoryObservationSchema = observationIdentitySchema.extend({
  scenarioId: z.enum([
    "empty_create_attach",
    "existing_attach",
    "completed_delete_readd_same_repo",
  ]),
  repository: z.object({
    repositoryId: identifierSchema,
    fullName: identifierSchema,
    expectedHeadSha: shaSchema,
    sourceId: identifierSchema,
    sourceRevisionSha: shaSchema.nullable(),
    targetHeads: z.array(repositoryHeadSchema),
    completedHeads: z.array(repositoryHeadSchema),
  }),
  repositoryImport: z.object({
    requestId: identifierSchema.nullable(),
    workflowId: identifierSchema.nullable(),
    refreshRunId: identifierSchema.nullable(),
    status: z.string().trim().min(1),
    error: z.string().trim().min(1).nullable(),
    evidenceCount: z.number().int().nonnegative().nullable(),
  }),
  refresh: z.object({
    id: identifierSchema,
    status: z.string().trim().min(1),
    qualityStatus: z.string().trim().min(1),
    error: z.string().trim().min(1).nullable(),
  }),
  snapshots: z.array(z.object({
    id: identifierSchema,
    sourceId: identifierSchema,
    commitSha: shaSchema,
    inventoryComplete: z.boolean(),
    analysisComplete: z.boolean(),
    coverageComplete: z.boolean(),
  })),
  baselineAutomaticHighlights: z.array(highlightSchema),
  automaticHighlights: z.array(highlightSchema),
  automation: z.object({
    status: z.enum(["completed", "failed", "pending", "not_started"]),
    repositorySynthesisMode: identifierSchema,
    expectedDeepSynthesisModelId: identifierSchema,
    generationRunIds: z.array(identifierSchema),
    failedGenerationRunIds: z.array(identifierSchema),
    semanticExtractionRunIds: z.array(identifierSchema),
    failedSemanticExtractionRunIds: z.array(identifierSchema),
    capabilitySynthesisRuns: z.array(capabilitySynthesisRunSchema),
    observedProviders: z.array(identifierSchema),
    observedModelIds: z.array(identifierSchema),
  }),
  priorLineage: lineageSchema.extend({
    repositoryId: identifierSchema,
    repository: identifierSchema,
    completedBeforeDeletion: z.boolean(),
    completedHeadSha: shaSchema.nullable(),
    automaticHighlightCount: z.number().int().nonnegative(),
    deleted: z.boolean(),
  }).nullable(),
  sloMs: z.object({
    evidenceReady: z.number().positive(),
    refreshTerminal: z.number().positive(),
    automaticHighlightsTerminal: z.number().positive(),
    total: z.number().positive(),
  }),
  timingsMs: z.object({
    actionAcknowledged: z.number().nonnegative(),
    sourceReserved: z.number().nonnegative(),
    evidenceReady: z.number().nonnegative(),
    refreshTerminal: z.number().nonnegative(),
    automaticHighlightsTerminal: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

const manualObservationSchema = observationIdentitySchema.extend({
  scenarioId: z.literal("manual_only_create"),
  manualEvidence: z.object({
    sourceIds: z.array(identifierSchema).min(1),
    evidenceItemIds: z.array(identifierSchema).min(1),
  }),
  manualAgentRun: z.object({
    id: identifierSchema,
    kind: z.literal("manual_evidence_highlights"),
    status: z.string().trim().min(1),
    workflowId: identifierSchema.nullable(),
    error: z.string().trim().min(1).nullable(),
    request: z.object({
      trigger: z.enum([
        "work_item_create",
        "manual_source_add",
        "manual_evidence_change",
      ]),
      sourceIds: z.array(identifierSchema).min(1),
      evidenceItemIds: z.array(identifierSchema).min(1),
      inputFingerprint: identifierSchema,
    }),
    result: z.object({
      terminalOutcome: z.enum([
        "ready",
        "no_safe_candidates",
        "superseded_input",
      ]),
      createdHighlightIds: z.array(identifierSchema),
      replayedHighlightIds: z.array(identifierSchema),
      deduplicatedHighlightIds: z.array(identifierSchema),
      suggestionIds: z.array(identifierSchema),
      suppressedHighlightIds: z.array(identifierSchema),
      generationRunIds: z.array(identifierSchema),
      managedBy: identifierSchema,
      inputFingerprint: identifierSchema,
    }).nullable(),
    generationRuns: z.array(manualGenerationRunSchema),
    expectedModelIds: z.object({
      drafting: identifierSchema,
      verification: identifierSchema,
    }),
  }),
  automaticHighlights: z.array(highlightSchema),
  sloMs: z.object({
    agentRunTerminal: z.number().positive(),
    automaticHighlightsTerminal: z.number().positive(),
    total: z.number().positive(),
  }),
  timingsMs: z.object({
    actionAcknowledged: z.number().nonnegative(),
    sourceReserved: z.number().nonnegative(),
    agentRunReserved: z.number().nonnegative(),
    agentRunTerminal: z.number().nonnegative(),
    automaticHighlightsTerminal: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

export const workItemLifecycleObservationSchema = z.discriminatedUnion(
  "scenarioId",
  [manualObservationSchema, repositoryObservationSchema],
);

export type WorkItemLifecycleObservation = z.infer<
  typeof workItemLifecycleObservationSchema
>;

type RepositoryWorkItemLifecycleObservation = z.infer<
  typeof repositoryObservationSchema
>;
type ManualWorkItemLifecycleObservation = z.infer<
  typeof manualObservationSchema
>;

export interface WorkItemLifecycleReleaseGateCheck {
  id: string;
  passed: boolean;
  actual?: string | number | boolean;
  expected?: string | number | boolean;
}

export interface WorkItemLifecycleReleaseGateResult {
  scenarioId: WorkItemLifecycleScenarioId;
  passed: boolean;
  checks: WorkItemLifecycleReleaseGateCheck[];
  observation: WorkItemLifecycleObservation;
}

function addCheck(
  checks: WorkItemLifecycleReleaseGateCheck[],
  id: string,
  passed: boolean,
  actual?: WorkItemLifecycleReleaseGateCheck["actual"],
  expected?: WorkItemLifecycleReleaseGateCheck["expected"],
) {
  checks.push({ id, passed, actual, expected });
}

function normalizedHighlightText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function headIdentity(head: z.infer<typeof repositoryHeadSchema>) {
  return [
    head.sourceId,
    head.repositoryId,
    head.repository.toLowerCase(),
    head.commitSha.toLowerCase(),
  ].join("\u0000");
}

function expectedHeadIdentity(
  observation: RepositoryWorkItemLifecycleObservation,
) {
  return headIdentity({
    sourceId: observation.repository.sourceId,
    repositoryId: observation.repository.repositoryId,
    repository: observation.repository.fullName,
    commitSha: observation.repository.expectedHeadSha,
  });
}

function exactSingleCurrentHead(
  heads: RepositoryWorkItemLifecycleObservation["repository"]["targetHeads"],
  observation: RepositoryWorkItemLifecycleObservation,
) {
  return heads.length === 1 &&
    headIdentity(heads[0]) === expectedHeadIdentity(observation);
}

function lineageIds(lineage: WorkItemLifecycleObservation["currentLineage"]) {
  return [
    lineage.workItemId,
    ...lineage.sourceIds,
    ...lineage.refreshRunIds,
    ...lineage.snapshotIds,
    ...lineage.evidenceItemIds,
    ...lineage.highlightIds,
    ...lineage.projectFactIds,
    ...lineage.generationRunIds,
  ];
}

function unique(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function capabilitySynthesisRunIsAuthoritative(
  run: z.infer<typeof capabilitySynthesisRunSchema>,
  observation: RepositoryWorkItemLifecycleObservation,
) {
  return run.status === "success" &&
    run.profile === "deep_synthesis" &&
    run.provider.toLowerCase() === observation.provider &&
    run.configuredModelId === observation.automation.expectedDeepSynthesisModelId &&
    run.modelId === observation.automation.expectedDeepSynthesisModelId &&
    run.requestIds.length > 0 &&
    run.tokenUsagePresent &&
    run.estimatedCostUsd !== null &&
    run.usageComplete === true &&
    (run.auditAttemptCount ?? 0) > 0 &&
    (run.providerAttemptCount ?? 0) > 0 &&
    run.failedProviderAttempts === 0 &&
    run.unknownUsageAttempts === 0 &&
    run.auditEvidenceTruncated === false;
}

function manualVerificationAuthorityIsComplete(
  generationRuns: Array<z.infer<typeof manualGenerationRunSchema>>,
  observation: ManualWorkItemLifecycleObservation,
) {
  const providerVerificationRuns = generationRuns.filter((run) =>
    run.role === "provider_call" && run.kind === "highlight_verification"
  );
  const aggregates = generationRuns.filter((run) =>
    run.role === "verification_aggregate"
  );

  if (aggregates.length === 0) {
    return providerVerificationRuns.length === 1 &&
      providerVerificationRuns[0]?.authoritativeGenerationRunId === null &&
      providerVerificationRuns[0]?.providerBatchGenerationRunIds.length === 0;
  }
  if (aggregates.length !== 1) return false;

  const aggregate = aggregates[0]!;
  const providerBatchIds = aggregate.providerBatchGenerationRunIds;
  const providerVerificationIds = providerVerificationRuns.map((run) => run.id);
  const aggregateIsComplete =
    aggregate.kind === "highlight_verification" &&
    aggregate.status === "success" &&
    aggregate.agentRunId === observation.manualAgentRun.id &&
    aggregate.provider.toLowerCase() === "deterministic" &&
    aggregate.modelId === "highlight-verification-aggregate-v1" &&
    aggregate.profile === "verification" &&
    aggregate.configuredProvider?.toLowerCase() === observation.provider &&
    aggregate.configuredModelId ===
      observation.manualAgentRun.expectedModelIds.verification &&
    aggregate.authoritativeGenerationRunId === null &&
    providerBatchIds.length >= 2 &&
    unique(providerBatchIds) &&
    sameIds(providerBatchIds, providerVerificationIds) &&
    !aggregate.tokenUsagePresent &&
    aggregate.estimatedCostUsd === null &&
    aggregate.usageComplete === true &&
    aggregate.auditAttemptCount === 0 &&
    aggregate.providerAttemptCount === 0 &&
    aggregate.failedProviderAttempts === 0 &&
    aggregate.unknownUsageAttempts === 0 &&
    aggregate.auditEvidenceTruncated === false;
  return aggregateIsComplete && providerVerificationRuns.every((run) =>
    run.authoritativeGenerationRunId === aggregate.id &&
    run.providerBatchGenerationRunIds.length === 0
  );
}

function authoritativeManualGenerationRunIds(
  generationRuns: Array<z.infer<typeof manualGenerationRunSchema>>,
) {
  return generationRuns.flatMap((run) =>
    run.role === "verification_aggregate" ||
      run.authoritativeGenerationRunId === null
      ? [run.id]
      : []
  );
}

function sameIds(left: readonly string[], right: readonly string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function highlightEvidenceIsConsistent(
  highlight: z.infer<typeof highlightSchema>,
) {
  const relationIds = highlight.evidence.map((entry) => entry.evidenceItemId);
  return unique(highlight.evidenceItemIds) &&
    unique(relationIds) &&
    sameIds(highlight.evidenceItemIds, relationIds);
}

function manualGenerationRunIsAuthoritative(
  run: z.infer<typeof manualGenerationRunSchema>,
  observation: ManualWorkItemLifecycleObservation,
) {
  const expectedProfile = run.kind === "highlight_generation"
    ? "drafting"
    : "verification";
  const expectedModelId = observation.manualAgentRun.expectedModelIds[
    expectedProfile
  ];
  return run.role === "provider_call" &&
    run.status === "success" &&
    run.agentRunId === observation.manualAgentRun.id &&
    run.provider.toLowerCase() === observation.provider &&
    run.profile === expectedProfile &&
    run.configuredModelId === expectedModelId &&
    run.modelId === expectedModelId &&
    run.requestIds.length > 0 &&
    run.tokenUsagePresent &&
    run.estimatedCostUsd !== null &&
    run.usageComplete === true &&
    (run.auditAttemptCount ?? 0) > 0 &&
    (run.providerAttemptCount ?? 0) > 0 &&
    run.failedProviderAttempts === 0 &&
    run.unknownUsageAttempts === 0 &&
    run.auditEvidenceTruncated === false;
}

function evaluateManualObservation(
  observation: ManualWorkItemLifecycleObservation,
): WorkItemLifecycleReleaseGateResult {
  const checks: WorkItemLifecycleReleaseGateCheck[] = [];

  addCheck(
    checks,
    "terminal_outcome_completed",
    observation.terminalOutcome.status === "completed",
    observation.terminalOutcome.status,
    "completed",
  );
  addCheck(
    checks,
    "terminal_outcome_has_no_error",
    observation.terminalOutcome.message === null,
    observation.terminalOutcome.message ?? "none",
    "none",
  );
  addCheck(
    checks,
    "manual_create_started_from_empty_state",
    !observation.initialState.workItemExisted &&
      observation.initialState.sourceCount === 0 &&
      observation.initialState.highlightCount === 0,
    `${observation.initialState.workItemExisted}/${observation.initialState.sourceCount}/${observation.initialState.highlightCount}`,
    "false/0/0",
  );

  const request = observation.manualAgentRun.request;
  const result = observation.manualAgentRun.result;
  addCheck(
    checks,
    "manual_agent_run_completed",
    observation.manualAgentRun.status === "completed",
    observation.manualAgentRun.status,
    "completed",
  );
  addCheck(
    checks,
    "manual_agent_run_has_durable_workflow",
    observation.manualAgentRun.workflowId !== null &&
      !observation.manualAgentRun.workflowId.startsWith("starting:") &&
      !observation.manualAgentRun.workflowId.startsWith("inline-agent:"),
    observation.manualAgentRun.workflowId ?? "missing",
    "workflow id",
  );
  addCheck(
    checks,
    "manual_agent_run_has_no_error",
    observation.manualAgentRun.error === null,
    observation.manualAgentRun.error ?? "none",
    "none",
  );
  addCheck(
    checks,
    "manual_agent_run_request_matches_reserved_evidence",
    request.trigger === "work_item_create" &&
      unique(request.sourceIds) &&
      unique(request.evidenceItemIds) &&
      unique(observation.manualEvidence.sourceIds) &&
      unique(observation.manualEvidence.evidenceItemIds) &&
      sameIds(request.sourceIds, observation.manualEvidence.sourceIds) &&
      sameIds(
        request.evidenceItemIds,
        observation.manualEvidence.evidenceItemIds,
      ),
    `${request.trigger}/${request.sourceIds.length}/${request.evidenceItemIds.length}`,
    `work_item_create/${observation.manualEvidence.sourceIds.length}/${observation.manualEvidence.evidenceItemIds.length}`,
  );
  addCheck(
    checks,
    "manual_agent_run_result_is_ready",
    result?.terminalOutcome === "ready",
    result?.terminalOutcome ?? "missing",
    "ready",
  );
  addCheck(
    checks,
    "manual_agent_run_result_has_expected_ownership",
    result?.managedBy === "manual_evidence_highlight_workflow" &&
      result.inputFingerprint === request.inputFingerprint,
    `${result?.managedBy ?? "missing"}/${result?.inputFingerprint ?? "missing"}`,
    `manual_evidence_highlight_workflow/${request.inputFingerprint}`,
  );

  const generationRuns = observation.manualAgentRun.generationRuns;
  const generationRunIds = generationRuns.map((run) => run.id);
  const providerGenerationRuns = generationRuns.filter((run) =>
    run.role === "provider_call"
  );
  const generationKinds = providerGenerationRuns.map((run) => run.kind);
  addCheck(
    checks,
    "manual_highlight_generation_and_verification_ran",
    generationKinds.includes("highlight_generation") &&
      generationKinds.includes("highlight_verification"),
    generationKinds.join(", ") || "none",
    "highlight_generation, highlight_verification",
  );
  addCheck(
    checks,
    "manual_generation_runs_are_attributed_and_metered",
    providerGenerationRuns.length > 0 && providerGenerationRuns.every((run) =>
      manualGenerationRunIsAuthoritative(run, observation)
    ),
    providerGenerationRuns.filter((run) =>
      !manualGenerationRunIsAuthoritative(run, observation)
    ).map((run) => run.id).join(", ") ||
      (providerGenerationRuns.length ? "none" : "missing"),
    "none",
  );
  addCheck(
    checks,
    "manual_verification_authority_is_complete",
    manualVerificationAuthorityIsComplete(generationRuns, observation),
    generationRuns.filter((run) => run.kind === "highlight_verification")
      .map((run) => `${run.id}:${run.role}`).join(", ") || "missing",
    "one provider run or one complete aggregate over all provider batches",
  );
  const authoritativeGenerationRunIds =
    authoritativeManualGenerationRunIds(generationRuns);
  addCheck(
    checks,
    "manual_agent_run_result_links_generation_runs",
    result !== null &&
      unique(generationRunIds) &&
      unique(authoritativeGenerationRunIds) &&
      sameIds(result.generationRunIds, authoritativeGenerationRunIds) &&
      generationRuns.every((run) => run.agentRunId === observation.manualAgentRun.id),
    result?.generationRunIds.join(", ") || "missing",
    authoritativeGenerationRunIds.join(", ") || "authoritative generation run ids",
  );

  addCheck(
    checks,
    "manual_agent_run_result_has_no_replayed_or_ambiguous_outputs",
    result !== null &&
      result.replayedHighlightIds.length === 0 &&
      result.deduplicatedHighlightIds.length === 0 &&
      result.suggestionIds.length === 0 &&
      result.suppressedHighlightIds.length === 0,
    result === null
      ? "missing"
      : `${result.replayedHighlightIds.length}/${result.deduplicatedHighlightIds.length}/${result.suggestionIds.length}/${result.suppressedHighlightIds.length}`,
    "0/0/0/0",
  );

  const createdHighlightIds = result?.createdHighlightIds ?? [];
  const observedHighlightIds = observation.automaticHighlights.map((highlight) =>
    highlight.id
  );
  addCheck(
    checks,
    "manual_agent_run_result_links_created_highlights",
    result !== null &&
      createdHighlightIds.length > 0 &&
      unique(createdHighlightIds) &&
      unique(observedHighlightIds) &&
      sameIds(createdHighlightIds, observedHighlightIds),
    createdHighlightIds.join(", ") || "none",
    observedHighlightIds.join(", ") || "created highlight ids",
  );

  const activeGroundedHighlights = observation.automaticHighlights.filter(
    (highlight) =>
      highlight.lifecycleStatus === "active" &&
      highlight.verificationStatus === "approved" &&
      highlight.reviewState === "pending_review" &&
      highlight.approvalSource === "automation" &&
      highlight.managedBy === "manual_evidence_highlight_workflow" &&
      highlight.originatingAgentRunId === observation.manualAgentRun.id &&
      highlightEvidenceIsConsistent(highlight) &&
      highlight.evidence.length > 0 &&
      highlight.evidence.every((entry) =>
        entry.sourceType === "manual_note" &&
        request.sourceIds.includes(entry.sourceId) &&
        request.evidenceItemIds.includes(entry.evidenceItemId)
      ) &&
      highlight.validatedThroughSha === null &&
      highlight.validationHeads.length === 0,
  );
  addCheck(
    checks,
    "manual_highlights_include_active_grounded_pending_review_result",
    activeGroundedHighlights.length > 0,
    activeGroundedHighlights.length,
    1,
  );
  const invalidManualHighlights = observation.automaticHighlights.filter(
    (highlight) =>
      !["active", "quarantined"].includes(highlight.lifecycleStatus) ||
      (
        highlight.lifecycleStatus === "active" &&
        highlight.verificationStatus !== "approved"
      ) ||
      highlight.reviewState !== "pending_review" ||
      highlight.approvalSource !== "automation" ||
      highlight.managedBy !== "manual_evidence_highlight_workflow" ||
      highlight.originatingAgentRunId !== observation.manualAgentRun.id ||
      !highlightEvidenceIsConsistent(highlight) ||
      highlight.evidence.length === 0 ||
      !highlight.evidence.every((entry) =>
        entry.sourceType === "manual_note" &&
        request.sourceIds.includes(entry.sourceId) &&
        request.evidenceItemIds.includes(entry.evidenceItemId)
      ) ||
      highlight.validatedThroughSha !== null ||
      highlight.validationHeads.length > 0,
  );
  addCheck(
    checks,
    "manual_highlights_have_no_unknown_ownership_or_evidence",
    observation.automaticHighlights.length > 0 &&
      invalidManualHighlights.length === 0,
    invalidManualHighlights.map((highlight) => highlight.id).join(", ") ||
      (observation.automaticHighlights.length ? "none" : "missing"),
    "none",
  );
  const normalizedTexts = observation.automaticHighlights.map((highlight) =>
    normalizedHighlightText(highlight.text)
  );
  addCheck(
    checks,
    "manual_highlights_have_no_duplicate_text",
    normalizedTexts.every(Boolean) && unique(normalizedTexts),
    normalizedTexts.length - new Set(normalizedTexts).size,
    0,
  );

  const currentIds = lineageIds(observation.currentLineage);
  addCheck(
    checks,
    "current_lineage_ids_are_unique",
    unique(currentIds),
    currentIds.length - new Set(currentIds).size,
    0,
  );
  addCheck(
    checks,
    "manual_lineage_contains_reserved_evidence_run_outputs",
    observation.manualEvidence.sourceIds.every((id) =>
      observation.currentLineage.sourceIds.includes(id)
    ) &&
      observation.manualEvidence.evidenceItemIds.every((id) =>
        observation.currentLineage.evidenceItemIds.includes(id)
      ) &&
      generationRunIds.every((id) =>
        observation.currentLineage.generationRunIds.includes(id)
      ) &&
      observedHighlightIds.every((id) =>
        observation.currentLineage.highlightIds.includes(id)
      ),
    observation.currentLineage.workItemId,
    "complete manual evidence lineage",
  );
  addCheck(
    checks,
    "no_prior_lineage_ids_leaked",
    observation.leakedPriorEntityIds.length === 0,
    observation.leakedPriorEntityIds.join(", ") || "none",
    "none",
  );

  const boundedTimings = [
    observation.timingsMs.actionAcknowledged,
    observation.timingsMs.sourceReserved,
    observation.timingsMs.agentRunReserved,
    observation.timingsMs.agentRunTerminal,
    observation.timingsMs.automaticHighlightsTerminal,
  ];
  addCheck(
    checks,
    "manual_lifecycle_timing_milestones_are_bounded_by_total",
    boundedTimings.every((duration) =>
      Number.isFinite(duration) && duration <= observation.timingsMs.total
    ),
    Math.max(...boundedTimings),
    observation.timingsMs.total,
  );
  addCheck(
    checks,
    "manual_agent_run_timing_is_ordered",
    observation.timingsMs.agentRunReserved <=
      observation.timingsMs.agentRunTerminal &&
      observation.timingsMs.agentRunTerminal <=
        observation.timingsMs.automaticHighlightsTerminal,
    `${observation.timingsMs.agentRunReserved}/${observation.timingsMs.agentRunTerminal}/${observation.timingsMs.automaticHighlightsTerminal}`,
    "agentRunReserved <= agentRunTerminal <= automaticHighlightsTerminal",
  );
  for (const [id, actual] of [
    ["manual_path_action_acknowledged_within_5s", observation.timingsMs.actionAcknowledged],
    ["manual_path_source_reserved_within_5s", observation.timingsMs.sourceReserved],
    ["manual_path_agent_run_reserved_within_5s", observation.timingsMs.agentRunReserved],
  ] as const) {
    addCheck(checks, id, actual <= 5_000, actual, 5_000);
  }
  for (const [id, actual, expected] of [
    [
      "manual_path_agent_run_terminal_within_configured_slo",
      observation.timingsMs.agentRunTerminal,
      observation.sloMs.agentRunTerminal,
    ],
    [
      "manual_path_automatic_highlights_within_configured_slo",
      observation.timingsMs.automaticHighlightsTerminal,
      observation.sloMs.automaticHighlightsTerminal,
    ],
    [
      "manual_path_total_within_configured_slo",
      observation.timingsMs.total,
      observation.sloMs.total,
    ],
  ] as const) {
    addCheck(checks, id, actual <= expected, actual, expected);
  }
  addCheck(
    checks,
    "configured_manual_stage_slos_fit_total_slo",
    observation.sloMs.agentRunTerminal <= observation.sloMs.total &&
      observation.sloMs.automaticHighlightsTerminal <= observation.sloMs.total,
    Math.max(
      observation.sloMs.agentRunTerminal,
      observation.sloMs.automaticHighlightsTerminal,
    ),
    observation.sloMs.total,
  );

  return {
    scenarioId: observation.scenarioId,
    passed: checks.every((check) => check.passed),
    checks,
    observation,
  };
}

function evaluateRepositoryObservation(
  observation: RepositoryWorkItemLifecycleObservation,
): WorkItemLifecycleReleaseGateResult {
  const checks: WorkItemLifecycleReleaseGateCheck[] = [];
  const expectedHeadSha = observation.repository.expectedHeadSha.toLowerCase();

  addCheck(
    checks,
    "terminal_outcome_completed",
    observation.terminalOutcome.status === "completed",
    observation.terminalOutcome.status,
    "completed",
  );
  addCheck(
    checks,
    "terminal_outcome_has_no_error",
    observation.terminalOutcome.message === null,
    observation.terminalOutcome.message ?? "none",
    "none",
  );
  addCheck(
    checks,
    "repository_import_reached_evidence_ready",
    observation.repositoryImport.status === "evidence_ready",
    observation.repositoryImport.status,
    "evidence_ready",
  );
  addCheck(
    checks,
    "repository_import_has_durable_request_and_workflow_ids",
    observation.repositoryImport.requestId !== null &&
      observation.repositoryImport.workflowId !== null,
    `${observation.repositoryImport.requestId ?? "missing"}/${observation.repositoryImport.workflowId ?? "missing"}`,
    "request/workflow",
  );
  addCheck(
    checks,
    "repository_import_links_completed_refresh",
    observation.repositoryImport.refreshRunId === observation.refresh.id,
    observation.repositoryImport.refreshRunId ?? "missing",
    observation.refresh.id,
  );
  addCheck(
    checks,
    "repository_import_has_evidence_and_no_error",
    (observation.repositoryImport.evidenceCount ?? 0) > 0 &&
      observation.repositoryImport.error === null,
    `${observation.repositoryImport.evidenceCount ?? 0}/${observation.repositoryImport.error ?? "none"}`,
    "positive/none",
  );
  addCheck(
    checks,
    "repository_refresh_completed",
    observation.refresh.status === "completed",
    observation.refresh.status,
    "completed",
  );
  addCheck(
    checks,
    "repository_refresh_quality_verified",
    observation.refresh.qualityStatus === "verified",
    observation.refresh.qualityStatus,
    "verified",
  );
  addCheck(
    checks,
    "repository_refresh_has_no_error",
    observation.refresh.error === null,
    observation.refresh.error ?? "none",
    "none",
  );
  addCheck(
    checks,
    "source_revision_matches_expected_head",
    observation.repository.sourceRevisionSha?.toLowerCase() === expectedHeadSha,
    observation.repository.sourceRevisionSha ?? "missing",
    observation.repository.expectedHeadSha,
  );
  addCheck(
    checks,
    "target_heads_are_exactly_current",
    exactSingleCurrentHead(observation.repository.targetHeads, observation),
    observation.repository.targetHeads.map(headIdentity).join(", "),
    expectedHeadIdentity(observation),
  );
  addCheck(
    checks,
    "completed_heads_are_exactly_current",
    exactSingleCurrentHead(observation.repository.completedHeads, observation),
    observation.repository.completedHeads.map(headIdentity).join(", "),
    expectedHeadIdentity(observation),
  );

  const currentSnapshots = observation.snapshots.filter((snapshot) =>
    snapshot.sourceId === observation.repository.sourceId &&
    snapshot.commitSha.toLowerCase() === expectedHeadSha
  );
  addCheck(
    checks,
    "one_complete_current_snapshot_exists",
    currentSnapshots.length === 1 &&
      currentSnapshots[0].inventoryComplete &&
      currentSnapshots[0].analysisComplete &&
      currentSnapshots[0].coverageComplete,
    currentSnapshots.length,
    1,
  );

  addCheck(
    checks,
    "automatic_highlight_generation_completed",
    observation.automation.status === "completed",
    observation.automation.status,
    "completed",
  );
  addCheck(
    checks,
    "automatic_highlight_generation_has_no_failed_runs",
    observation.automation.failedGenerationRunIds.length === 0,
    observation.automation.failedGenerationRunIds.length,
    0,
  );
  addCheck(
    checks,
    "semantic_extraction_ran",
    observation.automation.semanticExtractionRunIds.length > 0,
    observation.automation.semanticExtractionRunIds.length,
    1,
  );
  addCheck(
    checks,
    "semantic_extraction_has_no_failed_runs",
    observation.automation.failedSemanticExtractionRunIds.length === 0,
    observation.automation.failedSemanticExtractionRunIds.length,
    0,
  );
  addCheck(
    checks,
    "repository_synthesis_mode_is_model",
    observation.automation.repositorySynthesisMode === "model",
    observation.automation.repositorySynthesisMode,
    "model",
  );
  const capabilitySynthesisRuns = observation.automation.capabilitySynthesisRuns;
  const successfulDeepSynthesisRuns = capabilitySynthesisRuns.filter((run) =>
    run.status === "success" && run.profile === "deep_synthesis"
  );
  const failedCapabilitySynthesisRuns = capabilitySynthesisRuns.filter((run) =>
    run.status !== "success"
  );
  addCheck(
    checks,
    "model_backed_capability_synthesis_ran",
    successfulDeepSynthesisRuns.length > 0,
    successfulDeepSynthesisRuns.length,
    1,
  );
  addCheck(
    checks,
    "capability_synthesis_has_no_failed_runs",
    failedCapabilitySynthesisRuns.length === 0,
    failedCapabilitySynthesisRuns.map((run) => run.id).join(", ") || "none",
    "none",
  );
  const unauthoritativeSynthesisRuns = successfulDeepSynthesisRuns.filter((run) =>
    !capabilitySynthesisRunIsAuthoritative(run, observation)
  );
  addCheck(
    checks,
    "capability_synthesis_attribution_and_usage_are_authoritative",
    successfulDeepSynthesisRuns.length > 0 &&
      unauthoritativeSynthesisRuns.length === 0,
    unauthoritativeSynthesisRuns.map((run) => run.id).join(", ") ||
      (successfulDeepSynthesisRuns.length ? "none" : "missing"),
    "none",
  );
  const observedProviders = Array.from(new Set(
    observation.automation.observedProviders.map((value) =>
      value.toLowerCase()
    ),
  )).sort();
  addCheck(
    checks,
    "generation_runs_match_declared_provider",
    observedProviders.length === 1 &&
      observedProviders[0] === observation.provider,
    observedProviders.join(", ") || "none",
    observation.provider,
  );
  addCheck(
    checks,
    "generation_runs_record_model_identity",
    observation.automation.observedModelIds.length > 0,
    observation.automation.observedModelIds.length,
    1,
  );
  addCheck(
    checks,
    "automatic_highlights_exist",
    observation.automaticHighlights.length > 0,
    observation.automaticHighlights.length,
    1,
  );
  addCheck(
    checks,
    "automatic_highlight_ids_are_unique",
    unique(observation.automaticHighlights.map((highlight) => highlight.id)),
    observation.automaticHighlights.length - new Set(
      observation.automaticHighlights.map((highlight) => highlight.id),
    ).size,
    0,
  );

  const atExactCurrentHead = (highlight: z.infer<typeof highlightSchema>) =>
    highlight.validatedThroughSha?.toLowerCase() === expectedHeadSha &&
    highlight.validationHeads.length === 1 &&
    headIdentity(highlight.validationHeads[0]) === expectedHeadIdentity(observation);
  const hasRepositoryEvidence = (highlight: z.infer<typeof highlightSchema>) =>
    highlight.evidence.some((entry) =>
      entry.sourceId === observation.repository.sourceId &&
      entry.sourceType === "github_repo"
    );
  const isCurrentRepositoryHighlight = (
    highlight: z.infer<typeof highlightSchema>,
  ) =>
    highlight.lifecycleStatus === "active" &&
    highlight.verificationStatus === "approved" &&
    highlight.reviewState === "pending_review" &&
    highlight.approvalSource === "automation" &&
    highlight.managedBy === "repository_knowledge_sync" &&
    highlight.originatingAgentRunId === null &&
    highlightEvidenceIsConsistent(highlight) &&
    highlight.evidence.length > 0 &&
    hasRepositoryEvidence(highlight) &&
    atExactCurrentHead(highlight);

  const baselineById = new Map(
    observation.baselineAutomaticHighlights.map((highlight) => [
      highlight.id,
      highlight,
    ]),
  );
  const finalById = new Map(
    observation.automaticHighlights.map((highlight) => [highlight.id, highlight]),
  );
  const invalidBaselineHighlights = observation.baselineAutomaticHighlights.filter(
    (highlight) =>
      !["active", "quarantined"].includes(highlight.lifecycleStatus) ||
      (
        highlight.lifecycleStatus === "active" &&
        highlight.verificationStatus !== "approved"
      ) ||
      highlight.reviewState !== "pending_review" ||
      highlight.approvalSource !== "automation" ||
      highlight.managedBy !== "manual_evidence_highlight_workflow" ||
      highlight.originatingAgentRunId === null ||
      !highlightEvidenceIsConsistent(highlight) ||
      highlight.evidence.length === 0 ||
      !highlight.evidence.every((entry) => entry.sourceType === "manual_note") ||
      highlight.validatedThroughSha !== null ||
      highlight.validationHeads.length > 0,
  );
  const baselineIdsMissingAfterAttach = observation.baselineAutomaticHighlights
    .filter((highlight) => !finalById.has(highlight.id))
    .map((highlight) => highlight.id);
  const transitionedBaselineHighlights = observation.automaticHighlights.filter(
    (highlight) =>
      baselineById.has(highlight.id) &&
      highlight.lifecycleStatus === "active" &&
      highlight.verificationStatus === "approved" &&
      highlight.reviewState === "pending_review" &&
      highlight.approvalSource === "automation" &&
      highlight.managedBy === "manual_evidence_highlight_workflow" &&
      highlight.originatingAgentRunId ===
        baselineById.get(highlight.id)?.originatingAgentRunId &&
      highlightEvidenceIsConsistent(highlight) &&
      hasRepositoryEvidence(highlight) &&
      atExactCurrentHead(highlight),
  );
  const newRepositoryHighlights = observation.automaticHighlights.filter(
    (highlight) =>
      !baselineById.has(highlight.id) && isCurrentRepositoryHighlight(highlight),
  );
  const replacementByPriorId = new Map(
    newRepositoryHighlights.flatMap((highlight) =>
      highlight.supersedesHighlightId
        ? [[highlight.supersedesHighlightId, highlight] as const]
        : []
    ),
  );
  const invalidFinalOwnership = observation.automaticHighlights.filter(
    (highlight) => {
      const baseline = baselineById.get(highlight.id);
      if (!baseline) return !isCurrentRepositoryHighlight(highlight);
      if (
        highlight.managedBy !== "manual_evidence_highlight_workflow" ||
        highlight.originatingAgentRunId !== baseline.originatingAgentRunId ||
        highlight.reviewState !== "pending_review" ||
        highlight.approvalSource !== "automation" ||
        normalizedHighlightText(highlight.text) !==
          normalizedHighlightText(baseline.text) ||
        !highlightEvidenceIsConsistent(highlight) ||
        !baseline.evidenceItemIds.every((id) =>
          highlight.evidenceItemIds.includes(id)
        )
      ) {
        return true;
      }
      if (transitionedBaselineHighlights.some((entry) => entry.id === highlight.id)) {
        return false;
      }
      if (
        highlight.lifecycleStatus === "superseded" ||
        highlight.lifecycleStatus === "retired"
      ) {
        return !replacementByPriorId.has(highlight.id) ||
          !highlight.evidence.every((entry) =>
            entry.sourceType === "manual_note" ||
            (
              entry.sourceType === "github_repo" &&
              entry.sourceId === observation.repository.sourceId
            )
          );
      }
      return !["active", "quarantined"].includes(highlight.lifecycleStatus) ||
        (
          highlight.lifecycleStatus === "active" &&
          highlight.verificationStatus !== "approved"
        ) ||
        !highlight.evidence.every((entry) => entry.sourceType === "manual_note") ||
        highlight.validatedThroughSha !== null ||
        highlight.validationHeads.length > 0;
    },
  );
  const existingAttach = observation.scenarioId === "existing_attach";
  const nonCurrentHighlights = existingAttach
    ? invalidFinalOwnership
    : observation.automaticHighlights.filter((highlight) =>
        !isCurrentRepositoryHighlight(highlight)
      );
  addCheck(
    checks,
    "automatic_highlights_are_validated_at_exact_current_head",
    nonCurrentHighlights.length === 0,
    nonCurrentHighlights.map((highlight) => highlight.id).join(", ") || "none",
    "none",
  );

  const unavailableHighlights = existingAttach
    ? invalidFinalOwnership
    : observation.automaticHighlights.filter((highlight) =>
        !isCurrentRepositoryHighlight(highlight)
      );
  addCheck(
    checks,
    "automatic_highlights_are_active_approved_automatic_and_grounded",
    unavailableHighlights.length === 0,
    unavailableHighlights.map((highlight) => highlight.id).join(", ") || "none",
    "none",
  );

  addCheck(
    checks,
    "existing_attach_baseline_is_snapshotted_manual_automation",
    existingAttach
      ? observation.baselineAutomaticHighlights.length > 0 &&
        observation.initialState.highlightCount ===
          observation.baselineAutomaticHighlights.length &&
        invalidBaselineHighlights.length === 0 &&
        unique(observation.baselineAutomaticHighlights.map((highlight) =>
          highlight.id
        ))
      : observation.baselineAutomaticHighlights.length === 0,
    existingAttach
      ? `${observation.baselineAutomaticHighlights.length}/${invalidBaselineHighlights.map((highlight) => highlight.id).join(", ") || "none"}`
      : observation.baselineAutomaticHighlights.length,
    existingAttach ? "positive/none" : 0,
  );
  addCheck(
    checks,
    "existing_attach_preserves_every_baseline_highlight",
    !existingAttach || baselineIdsMissingAfterAttach.length === 0,
    baselineIdsMissingAfterAttach.join(", ") || "none",
    "none",
  );
  addCheck(
    checks,
    "existing_attach_produces_new_or_transitioned_current_head_highlights",
    !existingAttach ||
      newRepositoryHighlights.length + transitionedBaselineHighlights.length > 0,
    newRepositoryHighlights.length + transitionedBaselineHighlights.length,
    existingAttach ? 1 : 0,
  );
  addCheck(
    checks,
    "existing_attach_has_no_unknown_highlight_ownership",
    !existingAttach || invalidFinalOwnership.length === 0,
    invalidFinalOwnership.map((highlight) => highlight.id).join(", ") || "none",
    "none",
  );

  const duplicateEligibleHighlights = observation.automaticHighlights.filter(
    (highlight) => ["active", "needs_validation", "quarantined"].includes(
      highlight.lifecycleStatus,
    ),
  );
  const normalizedTexts = duplicateEligibleHighlights.map((highlight) =>
    normalizedHighlightText(highlight.text)
  );
  addCheck(
    checks,
    "automatic_highlights_have_no_duplicate_text",
    normalizedTexts.every(Boolean) && unique(normalizedTexts),
    normalizedTexts.length - new Set(normalizedTexts).size,
    0,
  );

  const currentIds = lineageIds(observation.currentLineage);
  addCheck(
    checks,
    "current_lineage_ids_are_unique",
    unique(currentIds),
    currentIds.length - new Set(currentIds).size,
    0,
  );
  addCheck(
    checks,
    "current_lineage_contains_observed_source_refresh_snapshot_and_highlights",
    observation.currentLineage.sourceIds.includes(observation.repository.sourceId) &&
      observation.currentLineage.refreshRunIds.includes(observation.refresh.id) &&
      currentSnapshots.every((snapshot) =>
        observation.currentLineage.snapshotIds.includes(snapshot.id)
      ) &&
      observation.automaticHighlights.every((highlight) =>
        observation.currentLineage.highlightIds.includes(highlight.id)
      ) &&
      observation.automation.generationRunIds.every((runId) =>
        observation.currentLineage.generationRunIds.includes(runId)
      ) &&
      observation.automation.semanticExtractionRunIds.every((runId) =>
        observation.automation.generationRunIds.includes(runId)
      ) &&
      observation.automation.failedSemanticExtractionRunIds.every((runId) =>
        observation.automation.semanticExtractionRunIds.includes(runId)
      ) &&
      observation.automation.capabilitySynthesisRuns.every((run) =>
        observation.automation.generationRunIds.includes(run.id)
      ),
    observation.currentLineage.workItemId,
    "complete current lineage",
  );
  addCheck(
    checks,
    "no_prior_lineage_ids_leaked",
    observation.leakedPriorEntityIds.length === 0,
    observation.leakedPriorEntityIds.join(", ") || "none",
    "none",
  );

  if (observation.scenarioId !== "completed_delete_readd_same_repo") {
    const expectedInitialWorkItem = observation.scenarioId === "existing_attach";
    addCheck(
      checks,
      "initial_work_item_state_matches_scenario",
      observation.initialState.workItemExisted === expectedInitialWorkItem,
      observation.initialState.workItemExisted,
      expectedInitialWorkItem,
    );
  }
  addCheck(
    checks,
    "initial_repository_attach_state_matches_scenario",
    observation.initialState.sourceCount === 0 &&
      (
        observation.scenarioId === "existing_attach" ||
        observation.initialState.highlightCount === 0
    ),
    `${observation.initialState.sourceCount}/${observation.initialState.highlightCount}`,
    observation.scenarioId === "existing_attach" ? "0/any" : "0/0",
  );

  if (observation.scenarioId === "completed_delete_readd_same_repo") {
    const priorLineage = observation.priorLineage;
    const priorIds = priorLineage ? lineageIds(priorLineage) : [];
    const currentIdSet = new Set(currentIds);
    const intersections = priorIds.filter((id) => currentIdSet.has(id));
    addCheck(
      checks,
      "prior_lineage_completed_before_deletion",
      priorLineage?.completedBeforeDeletion === true,
      priorLineage?.completedBeforeDeletion ?? false,
      true,
    );
    addCheck(
      checks,
      "prior_lineage_completed_at_expected_head",
      priorLineage?.completedHeadSha?.toLowerCase() === expectedHeadSha,
      priorLineage?.completedHeadSha ?? "missing",
      observation.repository.expectedHeadSha,
    );
    addCheck(
      checks,
      "prior_lineage_had_automatic_highlights",
      (priorLineage?.automaticHighlightCount ?? 0) > 0,
      priorLineage?.automaticHighlightCount ?? 0,
      1,
    );
    addCheck(
      checks,
      "prior_completed_lineage_was_deleted",
      priorLineage?.deleted === true,
      priorLineage?.deleted ?? false,
      true,
    );
    addCheck(
      checks,
      "same_repository_was_readded",
      priorLineage?.repositoryId === observation.repository.repositoryId &&
        priorLineage?.repository.toLowerCase() ===
          observation.repository.fullName.toLowerCase(),
      `${priorLineage?.repositoryId ?? "none"}/${priorLineage?.repository ?? "none"}`,
      `${observation.repository.repositoryId}/${observation.repository.fullName}`,
    );
    addCheck(
      checks,
      "replacement_lineage_is_disjoint",
      intersections.length === 0,
      intersections.join(", ") || "none",
      "none",
    );
  } else {
    addCheck(
      checks,
      "non_readd_scenario_has_no_prior_lineage",
      observation.priorLineage === null,
      observation.priorLineage === null,
      true,
    );
  }

  const orderedTimings = [
    observation.timingsMs.actionAcknowledged,
    observation.timingsMs.sourceReserved,
    observation.timingsMs.evidenceReady,
    observation.timingsMs.refreshTerminal,
    observation.timingsMs.automaticHighlightsTerminal,
  ];
  addCheck(
    checks,
    "lifecycle_timing_milestones_are_bounded_by_total",
    orderedTimings.every((duration) =>
      Number.isFinite(duration) && duration <= observation.timingsMs.total
    ),
    Math.max(...orderedTimings),
    observation.timingsMs.total,
  );
  addCheck(
    checks,
    "repository_import_timing_is_ordered",
    observation.timingsMs.sourceReserved <=
      observation.timingsMs.evidenceReady &&
      observation.timingsMs.evidenceReady <=
        observation.timingsMs.refreshTerminal,
    `${observation.timingsMs.sourceReserved}/${observation.timingsMs.evidenceReady}/${observation.timingsMs.refreshTerminal}`,
    "sourceReserved <= evidenceReady <= refreshTerminal",
  );
  addCheck(
    checks,
    "cold_path_action_acknowledged_within_5s",
    observation.timingsMs.actionAcknowledged <= 5_000,
    observation.timingsMs.actionAcknowledged,
    5_000,
  );
  addCheck(
    checks,
    "cold_path_source_reserved_within_5s",
    observation.timingsMs.sourceReserved <= 5_000,
    observation.timingsMs.sourceReserved,
    5_000,
  );
  for (const [id, actual, expected] of [
    [
      "cold_path_evidence_ready_within_configured_slo",
      observation.timingsMs.evidenceReady,
      observation.sloMs.evidenceReady,
    ],
    [
      "cold_path_refresh_terminal_within_configured_slo",
      observation.timingsMs.refreshTerminal,
      observation.sloMs.refreshTerminal,
    ],
    [
      "cold_path_automatic_highlights_within_configured_slo",
      observation.timingsMs.automaticHighlightsTerminal,
      observation.sloMs.automaticHighlightsTerminal,
    ],
    [
      "cold_path_total_within_configured_slo",
      observation.timingsMs.total,
      observation.sloMs.total,
    ],
  ] as const) {
    addCheck(checks, id, actual <= expected, actual, expected);
  }
  addCheck(
    checks,
    "configured_stage_slos_fit_total_slo",
    observation.sloMs.evidenceReady <= observation.sloMs.total &&
      observation.sloMs.refreshTerminal <= observation.sloMs.total &&
      observation.sloMs.automaticHighlightsTerminal <= observation.sloMs.total,
    Math.max(
      observation.sloMs.evidenceReady,
      observation.sloMs.refreshTerminal,
      observation.sloMs.automaticHighlightsTerminal,
    ),
    observation.sloMs.total,
  );

  return {
    scenarioId: observation.scenarioId,
    passed: checks.every((check) => check.passed),
    checks,
    observation,
  };
}

export function evaluateWorkItemLifecycleObservation(
  unsafeObservation: unknown,
): WorkItemLifecycleReleaseGateResult {
  const observation = workItemLifecycleObservationSchema.parse(unsafeObservation);
  return observation.scenarioId === "manual_only_create"
    ? evaluateManualObservation(observation)
    : evaluateRepositoryObservation(observation);
}

export function evaluateWorkItemLifecycleReleaseGate(input: {
  observations: readonly unknown[];
}) {
  const results = input.observations.map(evaluateWorkItemLifecycleObservation);
  const seen = new Map<WorkItemLifecycleScenarioId, number>();
  for (const result of results) {
    seen.set(result.scenarioId, (seen.get(result.scenarioId) ?? 0) + 1);
  }
  const missingScenarioIds = workItemLifecycleScenarioIds.filter((scenarioId) =>
    !seen.has(scenarioId)
  );
  const duplicateScenarioIds = workItemLifecycleScenarioIds.filter((scenarioId) =>
    (seen.get(scenarioId) ?? 0) > 1
  );
  return {
    schemaVersion: WORK_ITEM_LIFECYCLE_RELEASE_GATE_SCHEMA_VERSION,
    passed: results.every((result) => result.passed) &&
      missingScenarioIds.length === 0 &&
      duplicateScenarioIds.length === 0,
    results,
    missingScenarioIds,
    duplicateScenarioIds,
  };
}
