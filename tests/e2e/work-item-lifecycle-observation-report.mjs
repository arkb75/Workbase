import { createHash } from "node:crypto";

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

/**
 * Crosses the live-observation privacy boundary. Durable Evidence content is
 * inspected in process, but only its digest is eligible for serialization.
 */
export function normalizeLifecycleHighlightEvidence(value) {
  const item = objectRecord(value);
  if (
    typeof item.evidenceItemId !== "string" ||
    typeof item.sourceId !== "string" ||
    typeof item.sourceType !== "string"
  ) {
    return null;
  }
  return {
    evidenceItemId: item.evidenceItemId,
    sourceId: item.sourceId,
    sourceType: item.sourceType,
    contentSha256:
      item.sourceType === "manual_note" && typeof item.content === "string"
        ? createHash("sha256").update(item.content, "utf8").digest("hex")
        : null,
  };
}

function observationsFromReport(report) {
  return Array.isArray(report.observations) ? report.observations : [];
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

const usageKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
];

function providerAttemptCountFromAuditEvidence(value) {
  let total = 0;
  const visited = new WeakSet();
  const visit = (current, depth) => {
    if (
      !current || typeof current !== "object" || depth > 8 ||
      visited.has(current)
    ) {
      return;
    }
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = objectRecord(current);
    const explicit = optionalNonNegativeInteger(record.providerAttemptCount);
    if ((explicit ?? 0) > 0) {
      total += explicit;
      return;
    }
    if (usageKeys.some((key) => typeof record[key] === "number")) {
      total += 1;
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

function unknownUsageAttemptCountFromAuditEvidence(value) {
  let total = 0;
  const visited = new WeakSet();
  const visit = (current, depth) => {
    if (
      !current || typeof current !== "object" || depth > 8 ||
      visited.has(current)
    ) {
      return;
    }
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = objectRecord(current);
    const explicit = optionalNonNegativeInteger(record.unknownUsageAttempts);
    if ((explicit ?? 0) > 0) {
      total += explicit;
      return;
    }
    Object.entries(record).forEach(([key, entry]) => {
      if (key !== "unknownUsageAttempts") visit(entry, depth + 1);
    });
  };
  visit(value, 0);
  return total;
}

function reportedCostEntryCount(value) {
  let total = 0;
  const visited = new WeakSet();
  const visit = (current, depth) => {
    if (
      !current || typeof current !== "object" || depth > 8 ||
      visited.has(current)
    ) {
      return;
    }
    visited.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = objectRecord(current);
    const cost = typeof record.cost === "number"
      ? record.cost
      : typeof record.costUsd === "number"
        ? record.costUsd
        : null;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      total += 1;
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
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

function auditEvidenceWasTruncated(...values) {
  const visited = new WeakSet();
  let truncated = false;
  const visit = (value, depth) => {
    if (
      truncated || !value || typeof value !== "object" || depth > 8 ||
      visited.has(value)
    ) {
      return;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = objectRecord(value);
    if (record.auditEvidenceTruncated === true) {
      truncated = true;
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  values.forEach((value) => visit(value, 0));
  return truncated;
}

/**
 * Converts a raw durable GenerationRun row to the lifecycle audit contract.
 *
 * Some provider paths persist their total provider-attempt count in tokenUsage
 * rather than duplicating it in resultRefs. Verification aggregates are local
 * lineage nodes, so they deliberately carry no provider usage or cost.
 */
export function normalizeLifecycleGenerationRun(run, options) {
  const refs = objectRecord(run.resultRefs);
  const verificationAggregate = refs.aggregate === true;
  const tokenUsage = run.tokenUsage ?? null;
  const tokenUsagePresent = tokenUsage !== null;
  const estimatedCostUsd =
    typeof run.estimatedCostUsd === "number" &&
      Number.isFinite(run.estimatedCostUsd) &&
      run.estimatedCostUsd >= 0
      ? run.estimatedCostUsd
      : null;
  const requestIds = requestIdsFromAuditEvidence(
    run.resultRefs,
    run.inputSummary,
    tokenUsage,
  );
  const evidenceProviderAttemptCount =
    providerAttemptCountFromAuditEvidence(tokenUsage);
  const refsProviderAttemptCount = optionalNonNegativeInteger(
    refs.providerAttemptCount,
  );
  const auditAttemptCount = optionalNonNegativeInteger(refs.auditAttemptCount) ??
    (evidenceProviderAttemptCount > 0
      ? evidenceProviderAttemptCount
      : verificationAggregate
        ? 0
        : null);
  const providerAttemptCount = Math.max(
    evidenceProviderAttemptCount,
    refsProviderAttemptCount ?? 0,
    verificationAggregate ? 0 : auditAttemptCount ?? 0,
  );
  const failedProviderAttempts = Math.max(
    failedProviderAttemptCount(refs.failedProviderAttempts) ?? 0,
    failedAttemptsFromAuditEvidence(run.inputSummary, tokenUsage),
  );
  const unknownUsageAttempts = Math.max(
    optionalNonNegativeInteger(refs.unknownUsageAttempts) ?? 0,
    unknownUsageAttemptCountFromAuditEvidence(tokenUsage),
  );
  const usageComplete = typeof refs.usageComplete === "boolean"
    ? refs.usageComplete
    : null;
  const aggregateEvidenceIsComplete = verificationAggregate &&
    run.provider?.toLowerCase() === "deterministic" &&
    run.modelId === "highlight-verification-aggregate-v1" &&
    !tokenUsagePresent &&
    estimatedCostUsd === null &&
    usageComplete === true &&
    auditAttemptCount === 0 &&
    providerAttemptCount === 0 &&
    failedProviderAttempts === 0 &&
    unknownUsageAttempts === 0;
  const providerEvidenceIsComplete = !verificationAggregate &&
    tokenUsagePresent &&
    estimatedCostUsd !== null &&
    usageComplete === true &&
    (auditAttemptCount ?? 0) > 0 &&
    providerAttemptCount === auditAttemptCount &&
    failedProviderAttempts === 0 &&
    unknownUsageAttempts === 0 &&
    requestIds.length > 0 &&
    (
      run.provider?.toLowerCase() !== "openrouter" ||
      reportedCostEntryCount(tokenUsage) >= providerAttemptCount
    );
  const explicitlyTruncated = auditEvidenceWasTruncated(
    run.resultRefs,
    tokenUsage,
  );
  const auditEvidenceTruncated = explicitlyTruncated
    ? true
    : typeof refs.auditEvidenceTruncated === "boolean"
      ? refs.auditEvidenceTruncated
      : aggregateEvidenceIsComplete || providerEvidenceIsComplete
        ? false
        : null;

  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    provider: run.provider,
    configuredProvider: optionalString(refs.configuredProvider) ?? (
      verificationAggregate ? null : options.provider
    ),
    modelId: run.modelId,
    profile: optionalString(refs.profile),
    configuredModelId: optionalString(refs.configuredModelId),
    requestIds,
    tokenUsage,
    tokenUsagePresent,
    estimatedCostUsd,
    usageComplete,
    auditAttemptCount,
    providerAttemptCount,
    failedProviderAttempts,
    unknownUsageAttempts,
    auditEvidenceTruncated,
    agentRunId: optionalString(refs.agentRunId),
    role: verificationAggregate
      ? "verification_aggregate"
      : "provider_call",
    authoritativeGenerationRunId:
      optionalString(refs.authoritativeGenerationRunId),
    providerBatchGenerationRunIds: Array.isArray(
        refs.providerBatchGenerationRunIds,
      )
      ? refs.providerBatchGenerationRunIds.flatMap((value) => {
          const normalized = optionalString(value);
          return normalized == null ? [] : [normalized];
        })
      : [],
  };
}

export function appendLifecycleObservationToReport(input) {
  const prior = objectRecord(input.priorReport);
  if (
    observationsFromReport(prior).length > 0 &&
    prior.schemaVersion !== input.schemaVersion
  ) {
    throw new Error(
      `Lifecycle observation report schema changed from ${prior.schemaVersion ?? "missing"} to ${input.schemaVersion}.`,
    );
  }
  if (
    typeof prior.gitCommit === "string" &&
    prior.gitCommit.toLowerCase() !== input.gitCommit.toLowerCase()
  ) {
    throw new Error(
      `Lifecycle observation report commit changed from ${prior.gitCommit} to ${input.gitCommit}.`,
    );
  }
  return {
    ...prior,
    schemaVersion: input.schemaVersion,
    gitCommit: input.gitCommit.toLowerCase(),
    live: true,
    baseUrl: input.baseUrl,
    observations: [...observationsFromReport(prior), input.observation],
  };
}

export function removeLifecycleObservationFromReport(input) {
  const prior = objectRecord(input.priorReport);
  return {
    ...prior,
    observations: observationsFromReport(prior).filter((observation) => {
      const record = objectRecord(observation);
      const lineage = objectRecord(record.currentLineage);
      return lineage.workItemId !== input.workItemId;
    }),
  };
}
