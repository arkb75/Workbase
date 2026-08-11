import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import pg from "pg";
import {
  appendLifecycleObservationToReport,
  removeLifecycleObservationFromReport,
} from "./work-item-lifecycle-observation-report.mjs";
import { resolveLifecycleRepositoryIdentity } from "./work-item-lifecycle-repository-identity.mjs";

const SCHEMA_VERSION = "workbase-work-item-lifecycle-release-gate-v3";
const liveEnabled = process.env.WORKBASE_LIFECYCLE_LIVE_E2E === "1";
const retainCreatedWorkItems =
  process.env.WORKBASE_LIFECYCLE_RETAIN_CREATED_WORK_ITEMS === "1";
const baseUrl = process.env.WORKBASE_APPLICATION_EVAL_BASE_URL ??
  "http://127.0.0.1:3000";
const repositoryId = process.env.WORKBASE_LIVE_REPOSITORY_ID ?? "";
const configuredRepositoryFullName =
  process.env.WORKBASE_LIVE_REPOSITORY_FULL_NAME ?? "";
let repositoryFullName = configuredRepositoryFullName;
const expectedHeadSha = (
  process.env.WORKBASE_LIVE_EXPECTED_HEAD_SHA ?? ""
).toLowerCase();
const provider = process.env.WORKBASE_LLM_PROVIDER ?? "";
const testedGitCommit = (
  process.env.WORKBASE_TESTED_GIT_COMMIT ?? ""
).toLowerCase();
const repositorySynthesisMode =
  process.env.WORKBASE_REPOSITORY_SYNTHESIS_MODE ?? "deterministic";
const expectedDeepSynthesisModelId = provider === "openrouter"
  ? process.env.WORKBASE_OPENROUTER_MODEL_DEEP_SYNTHESIS ??
    process.env.WORKBASE_OPENROUTER_MODEL_ID ??
    "openai/gpt-5.6-terra"
  : process.env.WORKBASE_BEDROCK_MODEL_ID ?? "";
const expectedDraftingModelId = provider === "openrouter"
  ? process.env.WORKBASE_OPENROUTER_MODEL_DRAFTING ??
    process.env.WORKBASE_OPENROUTER_MODEL_ID ??
    "openai/gpt-5.4-mini"
  : process.env.WORKBASE_BEDROCK_MODEL_ID ?? "";
const expectedVerificationModelId = provider === "openrouter"
  ? process.env.WORKBASE_OPENROUTER_MODEL_VERIFICATION ??
    process.env.WORKBASE_OPENROUTER_MODEL_ID ??
    "openai/gpt-5.4-nano"
  : process.env.WORKBASE_BEDROCK_MODEL_ID ?? "";
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
const outputPath = process.env.WORKBASE_LIFECYCLE_OBSERVATIONS_OUTPUT ??
  `/tmp/workbase-lifecycle-live-${Date.now()}.json`;
const suiteId = randomUUID().slice(0, 8);
const titlePrefix = `Lifecycle eval ${suiteId}`;
const terminalTimeoutMs = Number(
  process.env.WORKBASE_LIFECYCLE_TERMINAL_TIMEOUT_MS ?? 10 * 60_000,
);
const evidenceReadySloMs = Number(
  process.env.WORKBASE_LIFECYCLE_EVIDENCE_READY_SLO_MS ?? 120_000,
);
const refreshTerminalSloMs = Number(
  process.env.WORKBASE_LIFECYCLE_REFRESH_TERMINAL_SLO_MS ?? 10 * 60_000,
);
const automaticHighlightsTerminalSloMs = Number(
  process.env.WORKBASE_LIFECYCLE_HIGHLIGHTS_TERMINAL_SLO_MS ?? 10 * 60_000,
);
const manualAgentRunTerminalSloMs = Number(
  process.env.WORKBASE_LIFECYCLE_MANUAL_AGENT_RUN_TERMINAL_SLO_MS ?? 120_000,
);
const totalSloMs = Number(
  process.env.WORKBASE_LIFECYCLE_TOTAL_SLO_MS ?? terminalTimeoutMs,
);
const highlightStartupGraceMs = Number(
  process.env.WORKBASE_LIFECYCLE_HIGHLIGHT_STARTUP_GRACE_MS ?? 30_000,
);

const configurationErrors = [
  !repositoryId ? "WORKBASE_LIVE_REPOSITORY_ID" : null,
  !configuredRepositoryFullName ? "WORKBASE_LIVE_REPOSITORY_FULL_NAME" : null,
  !/^[a-f0-9]{40}$/u.test(expectedHeadSha)
    ? "WORKBASE_LIVE_EXPECTED_HEAD_SHA (full 40-character SHA)"
    : null,
  provider !== "bedrock" && provider !== "openrouter"
    ? "WORKBASE_LLM_PROVIDER (bedrock or openrouter)"
    : null,
  !/^[a-f0-9]{40}$/u.test(testedGitCommit)
    ? "WORKBASE_TESTED_GIT_COMMIT (full 40-character SHA)"
    : null,
  !databaseUrl ? "DIRECT_URL or DATABASE_URL" : null,
  ...[
    ["WORKBASE_LIFECYCLE_TERMINAL_TIMEOUT_MS", terminalTimeoutMs],
    ["WORKBASE_LIFECYCLE_EVIDENCE_READY_SLO_MS", evidenceReadySloMs],
    ["WORKBASE_LIFECYCLE_REFRESH_TERMINAL_SLO_MS", refreshTerminalSloMs],
    [
      "WORKBASE_LIFECYCLE_MANUAL_AGENT_RUN_TERMINAL_SLO_MS",
      manualAgentRunTerminalSloMs,
    ],
    [
      "WORKBASE_LIFECYCLE_HIGHLIGHTS_TERMINAL_SLO_MS",
      automaticHighlightsTerminalSloMs,
    ],
    ["WORKBASE_LIFECYCLE_TOTAL_SLO_MS", totalSloMs],
  ].flatMap(([name, value]) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? []
      : [name]
  ),
].filter(Boolean);

let pool;

function elapsed(startedAt) {
  return Date.now() - startedAt;
}

function observedElapsed(value, startedAt, fallback) {
  const numericTimestamp = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  const timestamp = Number.isFinite(numericTimestamp)
    ? numericTimestamp
    : value instanceof Date
      ? value.getTime()
      : Date.parse(value ?? "");
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - startedAt)
    : fallback;
}

async function poll(description, callback, predicate, timeoutMs = terminalTimeoutMs) {
  const startedAt = Date.now();
  let latest;
  while (Date.now() - startedAt <= timeoutMs) {
    latest = await callback();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${description} did not complete within ${timeoutMs} ms.`);
}

async function findWorkItemByTitle(title) {
  const result = await pool.query(
    `SELECT "id", "title" FROM "WorkItem" WHERE "title" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [title],
  );
  return result.rows[0] ?? null;
}

async function findWorkItemById(workItemId) {
  const result = await pool.query(
    `SELECT "id", "title" FROM "WorkItem" WHERE "id" = $1 LIMIT 1`,
    [workItemId],
  );
  return result.rows[0] ?? null;
}

async function listIds(sql, workItemId) {
  const result = await pool.query(sql, [workItemId]);
  return result.rows.map((row) => row.id);
}

async function captureLineage(workItemId) {
  const [
    sourceIds,
    refreshRunIds,
    snapshotIds,
    evidenceItemIds,
    highlightIds,
    projectFactIds,
    generationRunIds,
  ] = await Promise.all([
    listIds(`SELECT "id" FROM "Source" WHERE "workItemId" = $1`, workItemId),
    listIds(`SELECT "id" FROM "KnowledgeRefreshRun" WHERE "workItemId" = $1`, workItemId),
    listIds(`SELECT "id" FROM "RepositorySnapshot" WHERE "workItemId" = $1`, workItemId),
    listIds(`SELECT "id" FROM "EvidenceItem" WHERE "workItemId" = $1`, workItemId),
    listIds(`SELECT "id" FROM "Claim" WHERE "workItemId" = $1`, workItemId),
    listIds(`SELECT "id" FROM "ProjectFact" WHERE "workItemId" = $1`, workItemId),
    listIds(`SELECT "id" FROM "GenerationRun" WHERE "workItemId" = $1`, workItemId),
  ]);
  return {
    workItemId,
    sourceIds,
    refreshRunIds,
    snapshotIds,
    evidenceItemIds,
    highlightIds,
    projectFactIds,
    generationRunIds,
  };
}

async function loadAutomaticHighlightRows(workItemId) {
  const result = await pool.query(
    `SELECT c."id", c."text", c."lifecycleStatus", c."verificationStatus", c."reviewState", c."approvalSource", c."metadata"->>'managedBy' AS "managedBy", c."metadata"->>'originatingAgentRunId' AS "originatingAgentRunId", c."supersedesHighlightId", c."validatedThroughSha", c."validationHeads", (EXTRACT(EPOCH FROM (c."createdAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "createdAtEpochMs", COALESCE((SELECT jsonb_agg(jsonb_build_object('evidenceItemId', he."evidenceItemId", 'sourceId', ei."sourceId", 'sourceType', source."type"::text) ORDER BY he."id") FROM "HighlightEvidence" he JOIN "EvidenceItem" ei ON ei."id" = he."evidenceItemId" JOIN "Source" source ON source."id" = ei."sourceId" WHERE he."highlightId" = c."id"), '[]'::jsonb) AS "evidence" FROM "Claim" c WHERE c."workItemId" = $1 AND c."approvalSource" = 'automation' ORDER BY c."createdAt" ASC`,
    [workItemId],
  );
  return result.rows;
}

function normalizeHighlight(row, observedRepositoryId, observedRepository) {
  const evidence = Array.isArray(row.evidence)
    ? row.evidence.flatMap((entry) => {
        const item = objectRecord(entry);
        return typeof item.evidenceItemId === "string" &&
          typeof item.sourceId === "string" &&
          typeof item.sourceType === "string"
          ? [{
              evidenceItemId: item.evidenceItemId,
              sourceId: item.sourceId,
              sourceType: item.sourceType,
            }]
          : [];
      })
    : [];
  return {
    id: row.id,
    text: row.text,
    lifecycleStatus: row.lifecycleStatus,
    verificationStatus: row.verificationStatus,
    reviewState: row.reviewState,
    approvalSource: row.approvalSource,
    managedBy: row.managedBy ?? "missing",
    originatingAgentRunId: optionalString(row.originatingAgentRunId),
    supersedesHighlightId: optionalString(row.supersedesHighlightId),
    evidenceItemIds: evidence.map((entry) => entry.evidenceItemId),
    evidence,
    validatedThroughSha: row.validatedThroughSha?.toLowerCase() ?? null,
    validationHeads: normalizeValidationHeads(
      row.validationHeads,
      observedRepositoryId,
      observedRepository,
    ),
  };
}

async function captureInitialAttachState(workItemId) {
  const [sourceResult, highlightRows] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS "count" FROM "Source" WHERE "workItemId" = $1 AND "type" = 'github_repo'`,
      [workItemId],
    ),
    loadAutomaticHighlightRows(workItemId),
  ]);
  return {
    initialState: {
      workItemExisted: true,
      sourceCount: sourceResult.rows[0]?.count ?? 0,
      highlightCount: highlightRows.length,
    },
    baselineAutomaticHighlights: highlightRows.map((row) =>
      normalizeHighlight(row, repositoryId, repositoryFullName)
    ),
  };
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNonNegativeInteger(value) {
  return typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0
    ? value
    : null;
}

function failedProviderAttemptCount(value) {
  return Array.isArray(value)
    ? value.length
    : optionalNonNegativeInteger(value);
}

function requestIdsFromAuditEvidence(...values) {
  const requestIds = new Set();
  const visited = new WeakSet();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) {
      return;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = objectRecord(value);
    if (typeof record.requestId === "string" && record.requestId.trim()) {
      requestIds.add(record.requestId.trim());
    }
    if (Array.isArray(record.requestIds)) {
      record.requestIds.forEach((requestId) => {
        if (typeof requestId === "string" && requestId.trim()) {
          requestIds.add(requestId.trim());
        }
      });
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  values.forEach((value) => visit(value, 0));
  return Array.from(requestIds);
}

function failedAttemptsFromAuditEvidence(...values) {
  const identities = new Set();
  const visited = new WeakSet();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) {
      return;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = objectRecord(value);
    for (const key of ["failedAttempts", "failedProviderAttempts"]) {
      if (!Array.isArray(record[key])) continue;
      record[key].forEach((attempt, index) => {
        const candidate = objectRecord(attempt);
        const requestId = optionalString(candidate.requestId);
        identities.add(requestId
          ? `request:${requestId}`
          : `${key}:${depth}:${index}:${JSON.stringify(candidate)}`);
      });
    }
    Object.entries(record).forEach(([key, entry]) => {
      if (key !== "failedAttempts" && key !== "failedProviderAttempts") {
        visit(entry, depth + 1);
      }
    });
  };
  values.forEach((value) => visit(value, 0));
  return identities.size;
}

function normalizeProviderGenerationRun(run) {
  const refs = objectRecord(run.resultRefs);
  const verificationAggregate = refs.aggregate === true;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    provider: run.provider,
    configuredProvider: optionalString(refs.configuredProvider) ?? (
      verificationAggregate ? null : provider
    ),
    modelId: run.modelId,
    profile: optionalString(refs.profile),
    configuredModelId: optionalString(refs.configuredModelId),
    requestIds: requestIdsFromAuditEvidence(
      run.resultRefs,
      run.inputSummary,
      run.tokenUsage,
    ),
    tokenUsage: run.tokenUsage ?? null,
    tokenUsagePresent: run.tokenUsage != null,
    estimatedCostUsd:
      typeof run.estimatedCostUsd === "number" &&
        Number.isFinite(run.estimatedCostUsd) &&
        run.estimatedCostUsd >= 0
        ? run.estimatedCostUsd
        : null,
    usageComplete: typeof refs.usageComplete === "boolean"
      ? refs.usageComplete
      : null,
    auditAttemptCount: optionalNonNegativeInteger(refs.auditAttemptCount),
    providerAttemptCount:
      optionalNonNegativeInteger(refs.providerAttemptCount),
    failedProviderAttempts:
      failedProviderAttemptCount(refs.failedProviderAttempts) ??
        failedAttemptsFromAuditEvidence(run.inputSummary, run.tokenUsage),
    unknownUsageAttempts:
      optionalNonNegativeInteger(refs.unknownUsageAttempts),
    auditEvidenceTruncated:
      typeof refs.auditEvidenceTruncated === "boolean"
        ? refs.auditEvidenceTruncated
        : null,
    agentRunId: optionalString(refs.agentRunId),
    role: verificationAggregate
      ? "verification_aggregate"
      : "provider_call",
    authoritativeGenerationRunId:
      optionalString(refs.authoritativeGenerationRunId),
    providerBatchGenerationRunIds:
      stringArray(refs.providerBatchGenerationRunIds),
  };
}

function normalizeCapabilitySynthesisRun(run) {
  return normalizeProviderGenerationRun(run);
}

function normalizeManualGenerationRun(run) {
  const refs = objectRecord(run.resultRefs);
  const auditAttemptCount = optionalNonNegativeInteger(refs.auditAttemptCount);
  const verificationAggregate = refs.aggregate === true;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    provider: run.provider,
    configuredProvider: optionalString(refs.configuredProvider) ?? (
      verificationAggregate ? optionalString(refs.configuredProvider) : provider
    ),
    modelId: run.modelId,
    profile: optionalString(refs.profile),
    configuredModelId: optionalString(refs.configuredModelId),
    requestIds: requestIdsFromAuditEvidence(
      run.resultRefs,
      run.inputSummary,
      run.tokenUsage,
    ),
    tokenUsage: run.tokenUsage ?? null,
    tokenUsagePresent: run.tokenUsage != null,
    estimatedCostUsd:
      typeof run.estimatedCostUsd === "number" &&
        Number.isFinite(run.estimatedCostUsd) &&
        run.estimatedCostUsd >= 0
        ? run.estimatedCostUsd
        : null,
    usageComplete: typeof refs.usageComplete === "boolean"
      ? refs.usageComplete
      : null,
    auditAttemptCount,
    providerAttemptCount:
      optionalNonNegativeInteger(refs.providerAttemptCount) ?? auditAttemptCount,
    failedProviderAttempts:
      failedProviderAttemptCount(refs.failedProviderAttempts) ??
        failedAttemptsFromAuditEvidence(run.inputSummary, run.tokenUsage),
    unknownUsageAttempts:
      optionalNonNegativeInteger(refs.unknownUsageAttempts),
    auditEvidenceTruncated:
      typeof refs.auditEvidenceTruncated === "boolean"
        ? refs.auditEvidenceTruncated
        : false,
    agentRunId: optionalString(refs.agentRunId),
    role: verificationAggregate
      ? "verification_aggregate"
      : "provider_call",
    authoritativeGenerationRunId:
      optionalString(refs.authoritativeGenerationRunId),
    providerBatchGenerationRunIds:
      stringArray(refs.providerBatchGenerationRunIds),
  };
}

function normalizeHeads(value, observedRepositoryId) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const head = objectRecord(entry);
    return typeof head.sourceId === "string" &&
      typeof head.repository === "string" &&
      typeof head.commitSha === "string"
      ? [{
          sourceId: head.sourceId,
          repositoryId: observedRepositoryId,
          repository: head.repository,
          commitSha: head.commitSha.toLowerCase(),
        }]
      : [];
  });
}

function normalizeValidationHeads(value, observedRepositoryId, observedRepository) {
  const record = objectRecord(value);
  return Object.entries(record).flatMap(([sourceId, commitSha]) =>
    typeof commitSha === "string"
      ? [{
          sourceId,
          repositoryId: observedRepositoryId,
          repository: observedRepository,
          commitSha: commitSha.toLowerCase(),
        }]
      : []
  );
}

async function loadLifecycleStateOnce(workItemId) {
  const [sourceResult, refreshResult, snapshotResult, highlightRows, generationResult] =
    await Promise.all([
      pool.query(
        `SELECT "id", "label", "externalId", "metadata", (EXTRACT(EPOCH FROM ("createdAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "createdAtEpochMs" FROM "Source" WHERE "workItemId" = $1 AND "type" = 'github_repo' ORDER BY "createdAt" DESC LIMIT 1`,
        [workItemId],
      ),
      pool.query(
        `SELECT "id", "status", "qualityStatus", "targetHeads", "completedHeads", "error", (EXTRACT(EPOCH FROM ("finishedAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "finishedAtEpochMs" FROM "KnowledgeRefreshRun" WHERE "workItemId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        [workItemId],
      ),
      pool.query(
        `SELECT "id", "sourceId", "commitSha", "inventoryComplete", "analysisComplete", "coverageComplete" FROM "RepositorySnapshot" WHERE "workItemId" = $1 ORDER BY "createdAt" ASC`,
        [workItemId],
      ),
      loadAutomaticHighlightRows(workItemId),
      pool.query(
        `SELECT "id", "kind", "status", "idempotencyKey", "provider", "modelId", "inputSummary", "resultRefs", "tokenUsage", "estimatedCostUsd"::double precision AS "estimatedCostUsd", (EXTRACT(EPOCH FROM ("updatedAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "updatedAtEpochMs" FROM "GenerationRun" WHERE "workItemId" = $1 ORDER BY "createdAt" ASC`,
        [workItemId],
      ),
    ]);
  const source = sourceResult.rows[0] ?? null;
  const sourceMetadata = objectRecord(source?.metadata);
  const repositoryImport = objectRecord(sourceMetadata.repositoryImport);
  const refresh = refreshResult.rows[0] ?? null;
  const generationRows = generationResult.rows;
  const refreshRunId = refresh?.id ?? null;
  const automationRows = generationRows.filter((run) => {
    if (![
      "highlight_generation",
      "highlight_verification",
      "capability_synthesis",
      "semantic_extraction",
    ].includes(run.kind) || !refreshRunId) {
      return false;
    }
    const inputSummary = objectRecord(run.inputSummary);
    const resultRefs = objectRecord(run.resultRefs);
    return inputSummary.refreshRunId === refreshRunId ||
      resultRefs.refreshRunId === refreshRunId ||
      (
        typeof run.idempotencyKey === "string" &&
        run.idempotencyKey.includes(refreshRunId)
      );
  });
  const semanticExtractionRows = automationRows.filter((run) =>
    run.kind === "semantic_extraction"
  );
  const capabilitySynthesisRows = automationRows.filter((run) =>
    run.kind === "capability_synthesis"
  );
  const failedGenerationRows = automationRows.filter((run) =>
    !["queued", "running", "success"].includes(run.status)
  );
  const failedSemanticExtractionRows = semanticExtractionRows.filter((run) =>
    !["queued", "running", "success"].includes(run.status)
  );
  const runningGenerationRows = automationRows.filter((run) =>
    ["queued", "running"].includes(run.status)
  );
  const highlights = highlightRows;
  const repositoryHighlights = highlights.filter((highlight) =>
    highlight.managedBy === "repository_knowledge_sync" ||
    highlight.validatedThroughSha?.toLowerCase() === expectedHeadSha
  );
  const automationStatus = failedGenerationRows.length > 0
    ? "failed"
    : repositoryHighlights.length > 0 && runningGenerationRows.length === 0
      ? "completed"
      : automationRows.length > 0
        ? "pending"
        : "not_started";
  return {
    source,
    repositoryImport,
    refresh,
    snapshots: snapshotResult.rows,
    highlights,
    repositoryHighlights,
    generationRows,
    automationRows,
    failedGenerationRows,
    semanticExtractionRows,
    failedSemanticExtractionRows,
    capabilitySynthesisRows,
    automationSettled:
      automationRows.length > 0 && runningGenerationRows.length === 0,
    automationStatus,
  };
}

const TRANSIENT_DATABASE_ERROR_CODES = new Set([
  "EADDRNOTAVAIL",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETDOWN",
  "ENETUNREACH",
  "57P01",
  "57P02",
  "57P03",
]);

function isTransientDatabaseError(error) {
  if (!error || typeof error !== "object") return false;
  if (TRANSIENT_DATABASE_ERROR_CODES.has(error.code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:connection terminated unexpectedly|connection timeout|socket hang up)/iu
    .test(message);
}

async function loadLifecycleState(workItemId) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await loadLifecycleStateOnce(workItemId);
    } catch (error) {
      if (!isTransientDatabaseError(error)) throw error;
      lastError = error;
      if (attempt < 4) {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * (2 ** attempt))
        );
      }
    }
  }
  throw lastError;
}

function sourceRevisionSha(source) {
  const metadata = objectRecord(source?.metadata);
  const revision = objectRecord(metadata.revision);
  return typeof revision.commitSha === "string"
    ? revision.commitSha.toLowerCase()
    : null;
}

function terminalState(state) {
  if (!state.refresh) return false;
  if (["failed", "cancelled"].includes(state.refresh.status)) return true;
  return state.refresh.status === "completed" &&
    ["completed", "failed"].includes(state.automationStatus);
}

async function observeLifecycle(workItemLocator, startedAt) {
  const milestones = {
    actionAcknowledged: null,
    sourceReserved: null,
    evidenceReady: null,
    refreshTerminal: null,
    automaticHighlightsTerminal: null,
  };
  let workItemId = typeof workItemLocator === "string" ? workItemLocator : null;
  let latest = null;
  let refreshTerminalObservedAt = null;
  while (elapsed(startedAt) <= terminalTimeoutMs) {
    if (!workItemId) {
      const workItem = await findWorkItemByTitle(workItemLocator.title);
      workItemId = workItem?.id ?? null;
    }
    if (!workItemId) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    const current = await loadLifecycleState(workItemId);
    latest = { workItemId, current };
    if (current.source && milestones.sourceReserved == null) {
      milestones.sourceReserved = observedElapsed(
        current.source.createdAtEpochMs,
        startedAt,
        elapsed(startedAt),
      );
    }
    if (
      current.repositoryImport.status === "evidence_ready" &&
      milestones.evidenceReady == null
    ) {
      milestones.evidenceReady = observedElapsed(
        current.repositoryImport.finishedAt,
        startedAt,
        elapsed(startedAt),
      );
    }
    if (
      current.refresh &&
      ["completed", "failed", "cancelled"].includes(current.refresh.status) &&
      milestones.refreshTerminal == null
    ) {
      milestones.refreshTerminal = observedElapsed(
        current.refresh.finishedAtEpochMs,
        startedAt,
        elapsed(startedAt),
      );
      refreshTerminalObservedAt = Date.now();
    }
    if (
      ["completed", "failed"].includes(current.automationStatus) &&
      milestones.automaticHighlightsTerminal == null
    ) {
      const terminalTimestamps = [
        ...current.automationRows.map((run) => run.updatedAtEpochMs),
        ...current.highlights.map((highlight) => highlight.createdAtEpochMs),
      ].map((value) => observedElapsed(value, startedAt, elapsed(startedAt)));
      milestones.automaticHighlightsTerminal = terminalTimestamps.length > 0
        ? Math.max(...terminalTimestamps)
        : elapsed(startedAt);
    }
    const generationSettledWithoutHighlights =
      current.refresh?.status === "completed" &&
      current.automationSettled &&
      current.repositoryHighlights.length === 0;
    const automationNeverStarted =
      current.refresh?.status === "completed" &&
      current.automationStatus === "not_started" &&
      refreshTerminalObservedAt != null &&
      Date.now() - refreshTerminalObservedAt >= highlightStartupGraceMs;
    if (
      terminalState(current) ||
      generationSettledWithoutHighlights ||
      automationNeverStarted
    ) {
      return {
        ...latest,
        milestones,
        timedOut: false,
        terminalReason: generationSettledWithoutHighlights
          ? "automatic_highlight_generation_produced_no_highlights"
          : automationNeverStarted
            ? "automatic_highlight_generation_not_started"
            : null,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (latest) {
    return {
      ...latest,
      milestones,
      timedOut: true,
      terminalReason: "lifecycle_timed_out",
    };
  }
  throw new Error(
    `Work Item lifecycle did not create an observable Work Item within ${terminalTimeoutMs} ms.`,
  );
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
}

function manualRequestIdentity(value) {
  const request = objectRecord(value);
  const evidenceItems = Array.isArray(request.evidenceItems)
    ? request.evidenceItems.map(objectRecord)
    : [];
  return {
    trigger: optionalString(request.trigger) ?? "missing",
    sourceIds: stringArray(request.sourceIds),
    evidenceItemIds: evidenceItems.flatMap((item) =>
      typeof item.id === "string" && item.id.trim() ? [item.id] : []
    ),
    inputFingerprint: optionalString(request.inputFingerprint) ?? "missing",
  };
}

async function loadManualLifecycleState(workItemId) {
  const runResult = await pool.query(
    `SELECT "id", "kind"::text AS "kind", "status"::text AS "status", "workflowId", "request", "result", "error", (EXTRACT(EPOCH FROM ("createdAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "createdAtEpochMs", (EXTRACT(EPOCH FROM ("finishedAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "finishedAtEpochMs" FROM "AgentRun" WHERE "workItemId" = $1 AND "kind" = 'manual_evidence_highlights' ORDER BY "createdAt" DESC LIMIT 1`,
    [workItemId],
  );
  const run = runResult.rows[0] ?? null;
  if (!run) {
    return {
      run: null,
      request: null,
      sources: [],
      generationRows: [],
      highlights: [],
    };
  }
  const request = manualRequestIdentity(run.request);
  const [sourceResult, generationResult, highlightRows] = await Promise.all([
    pool.query(
      `SELECT "id", "type"::text AS "type", (EXTRACT(EPOCH FROM ("createdAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "createdAtEpochMs" FROM "Source" WHERE "workItemId" = $1 AND "id" = ANY($2::text[]) ORDER BY "createdAt" ASC`,
      [workItemId, request.sourceIds],
    ),
    pool.query(
      `SELECT "id", "kind"::text AS "kind", "status"::text AS "status", "provider", "modelId", "inputSummary", "resultRefs", "tokenUsage", "estimatedCostUsd"::double precision AS "estimatedCostUsd", (EXTRACT(EPOCH FROM ("updatedAt" AT TIME ZONE 'UTC')) * 1000)::double precision AS "updatedAtEpochMs" FROM "GenerationRun" WHERE "workItemId" = $1 AND "kind" IN ('highlight_generation', 'highlight_verification') AND "resultRefs"->>'agentRunId' = $2 ORDER BY "createdAt" ASC`,
      [workItemId, run.id],
    ),
    loadAutomaticHighlightRows(workItemId),
  ]);
  return {
    run,
    request,
    sources: sourceResult.rows,
    generationRows: generationResult.rows,
    highlights: highlightRows.filter((highlight) =>
      highlight.originatingAgentRunId === run.id
    ),
  };
}

async function observeManualLifecycle(workItemLocator, startedAt) {
  const milestones = {
    sourceReserved: null,
    agentRunReserved: null,
    agentRunTerminal: null,
    automaticHighlightsTerminal: null,
  };
  let workItemId = typeof workItemLocator === "string" ? workItemLocator : null;
  let latest = null;
  while (elapsed(startedAt) <= terminalTimeoutMs) {
    if (!workItemId) {
      const workItem = await findWorkItemByTitle(workItemLocator.title);
      workItemId = workItem?.id ?? null;
    }
    if (!workItemId) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    const current = await loadManualLifecycleState(workItemId);
    latest = { workItemId, current };
    if (current.run && milestones.agentRunReserved == null) {
      milestones.agentRunReserved = observedElapsed(
        current.run.createdAtEpochMs,
        startedAt,
        elapsed(startedAt),
      );
    }
    if (
      current.request?.sourceIds.length > 0 &&
      current.sources.length === current.request.sourceIds.length &&
      milestones.sourceReserved == null
    ) {
      milestones.sourceReserved = Math.max(
        ...current.sources.map((source) =>
          observedElapsed(
            source.createdAtEpochMs,
            startedAt,
            elapsed(startedAt),
          )
        ),
      );
    }
    if (
      current.run &&
      ["completed", "insufficient_context", "failed", "cancelled"].includes(
        current.run.status,
      )
    ) {
      milestones.agentRunTerminal = observedElapsed(
        current.run.finishedAtEpochMs,
        startedAt,
        elapsed(startedAt),
      );
      const terminalTimestamps = [
        current.run.finishedAtEpochMs,
        ...current.generationRows.map((run) => run.updatedAtEpochMs),
        ...current.highlights.map((highlight) => highlight.createdAtEpochMs),
      ].map((value) => observedElapsed(value, startedAt, elapsed(startedAt)));
      milestones.automaticHighlightsTerminal = Math.max(...terminalTimestamps);
      return {
        ...latest,
        milestones,
        timedOut: false,
        terminalReason: current.run.status === "completed"
          ? null
          : `manual_agent_run_${current.run.status}`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (latest) {
    return {
      ...latest,
      milestones,
      timedOut: true,
      terminalReason: "manual_agent_run_timed_out",
    };
  }
  throw new Error(
    `Manual Work Item lifecycle did not become observable within ${terminalTimeoutMs} ms.`,
  );
}

async function prepareCreateWorkItem(
  page,
  title,
  attachRepository,
  manualNotes = null,
) {
  const query = attachRepository
    ? `?repoId=${encodeURIComponent(repositoryId)}&attachRepositoryOnCreate=true`
    : "";
  await page.goto(`${baseUrl}/work-items/new${query}`);
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill(
    "Live lifecycle release-gate fixture created only for cold import and automatic Highlight verification.",
  );
  if (attachRepository) {
    const form = page.locator("#new-work-item-form");
    const identity = resolveLifecycleRepositoryIdentity({
      expectedRepositoryId: repositoryId,
      configuredRepositoryFullName,
      selectedRepositoryId: await form
        .locator('input[name="repositoryId"]')
        .inputValue(),
      selectedRepositoryFullName: await form
        .locator('input[name="repositoryFullName"]')
        .inputValue(),
    });
    repositoryFullName = identity.fullName;
    const checkbox = form.getByRole("checkbox");
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveAccessibleName(
      new RegExp(
        `Attach and import ${repositoryFullName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
        "iu",
      ),
    );
    await checkbox.check();
  }
  if (manualNotes) {
    const manualNotesPanel = page.locator("details").filter({
      hasText: "Manual notes",
    });
    await manualNotesPanel.locator("summary").click();
    await page.getByLabel("Source notes").fill(manualNotes);
  }
}

async function submitCreateWorkItem(page, attachRepository) {
  await page.getByRole("button", { name: "Create Work Item" }).click();
  await page.waitForURL((url) =>
    /\/work-items\/[^/]+$/u.test(url.pathname) &&
    (
      !attachRepository ||
      url.searchParams.get("result") === "github-import-queued"
    ), { timeout: terminalTimeoutMs });
}

async function prepareAttachRepository(page, workItemId) {
  await page.goto(
    `${baseUrl}/work-items/${workItemId}?tab=sources&repoId=${encodeURIComponent(repositoryId)}`,
  );
  const form = page.locator(
    `form:has(input[name="repositoryId"][value="${repositoryId}"])`,
  );
  await expect(form).toHaveCount(1);
  const identity = resolveLifecycleRepositoryIdentity({
    expectedRepositoryId: repositoryId,
    configuredRepositoryFullName,
    selectedRepositoryId: await form
      .locator('input[name="repositoryId"]')
      .inputValue(),
    selectedRepositoryFullName: await form
      .locator('input[name="repositoryFullName"]')
      .inputValue(),
  });
  repositoryFullName = identity.fullName;
  return form;
}

async function submitAttachRepository(page, workItemId, form) {
  await form.getByRole("button", { name: "Attach & import" }).click();
  await page.waitForURL((url) =>
    url.pathname === `/work-items/${workItemId}` &&
    url.searchParams.get("result") === "github-import-queued", {
    timeout: terminalTimeoutMs,
  });
}

async function deleteCreatedWorkItem(page, workItemId, title) {
  const stored = await findWorkItemById(workItemId);
  if (!stored) return;
  if (stored.title !== title || !stored.title.startsWith(titlePrefix)) {
    throw new Error("Refusing to delete a Work Item outside this live lifecycle run.");
  }
  await page.goto(`${baseUrl}/dashboard`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", {
    name: `Delete ${title}`,
    exact: true,
  }).click();
  await poll(
    `deletion of ${workItemId}`,
    () => findWorkItemById(workItemId),
    (value) => value === null,
    60_000,
  );
}

function allLineageIds(lineage) {
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

async function buildObservation(input) {
  const { current, workItemId, milestones } = input.lifecycle;
  const currentLineage = await captureLineage(workItemId);
  const currentIds = new Set(allLineageIds(currentLineage));
  const leakedPriorEntityIds = input.priorLineage
    ? allLineageIds(input.priorLineage).filter((id) => currentIds.has(id))
    : [];
  const observedRepositoryId = current.source?.externalId ?? "missing-repository-id";
  const observedRepository = current.source?.label ?? "missing-repository";
  const targetHeads = normalizeHeads(
    current.refresh?.targetHeads,
    observedRepositoryId,
  );
  const completedHeads = normalizeHeads(
    current.refresh?.completedHeads,
    observedRepositoryId,
  );
  const refreshFailed = current.refresh && current.refresh.status !== "completed";
  const automationFailed = current.automationStatus !== "completed";
  const timedOut = input.lifecycle.timedOut === true;
  const total = elapsed(input.startedAt);
  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: input.scenarioId,
    provider,
    observedAt: new Date().toISOString(),
    initialState: input.initialState,
    repository: {
      repositoryId: observedRepositoryId,
      fullName: observedRepository,
      configuredFullName: configuredRepositoryFullName,
      canonicalized:
        configuredRepositoryFullName !== observedRepository,
      expectedHeadSha,
      sourceId: current.source?.id ?? "missing-source",
      sourceRevisionSha: sourceRevisionSha(current.source),
      targetHeads,
      completedHeads,
    },
    repositoryImport: {
      requestId: typeof current.repositoryImport.requestId === "string"
        ? current.repositoryImport.requestId
        : null,
      workflowId: typeof current.repositoryImport.workflowId === "string"
        ? current.repositoryImport.workflowId
        : null,
      refreshRunId: typeof current.repositoryImport.refreshRunId === "string"
        ? current.repositoryImport.refreshRunId
        : null,
      status: typeof current.repositoryImport.status === "string"
        ? current.repositoryImport.status
        : "missing",
      error: typeof current.repositoryImport.error === "string"
        ? "present"
        : null,
      evidenceCount: typeof current.repositoryImport.evidenceCount === "number"
        ? current.repositoryImport.evidenceCount
        : null,
    },
    refresh: {
      id: current.refresh?.id ?? "missing-refresh",
      status: current.refresh?.status ?? "missing",
      qualityStatus: current.refresh?.qualityStatus ?? "missing",
      error: current.refresh?.error == null ? null : "present",
    },
    snapshots: current.snapshots.map((snapshot) => ({
      id: snapshot.id,
      sourceId: snapshot.sourceId,
      commitSha: snapshot.commitSha.toLowerCase(),
      inventoryComplete: snapshot.inventoryComplete,
      analysisComplete: snapshot.analysisComplete,
      coverageComplete: snapshot.coverageComplete,
    })),
    baselineAutomaticHighlights: input.baselineAutomaticHighlights ?? [],
    automaticHighlights: current.highlights.map((highlight) =>
      normalizeHighlight(
        highlight,
        observedRepositoryId,
        observedRepository,
      )
    ),
    automation: {
      status: current.automationStatus,
      repositorySynthesisMode,
      expectedDeepSynthesisModelId:
        expectedDeepSynthesisModelId || "missing-deep-synthesis-model",
      generationRunIds: current.automationRows.map((run) => run.id),
      failedGenerationRunIds: current.failedGenerationRows.map((run) => run.id),
      semanticExtractionRunIds:
        current.semanticExtractionRows.map((run) => run.id),
      failedSemanticExtractionRunIds:
        current.failedSemanticExtractionRows.map((run) => run.id),
      capabilitySynthesisRuns:
        current.capabilitySynthesisRows.map(normalizeCapabilitySynthesisRun),
      generationRuns:
        current.generationRows.map(normalizeProviderGenerationRun),
      observedProviders: Array.from(new Set(
        current.automationRows.map((run) => run.provider),
      )).sort(),
      observedModelIds: Array.from(new Set(
        current.automationRows.map((run) => run.modelId),
      )).sort(),
    },
    terminalOutcome: {
      status: timedOut
        ? "timed_out"
        : refreshFailed || automationFailed
          ? "failed"
          : "completed",
      message: input.lifecycle.terminalReason ?? (
        refreshFailed
          ? "repository_refresh_failed"
          : automationFailed
            ? "automatic_highlight_generation_failed"
            : null
      ),
    },
    currentLineage,
    priorLineage: input.priorLineage
      ? {
          ...input.priorLineage,
          repositoryId: observedRepositoryId,
          repository: observedRepository,
          deleted: input.priorDeleted,
        }
      : null,
    leakedPriorEntityIds,
    sloMs: {
      evidenceReady: evidenceReadySloMs,
      refreshTerminal: refreshTerminalSloMs,
      automaticHighlightsTerminal: automaticHighlightsTerminalSloMs,
      total: totalSloMs,
    },
    timingsMs: {
      actionAcknowledged: input.actionAcknowledgedMs,
      sourceReserved: milestones.sourceReserved ?? total,
      evidenceReady: milestones.evidenceReady ?? total,
      refreshTerminal: milestones.refreshTerminal ?? total,
      automaticHighlightsTerminal:
        milestones.automaticHighlightsTerminal ?? total,
      total,
    },
  };
}

async function buildManualObservation(input) {
  const { current, workItemId, milestones } = input.lifecycle;
  const currentLineage = await captureLineage(workItemId);
  const runResult = objectRecord(current.run?.result);
  const terminalOutcome = optionalString(runResult.terminalOutcome);
  const result = ["ready", "no_safe_candidates", "superseded_input"].includes(
    terminalOutcome,
  )
    ? {
        terminalOutcome,
        createdHighlightIds: stringArray(runResult.createdHighlightIds),
        replayedHighlightIds: stringArray(runResult.replayedHighlightIds),
        deduplicatedHighlightIds:
          stringArray(runResult.deduplicatedHighlightIds),
        suggestionIds: stringArray(runResult.suggestionIds),
        suppressedHighlightIds: stringArray(runResult.suppressedHighlightIds),
        generationRunIds: stringArray(runResult.generationRunIds),
        managedBy: optionalString(runResult.managedBy) ?? "missing",
        inputFingerprint:
          optionalString(runResult.inputFingerprint) ?? "missing",
      }
    : null;
  const timedOut = input.lifecycle.timedOut === true;
  const runStatus = current.run?.status ?? "missing";
  const total = elapsed(input.startedAt);
  const request = current.request ?? {
    trigger: "missing",
    sourceIds: [],
    evidenceItemIds: [],
    inputFingerprint: "missing",
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: "manual_only_create",
    provider,
    observedAt: new Date().toISOString(),
    initialState: {
      workItemExisted: false,
      sourceCount: 0,
      highlightCount: 0,
    },
    terminalOutcome: {
      status: timedOut
        ? "timed_out"
        : runStatus === "completed"
          ? "completed"
          : runStatus === "cancelled"
            ? "cancelled"
            : "failed",
      message: input.lifecycle.terminalReason ??
        (current.run?.error == null ? null : "manual_agent_run_error"),
    },
    manualEvidence: {
      sourceIds: request.sourceIds,
      evidenceItemIds: request.evidenceItemIds,
    },
    manualAgentRun: {
      id: current.run?.id ?? "missing-manual-agent-run",
      kind: current.run?.kind ?? "missing",
      status: runStatus,
      workflowId: optionalString(current.run?.workflowId),
      error: current.run?.error == null ? null : "present",
      request,
      result,
      generationRuns: current.generationRows.map(normalizeManualGenerationRun),
      expectedModelIds: {
        drafting: expectedDraftingModelId || "missing-drafting-model",
        verification:
          expectedVerificationModelId || "missing-verification-model",
      },
    },
    automaticHighlights: current.highlights.map((highlight) =>
      normalizeHighlight(highlight, "manual-evidence", "manual-evidence")
    ),
    currentLineage,
    leakedPriorEntityIds: [],
    sloMs: {
      agentRunTerminal: manualAgentRunTerminalSloMs,
      automaticHighlightsTerminal: automaticHighlightsTerminalSloMs,
      total: totalSloMs,
    },
    timingsMs: {
      actionAcknowledged: input.actionAcknowledgedMs,
      sourceReserved: milestones.sourceReserved ?? total,
      agentRunReserved: milestones.agentRunReserved ?? total,
      agentRunTerminal: milestones.agentRunTerminal ?? total,
      automaticHighlightsTerminal:
        milestones.automaticHighlightsTerminal ?? total,
      total,
    },
  };
}

async function appendObservation(observation) {
  let priorReport = {};
  try {
    priorReport = JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }
  const report = appendLifecycleObservationToReport({
    priorReport,
    schemaVersion: SCHEMA_VERSION,
    gitCommit: testedGitCommit,
    baseUrl,
    observation,
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function removeObservation(workItemId) {
  const priorReport = JSON.parse(await readFile(outputPath, "utf8"));
  const report = removeLifecycleObservationFromReport({
    priorReport,
    workItemId,
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function createAndObserve(page, scenarioId, title, priorLineage = null) {
  await prepareCreateWorkItem(page, title, true);
  const startedAt = Date.now();
  const submitPromise = submitCreateWorkItem(page, true);
  const lifecyclePromise = observeLifecycle({ title }, startedAt);
  await submitPromise;
  const actionAcknowledgedMs = elapsed(startedAt);
  const lifecycle = await lifecyclePromise;
  const observation = await buildObservation({
    scenarioId,
    initialState: {
      workItemExisted: false,
      sourceCount: 0,
      highlightCount: 0,
    },
    priorLineage,
    priorDeleted: priorLineage
      ? (await findWorkItemById(priorLineage.workItemId)) === null
      : false,
    baselineAutomaticHighlights: [],
    startedAt,
    actionAcknowledgedMs,
    lifecycle,
  });
  await appendObservation(observation);
  return observation;
}

async function createManualAndObserve(page, title, append = true) {
  const manualNotes = [
    "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.",
    "Implemented profile-specific routing, durable provider usage and cost attribution, and paired Bedrock/OpenRouter quality gates.",
    "Preserved evidence-grounded citations and exact repository-head freshness checks across the migration.",
  ].join(" ");
  await prepareCreateWorkItem(page, title, false, manualNotes);
  const startedAt = Date.now();
  const submitPromise = submitCreateWorkItem(page, false);
  const lifecyclePromise = observeManualLifecycle({ title }, startedAt);
  await submitPromise;
  const actionAcknowledgedMs = elapsed(startedAt);
  const lifecycle = await lifecyclePromise;
  const observation = await buildManualObservation({
    startedAt,
    actionAcknowledgedMs,
    lifecycle,
  });
  if (append) await appendObservation(observation);
  return observation;
}

function normalizedHighlightText(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function sorted(values) {
  return [...values].sort();
}

function assertManualObservation(observation) {
  expect(observation.terminalOutcome).toEqual({
    status: "completed",
    message: null,
  });
  expect(observation.manualAgentRun).toEqual(expect.objectContaining({
    kind: "manual_evidence_highlights",
    status: "completed",
    workflowId: expect.any(String),
    error: null,
  }));
  expect(observation.manualAgentRun.workflowId)
    .not.toMatch(/^(starting|inline-agent):/u);
  expect(observation.manualAgentRun.request.trigger).toBe("work_item_create");
  expect(observation.manualAgentRun.request.sourceIds.length).toBeGreaterThan(0);
  expect(observation.manualAgentRun.request.evidenceItemIds.length)
    .toBeGreaterThan(0);
  expect(observation.manualEvidence).toEqual({
    sourceIds: observation.manualAgentRun.request.sourceIds,
    evidenceItemIds: observation.manualAgentRun.request.evidenceItemIds,
  });
  expect(observation.manualAgentRun.result).toEqual(expect.objectContaining({
    terminalOutcome: "ready",
    managedBy: "manual_evidence_highlight_workflow",
    inputFingerprint:
      observation.manualAgentRun.request.inputFingerprint,
  }));
  expect(observation.manualAgentRun.result.replayedHighlightIds).toEqual([]);
  expect(observation.manualAgentRun.result.deduplicatedHighlightIds).toEqual([]);
  expect(observation.manualAgentRun.result.suggestionIds).toEqual([]);
  expect(observation.manualAgentRun.result.suppressedHighlightIds).toEqual([]);
  const generationRuns = observation.manualAgentRun.generationRuns;
  const providerRuns = generationRuns.filter((run) =>
    run.role === "provider_call"
  );
  const aggregates = generationRuns.filter((run) =>
    run.role === "verification_aggregate"
  );
  expect(providerRuns.map((run) => run.kind)).toEqual(expect.arrayContaining([
    "highlight_generation",
    "highlight_verification",
  ]));
  for (const run of providerRuns) {
    const expectedProfile = run.kind === "highlight_generation"
      ? "drafting"
      : "verification";
    const expectedModelId = observation.manualAgentRun.expectedModelIds[
      expectedProfile
    ];
    expect(run.status).toBe("success");
    expect(run.agentRunId).toBe(observation.manualAgentRun.id);
    expect(run.provider).toBe(provider);
    expect(run.configuredProvider).toBe(provider);
    expect(run.profile).toBe(expectedProfile);
    expect(run.configuredModelId).toBe(expectedModelId);
    expect(run.modelId).toBe(expectedModelId);
    expect(run.requestIds.length).toBeGreaterThan(0);
    expect(run.tokenUsagePresent).toBe(true);
    expect(run.tokenUsage).not.toBeNull();
    expect(run.estimatedCostUsd).toEqual(expect.any(Number));
    expect(run.usageComplete).toBe(true);
    expect(run.auditAttemptCount).toBeGreaterThan(0);
    expect(run.providerAttemptCount).toBeGreaterThan(0);
    expect(run.failedProviderAttempts).toBe(0);
    expect(run.unknownUsageAttempts).toBe(0);
    expect(run.auditEvidenceTruncated).toBe(false);
    expect(run.providerBatchGenerationRunIds).toEqual([]);
  }
  const providerVerificationRuns = providerRuns.filter((run) =>
    run.kind === "highlight_verification"
  );
  if (aggregates.length) {
    expect(aggregates).toHaveLength(1);
    const aggregate = aggregates[0];
    expect(aggregate).toEqual(expect.objectContaining({
      kind: "highlight_verification",
      status: "success",
      provider: "deterministic",
      modelId: "highlight-verification-aggregate-v1",
      profile: "verification",
      configuredProvider: provider,
      configuredModelId:
        observation.manualAgentRun.expectedModelIds.verification,
      tokenUsagePresent: false,
      estimatedCostUsd: null,
      usageComplete: true,
      auditAttemptCount: 0,
      providerAttemptCount: 0,
      failedProviderAttempts: 0,
      unknownUsageAttempts: 0,
      auditEvidenceTruncated: false,
      agentRunId: observation.manualAgentRun.id,
      authoritativeGenerationRunId: null,
    }));
    expect(providerVerificationRuns.length).toBeGreaterThanOrEqual(2);
    expect(sorted(aggregate.providerBatchGenerationRunIds)).toEqual(
      sorted(providerVerificationRuns.map((run) => run.id)),
    );
    for (const run of providerVerificationRuns) {
      expect(run.authoritativeGenerationRunId).toBe(aggregate.id);
    }
  } else {
    expect(providerVerificationRuns).toHaveLength(1);
    expect(providerVerificationRuns[0].authoritativeGenerationRunId).toBeNull();
  }
  const authoritativeGenerationRunIds = generationRuns.flatMap((run) =>
    run.role === "verification_aggregate" ||
      run.authoritativeGenerationRunId === null
      ? [run.id]
      : []
  );
  expect(sorted(observation.manualAgentRun.result.generationRunIds)).toEqual(
    sorted(authoritativeGenerationRunIds),
  );
  expect(sorted(observation.manualAgentRun.result.createdHighlightIds)).toEqual(
    sorted(observation.automaticHighlights.map((highlight) => highlight.id)),
  );
  const active = observation.automaticHighlights.filter((highlight) =>
    highlight.lifecycleStatus === "active" &&
    highlight.verificationStatus === "approved"
  );
  expect(active.length).toBeGreaterThan(0);
  for (const highlight of observation.automaticHighlights) {
    expect(["active", "quarantined"]).toContain(highlight.lifecycleStatus);
    expect(highlight.reviewState).toBe("pending_review");
    expect(highlight.approvalSource).toBe("automation");
    expect(highlight.managedBy).toBe("manual_evidence_highlight_workflow");
    expect(highlight.originatingAgentRunId).toBe(observation.manualAgentRun.id);
    expect(highlight.evidence.length).toBeGreaterThan(0);
    expect(highlight.evidenceItemIds).toEqual(
      highlight.evidence.map((entry) => entry.evidenceItemId),
    );
    for (const evidence of highlight.evidence) {
      expect(evidence.sourceType).toBe("manual_note");
      expect(observation.manualEvidence.sourceIds).toContain(evidence.sourceId);
      expect(observation.manualEvidence.evidenceItemIds)
        .toContain(evidence.evidenceItemId);
    }
    expect(highlight.validatedThroughSha).toBeNull();
    expect(highlight.validationHeads).toEqual([]);
  }
  expect(observation.timingsMs.actionAcknowledged).toBeLessThanOrEqual(5_000);
  expect(observation.timingsMs.sourceReserved).toBeLessThanOrEqual(5_000);
  expect(observation.timingsMs.agentRunReserved).toBeLessThanOrEqual(5_000);
  expect(observation.timingsMs.agentRunTerminal)
    .toBeLessThanOrEqual(observation.sloMs.agentRunTerminal);
  expect(observation.timingsMs.automaticHighlightsTerminal)
    .toBeLessThanOrEqual(observation.sloMs.automaticHighlightsTerminal);
  expect(observation.timingsMs.total).toBeLessThanOrEqual(observation.sloMs.total);
}

function assertCoreObservation(observation) {
  const expectedHead = {
    sourceId: observation.repository.sourceId,
    repositoryId,
    repository: repositoryFullName,
    commitSha: expectedHeadSha,
  };
  expect(observation.terminalOutcome).toEqual({
    status: "completed",
    message: null,
  });
  expect(observation.refresh).toEqual(expect.objectContaining({
    status: "completed",
    qualityStatus: "verified",
    error: null,
  }));
  expect(observation.repositoryImport).toEqual(expect.objectContaining({
    status: "evidence_ready",
    error: null,
    refreshRunId: observation.refresh.id,
  }));
  expect(observation.repositoryImport.requestId).toEqual(expect.any(String));
  expect(observation.repositoryImport.workflowId).toEqual(expect.any(String));
  expect(observation.repositoryImport.evidenceCount).toBeGreaterThan(0);
  expect(observation.repository.sourceRevisionSha).toBe(expectedHeadSha);
  expect(observation.repository.repositoryId).toBe(repositoryId);
  expect(observation.repository.fullName).toBe(repositoryFullName);
  expect(observation.repository.targetHeads).toEqual([expectedHead]);
  expect(observation.repository.completedHeads).toEqual([expectedHead]);
  expect(observation.snapshots.filter((snapshot) =>
    snapshot.sourceId === observation.repository.sourceId &&
    snapshot.commitSha === expectedHeadSha &&
    snapshot.inventoryComplete &&
    snapshot.analysisComplete &&
    snapshot.coverageComplete
  )).toHaveLength(1);
  expect(observation.automation.status).toBe("completed");
  expect(observation.automation.failedGenerationRunIds).toEqual([]);
  expect(observation.automation.semanticExtractionRunIds.length)
    .toBeGreaterThan(0);
  expect(observation.automation.failedSemanticExtractionRunIds).toEqual([]);
  expect(observation.automation.repositorySynthesisMode).toBe("model");
  expect(observation.automation.expectedDeepSynthesisModelId)
    .toBe(expectedDeepSynthesisModelId);
  const capabilitySynthesisRuns = observation.automation.capabilitySynthesisRuns;
  expect(capabilitySynthesisRuns.length).toBeGreaterThan(0);
  expect(capabilitySynthesisRuns.filter((run) => run.status !== "success"))
    .toEqual([]);
  const successfulDeepSynthesisRuns = capabilitySynthesisRuns.filter((run) =>
    run.status === "success" && run.profile === "deep_synthesis"
  );
  expect(successfulDeepSynthesisRuns.length).toBeGreaterThan(0);
  for (const run of successfulDeepSynthesisRuns) {
    expect(run.kind).toBe("capability_synthesis");
    expect(run.role).toBe("provider_call");
    expect(run.provider).toBe(provider);
    expect(run.configuredProvider).toBe(provider);
    expect(run.configuredModelId).toBe(expectedDeepSynthesisModelId);
    expect(run.modelId).toBe(expectedDeepSynthesisModelId);
    expect(run.requestIds.length).toBeGreaterThan(0);
    expect(run.tokenUsagePresent).toBe(true);
    expect(run.tokenUsage).not.toBeNull();
    expect(run.estimatedCostUsd).toEqual(expect.any(Number));
    expect(run.usageComplete).toBe(true);
    expect(run.auditAttemptCount).toBeGreaterThan(0);
    expect(run.providerAttemptCount).toBeGreaterThan(0);
    expect(run.failedProviderAttempts).toBe(0);
    expect(run.unknownUsageAttempts).toBe(0);
    expect(run.auditEvidenceTruncated).toBe(false);
  }
  const lineageGenerationRuns = observation.automation.generationRuns;
  expect(sorted(lineageGenerationRuns.map((run) => run.id))).toEqual(
    sorted(observation.currentLineage.generationRunIds),
  );
  const providerGenerationRuns = lineageGenerationRuns.filter((run) =>
    run.role === "provider_call"
  );
  expect(providerGenerationRuns.length).toBeGreaterThan(0);
  for (const run of providerGenerationRuns) {
    expect(run.status).toBe("success");
    expect(run.provider).toBe(provider);
    expect(run.configuredProvider).toBe(provider);
    expect(run.configuredModelId).toBe(run.modelId);
    expect(run.requestIds.length).toBeGreaterThan(0);
    expect(run.tokenUsage).not.toBeNull();
    expect(run.tokenUsagePresent).toBe(true);
    expect(run.estimatedCostUsd).toEqual(expect.any(Number));
    expect(run.usageComplete).toBe(true);
    expect(run.auditAttemptCount).toBeGreaterThan(0);
    expect(run.providerAttemptCount).toBeGreaterThan(0);
    expect(run.failedProviderAttempts).toBe(0);
    expect(run.unknownUsageAttempts).toBe(0);
    expect(run.auditEvidenceTruncated).toBe(false);
  }
  expect(sorted(lineageGenerationRuns.filter((run) =>
    run.kind === "semantic_extraction"
  ).map((run) => run.id))).toEqual(
    sorted(observation.automation.semanticExtractionRunIds),
  );
  expect(observation.automation.observedProviders).toEqual([provider]);
  expect(observation.automation.observedModelIds.length).toBeGreaterThan(0);
  expect(observation.timingsMs.actionAcknowledged).toBeLessThanOrEqual(5_000);
  expect(observation.timingsMs.sourceReserved).toBeLessThanOrEqual(5_000);
  expect(observation.timingsMs.sourceReserved)
    .toBeLessThanOrEqual(observation.timingsMs.evidenceReady);
  expect(observation.timingsMs.evidenceReady)
    .toBeLessThanOrEqual(observation.timingsMs.refreshTerminal);
  expect(observation.timingsMs.evidenceReady)
    .toBeLessThanOrEqual(observation.sloMs.evidenceReady);
  expect(observation.timingsMs.refreshTerminal)
    .toBeLessThanOrEqual(observation.sloMs.refreshTerminal);
  expect(observation.timingsMs.automaticHighlightsTerminal)
    .toBeLessThanOrEqual(observation.sloMs.automaticHighlightsTerminal);
  expect(observation.timingsMs.total)
    .toBeLessThanOrEqual(observation.sloMs.total);
  expect(observation.automaticHighlights.length).toBeGreaterThan(0);
  const baselineById = new Map(
    observation.baselineAutomaticHighlights.map((highlight) => [
      highlight.id,
      highlight,
    ]),
  );
  if (observation.scenarioId === "existing_attach") {
    expect(observation.baselineAutomaticHighlights.length).toBeGreaterThan(0);
    expect(observation.initialState.highlightCount)
      .toBe(observation.baselineAutomaticHighlights.length);
    for (const baseline of observation.baselineAutomaticHighlights) {
      expect(baseline.managedBy).toBe("manual_evidence_highlight_workflow");
      expect(baseline.originatingAgentRunId).toEqual(expect.any(String));
      expect(baseline.reviewState).toBe("pending_review");
      expect(baseline.evidence.length).toBeGreaterThan(0);
      expect(baseline.evidence.every((entry) =>
        entry.sourceType === "manual_note"
      )).toBe(true);
      expect(baseline.validatedThroughSha).toBeNull();
      expect(baseline.validationHeads).toEqual([]);
      expect(observation.automaticHighlights.some((highlight) =>
        highlight.id === baseline.id
      )).toBe(true);
    }
  } else {
    expect(observation.baselineAutomaticHighlights).toEqual([]);
  }
  const currentHeadHighlights = observation.automaticHighlights.filter(
    (highlight) =>
      highlight.lifecycleStatus === "active" &&
      highlight.verificationStatus === "approved" &&
      highlight.reviewState === "pending_review" &&
      highlight.approvalSource === "automation" &&
      highlight.validatedThroughSha === expectedHeadSha &&
      JSON.stringify(highlight.validationHeads) === JSON.stringify([expectedHead]) &&
      highlight.evidence.some((entry) =>
        entry.sourceId === observation.repository.sourceId &&
        entry.sourceType === "github_repo"
      ),
  );
  expect(currentHeadHighlights.length).toBeGreaterThan(0);
  for (const highlight of observation.automaticHighlights) {
    const baseline = baselineById.get(highlight.id);
    if (baseline) {
      expect(highlight.managedBy).toBe("manual_evidence_highlight_workflow");
      expect(highlight.originatingAgentRunId)
        .toBe(baseline.originatingAgentRunId);
      continue;
    }
    expect(highlight.lifecycleStatus).toBe("active");
    expect(highlight.verificationStatus).toBe("approved");
    expect(highlight.reviewState).toBe("pending_review");
    expect(highlight.approvalSource).toBe("automation");
    expect(highlight.managedBy).toBe("repository_knowledge_sync");
    expect(highlight.originatingAgentRunId).toBeNull();
    expect(highlight.evidenceItemIds.length).toBeGreaterThan(0);
    expect(highlight.validatedThroughSha).toBe(expectedHeadSha);
    expect(highlight.validationHeads).toEqual([expectedHead]);
  }
  const normalizedTexts = observation.automaticHighlights
    .filter((highlight) => ["active", "needs_validation", "quarantined"].includes(
      highlight.lifecycleStatus,
    ))
    .map((highlight) =>
      normalizedHighlightText(highlight.text)
    );
  expect(normalizedTexts.every(Boolean)).toBe(true);
  expect(new Set(normalizedTexts).size).toBe(normalizedTexts.length);
}

test.describe("live Work Item lifecycle release gate", () => {
  test.skip(
    !liveEnabled || configurationErrors.length > 0,
    `Set WORKBASE_LIFECYCLE_LIVE_E2E=1 and configure: ${configurationErrors.join(", ") || "all required live values"}.`,
  );

  test.beforeAll(async () => {
    if (repositorySynthesisMode !== "model") {
      throw new Error(
        "Representative lifecycle runs require WORKBASE_REPOSITORY_SYNTHESIS_MODE=model.",
      );
    }
    if (!expectedDeepSynthesisModelId) {
      throw new Error(
        "Representative lifecycle runs require an explicit deep-synthesis model ID.",
      );
    }
    if (!expectedDraftingModelId || !expectedVerificationModelId) {
      throw new Error(
        "Representative manual lifecycle runs require explicit drafting and verification model IDs.",
      );
    }
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    await pool.query("SELECT 1");
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  test("manual-only create reserves durable work and reaches a grounded pending-review Highlight", async ({ page }) => {
    const title = `${titlePrefix} manual only create`;
    const observation = await createManualAndObserve(page, title);

    try {
      assertManualObservation(observation);
    } finally {
      if (!retainCreatedWorkItems) {
        await deleteCreatedWorkItem(
          page,
          observation.currentLineage.workItemId,
          title,
        );
      }
    }
  });

  test("empty create plus repository attach reaches current-head Highlights", async ({ page }) => {
    const title = `${titlePrefix} empty create`;
    const observation = await createAndObserve(
      page,
      "empty_create_attach",
      title,
    );

    try {
      assertCoreObservation(observation);
    } finally {
      if (!retainCreatedWorkItems) {
        await deleteCreatedWorkItem(
          page,
          observation.currentLineage.workItemId,
          title,
        );
      }
    }
  });

  test("an existing Work Item with manual Highlights can attach the repository", async ({ page }) => {
    const title = `${titlePrefix} existing attach`;
    const manualBaseline = await createManualAndObserve(page, title, false);
    assertManualObservation(manualBaseline);
    const workItem = await findWorkItemById(
      manualBaseline.currentLineage.workItemId,
    );
    expect(workItem).not.toBeNull();
    const {
      initialState,
      baselineAutomaticHighlights,
    } = await captureInitialAttachState(workItem.id);
    expect(initialState.sourceCount).toBe(0);
    expect(initialState.highlightCount).toBeGreaterThan(0);
    expect(baselineAutomaticHighlights.length).toBe(initialState.highlightCount);
    const form = await prepareAttachRepository(page, workItem.id);
    const startedAt = Date.now();
    const submitPromise = submitAttachRepository(page, workItem.id, form);
    const lifecyclePromise = observeLifecycle(workItem.id, startedAt);
    await submitPromise;
    const actionAcknowledgedMs = elapsed(startedAt);
    const lifecycle = await lifecyclePromise;
    const observation = await buildObservation({
      scenarioId: "existing_attach",
      initialState,
      priorLineage: null,
      priorDeleted: false,
      baselineAutomaticHighlights,
      startedAt,
      actionAcknowledgedMs,
      lifecycle,
    });
    await appendObservation(observation);

    try {
      assertCoreObservation(observation);
    } finally {
      if (!retainCreatedWorkItems) {
        await deleteCreatedWorkItem(page, workItem.id, title);
      }
    }
  });

  test("a completed item can be deleted and the same repository re-added without lineage leakage", async ({ page }) => {
    const priorTitle = `${titlePrefix} prior completed`;
    const prior = await createAndObserve(
      page,
      "empty_create_attach",
      priorTitle,
    );
    const priorCompletedHead = prior.repository.completedHeads.length === 1
      ? prior.repository.completedHeads[0].commitSha
      : null;
    const priorLineage = {
      ...await captureLineage(prior.currentLineage.workItemId),
      generationRuns: prior.automation.generationRuns,
      completedBeforeDeletion:
        prior.terminalOutcome.status === "completed" &&
        prior.refresh.status === "completed" &&
        prior.refresh.qualityStatus === "verified",
      completedHeadSha: priorCompletedHead,
      automaticHighlightCount: prior.automaticHighlights.length,
    };
    await deleteCreatedWorkItem(
      page,
      prior.currentLineage.workItemId,
      priorTitle,
    );
    expect(await findWorkItemById(prior.currentLineage.workItemId)).toBeNull();

    // The temporary first observation is not one of the final three gate
    // observations; it exists only to establish a real completed lineage.
    await removeObservation(prior.currentLineage.workItemId);
    const replacementTitle = `${titlePrefix} replacement`;
    const replacement = await createAndObserve(
      page,
      "completed_delete_readd_same_repo",
      replacementTitle,
      priorLineage,
    );

    try {
      assertCoreObservation(replacement);
      expect(replacement.priorLineage.completedBeforeDeletion).toBe(true);
      expect(replacement.priorLineage.completedHeadSha).toBe(expectedHeadSha);
      expect(replacement.priorLineage.automaticHighlightCount)
        .toBeGreaterThan(0);
      expect(replacement.priorLineage.deleted).toBe(true);
      expect(sorted(replacement.priorLineage.generationRuns.map((run) => run.id)))
        .toEqual(sorted(replacement.priorLineage.generationRunIds));
      expect(replacement.priorLineage.generationRuns.filter((run) =>
        run.role === "provider_call"
      ).every((run) =>
        run.usageComplete === true && run.estimatedCostUsd !== null
      )).toBe(true);
      expect(replacement.leakedPriorEntityIds).toEqual([]);
      expect(replacement.currentLineage.workItemId)
        .not.toBe(priorLineage.workItemId);
    } finally {
      if (!retainCreatedWorkItems) {
        await deleteCreatedWorkItem(
          page,
          replacement.currentLineage.workItemId,
          replacementTitle,
        );
      }
    }
  });
});
