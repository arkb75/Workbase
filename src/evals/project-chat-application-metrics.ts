import type { ProjectChatApplicationMetrics } from "@/src/evals/project-chat-application-runner";
import {
  collectModelTokenUsage,
  collectReportedModelCostUsd,
  collectUnknownModelUsageAttempts,
  countCostedModelProviderAttempts,
  countModelProviderAttempts,
  resolveModelCostUsd,
  type ModelTokenUsageTotals,
} from "@/src/services/model-usage-service";

export interface ApplicationModelEvent {
  id?: string;
  message?: string | null;
  payload: unknown;
}

export interface ApplicationGenerationRun {
  id: string;
  status: string;
  provider: string;
  modelId: string;
  idempotencyKey: string | null;
  tokenUsage: unknown;
  estimatedCostUsd: number | null;
  resultRefs: unknown;
  updatedAt: Date;
}

type ApplicationModelMetrics = Pick<
  ProjectChatApplicationMetrics,
  | "modelCalls"
  | "totalTokens"
  | "estimatedCostUsd"
  | "usageComplete"
  | "modelAttribution"
>;

interface MeasuredUsageUnit {
  identity: string;
  provider: string;
  configuredModelIds: string[];
  actualModelIds: string[];
  providers: string[];
  routedProviders: string[];
  requestIds: string[];
  failedModelIds: string[];
  failedProviderAttempts: number;
  fallbackUsed: boolean;
  modelCalls: number;
  unknownUsageAttempts: number;
  usage: ModelTokenUsageTotals;
  costUsd: number | null;
  authoritativeCostComplete: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? Math.floor(value)
    : null;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

function isModelProvider(provider: string) {
  return !["", "mock", "workbase", "deterministic"].includes(
    provider.trim().toLowerCase(),
  );
}

function requestIdentity(value: unknown) {
  const requestIds = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (
      !current ||
      typeof current !== "object" ||
      depth > 7 ||
      seen.has(current)
    ) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    for (const [key, entry] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (
        key === "requestId" &&
        typeof entry === "string" &&
        entry.trim()
      ) {
        requestIds.add(entry.trim());
      } else if (key === "requestIds" && Array.isArray(entry)) {
        entry.forEach((requestId) => {
          if (typeof requestId === "string" && requestId.trim()) {
            requestIds.add(requestId.trim());
          }
        });
      } else {
        visit(entry, depth + 1);
      }
    }
  };
  visit(value, 0);
  return requestIds.size
    ? `requests:${Array.from(requestIds).sort().join("|")}`
    : null;
}

function collectRawAttribution(value: unknown) {
  const providers = new Set<string>();
  const actualModelIds = new Set<string>();
  const routedProviders = new Set<string>();
  const requestIds = new Set<string>();
  const failedModelIds = new Set<string>();
  let failedProviderAttempts = 0;
  const seen = new WeakSet<object>();
  const addStrings = (target: Set<string>, current: unknown) => {
    const values = Array.isArray(current) ? current : [current];
    values.forEach((entry) => {
      if (typeof entry === "string" && entry.trim()) {
        target.add(entry.trim());
      }
    });
  };
  const visit = (current: unknown, depth: number, failed: boolean) => {
    if (
      !current ||
      typeof current !== "object" ||
      depth > 8 ||
      seen.has(current)
    ) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1, failed));
      return;
    }
    for (const [key, entry] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (key === "failedAttempts" || key === "failedProviderAttempts") {
        if (Array.isArray(entry)) {
          failedProviderAttempts += entry.length;
          entry.forEach((attempt) => visit(attempt, depth + 1, true));
        }
        continue;
      }
      if (key === "provider") addStrings(providers, entry);
      if (key === "modelId") {
        addStrings(failed ? failedModelIds : actualModelIds, entry);
      }
      if (key === "routedProvider" || key === "routedProviders") {
        addStrings(routedProviders, entry);
      }
      if (key === "requestId" || key === "requestIds") {
        addStrings(requestIds, entry);
      }
      visit(entry, depth + 1, failed);
    }
  };
  visit(value, 0, false);
  return {
    providers: Array.from(providers),
    actualModelIds: Array.from(actualModelIds),
    routedProviders: Array.from(routedProviders),
    requestIds: Array.from(requestIds),
    failedModelIds: Array.from(failedModelIds),
    failedProviderAttempts,
  };
}

function measureUsageUnit(input: {
  identity: string;
  provider: string;
  modelId: string;
  configuredModelId?: string | null;
  rawUsage: unknown;
  attributionMetadata?: unknown;
  invocationExpected: boolean;
  terminalFailure?: boolean;
  explicitFallbackUsed?: boolean;
  attemptCount?: number | null;
  unknownUsageAttempts?: number | null;
  knownCostUsd?: number | null;
  usageComplete?: boolean | null;
}): MeasuredUsageUnit {
  const meteredProvider = isModelProvider(input.provider);
  const rawAttemptCount = countModelProviderAttempts(input.rawUsage);
  const rawUnknownUsageAttempts = collectUnknownModelUsageAttempts(
    input.rawUsage,
  );
  let modelCalls = Math.max(
    input.attemptCount ?? 0,
    rawAttemptCount,
    input.unknownUsageAttempts ?? 0,
    rawUnknownUsageAttempts,
  );
  let unknownUsageAttempts = Math.max(
    input.unknownUsageAttempts ?? 0,
    rawUnknownUsageAttempts,
  );
  if (meteredProvider && input.invocationExpected && modelCalls === 0) {
    modelCalls = 1;
    unknownUsageAttempts = Math.max(unknownUsageAttempts, 1);
  }
  const usage = collectModelTokenUsage(input.rawUsage);
  const reportedCostUsd =
    input.knownCostUsd ??
    collectReportedModelCostUsd(input.rawUsage) ??
    resolveModelCostUsd({
      provider: input.provider,
      modelId: input.modelId,
      usage,
      rawUsage: input.rawUsage,
    });
  const costedAttempts = countCostedModelProviderAttempts(input.rawUsage);
  const openRouterCostComplete =
    input.provider.toLowerCase() !== "openrouter" ||
    modelCalls === 0 ||
    (
      reportedCostUsd != null &&
      (
        input.usageComplete === true ||
        costedAttempts >= modelCalls
      )
    );
  const rawAttribution = collectRawAttribution(input.rawUsage);
  const metadataAttribution = collectRawAttribution(input.attributionMetadata);
  const configuredModelId =
    input.configuredModelId?.trim() || input.modelId.trim();
  const actualModelIds = new Set([
    ...(modelCalls > 0 && input.modelId.trim() ? [input.modelId.trim()] : []),
    ...rawAttribution.actualModelIds,
    ...metadataAttribution.actualModelIds,
  ]);
  const failedModelIds = new Set([
    ...rawAttribution.failedModelIds,
    ...metadataAttribution.failedModelIds,
  ]);
  const fallbackUsed =
    input.explicitFallbackUsed === true ||
    (
      modelCalls > 0 &&
      configuredModelId !== "" &&
      input.modelId.trim() !== "" &&
      configuredModelId !== input.modelId.trim()
    ) ||
    Array.from(failedModelIds).some(
      (modelId) => !actualModelIds.has(modelId),
    );
  return {
    identity: input.identity,
    provider: input.provider,
    configuredModelIds:
      modelCalls > 0 && configuredModelId ? [configuredModelId] : [],
    actualModelIds: Array.from(actualModelIds),
    providers: Array.from(new Set([
      ...(modelCalls > 0 && input.provider.trim() ? [input.provider.trim()] : []),
      ...rawAttribution.providers,
      ...metadataAttribution.providers,
    ])),
    routedProviders: Array.from(new Set([
      ...rawAttribution.routedProviders,
      ...metadataAttribution.routedProviders,
    ])),
    requestIds: Array.from(new Set([
      ...rawAttribution.requestIds,
      ...metadataAttribution.requestIds,
    ])),
    failedModelIds: Array.from(failedModelIds),
    failedProviderAttempts: Math.max(
      rawAttribution.failedProviderAttempts,
      metadataAttribution.failedProviderAttempts,
      unknownUsageAttempts,
      input.terminalFailure ? modelCalls : 0,
    ),
    fallbackUsed,
    modelCalls,
    unknownUsageAttempts,
    usage,
    costUsd: reportedCostUsd,
    authoritativeCostComplete:
      input.usageComplete !== false &&
      unknownUsageAttempts === 0 &&
      openRouterCostComplete,
  };
}

function eventKind(event: ApplicationModelEvent) {
  const payload = record(event.payload);
  const explicit = payload.modelEvent;
  if (
    explicit === "model_call_started" ||
    explicit === "model_call_completed" ||
    explicit === "model_call_failed"
  ) {
    return explicit;
  }
  if ("stopReason" in payload || "requestId" in payload) {
    return "model_call_completed" as const;
  }
  if (
    "requestIds" in payload ||
    "providerStatus" in payload ||
    "providerCode" in payload
  ) {
    return "model_call_failed" as const;
  }
  if (
    event.message === "Reviewing the available project evidence." &&
    "iteration" in payload
  ) {
    return "model_call_started" as const;
  }
  return null;
}

function eventIteration(event: ApplicationModelEvent) {
  return nonNegativeInteger(record(event.payload).iteration);
}

function eventUsageUnits(input: {
  events: ApplicationModelEvent[];
  provider: string;
  modelId: string;
}) {
  const terminalIterations = new Set<number>();
  const units: MeasuredUsageUnit[] = [];
  for (const [index, event] of input.events.entries()) {
    const kind = eventKind(event);
    if (kind !== "model_call_completed" && kind !== "model_call_failed") {
      continue;
    }
    const payload = record(event.payload);
    const iteration = eventIteration(event);
    if (iteration != null) terminalIterations.add(iteration);
    const rawUsage = payload.usage;
    const provider =
      typeof payload.provider === "string"
        ? payload.provider
        : input.provider;
    const modelId =
      typeof payload.modelId === "string"
        ? payload.modelId
        : input.modelId;
    units.push(measureUsageUnit({
      identity:
        requestIdentity(payload) ??
        `event:${event.id ?? index}:${iteration ?? "unknown"}:${kind}`,
      provider,
      modelId,
      configuredModelId: input.modelId,
      rawUsage,
      attributionMetadata: payload,
      invocationExpected: true,
      terminalFailure: kind === "model_call_failed",
    }));
  }
  for (const [index, event] of input.events.entries()) {
    if (eventKind(event) !== "model_call_started") continue;
    const iteration = eventIteration(event);
    if (iteration != null && terminalIterations.has(iteration)) continue;
    units.push(measureUsageUnit({
      identity: `unmetered-event-start:${event.id ?? index}:${iteration ?? "unknown"}`,
      provider: input.provider,
      modelId: input.modelId,
      configuredModelId: input.modelId,
      rawUsage: null,
      attributionMetadata: event.payload,
      invocationExpected: true,
      terminalFailure: true,
    }));
  }
  return units;
}

function dossierUsageUnits(input: {
  modelUsage: unknown;
  provider: string;
  modelId: string;
}) {
  if (!Array.isArray(input.modelUsage)) return [];
  return input.modelUsage.map((entry, index) => {
    const wrapper = record(entry);
    const rawUsage = "usage" in wrapper ? wrapper.usage : entry;
    const attribution = collectRawAttribution(entry);
    const configuredModelId =
      typeof wrapper.configuredModelId === "string"
        ? wrapper.configuredModelId
        : input.modelId;
    const modelId =
      attribution.actualModelIds[0] ??
      configuredModelId;
    return measureUsageUnit({
      identity:
        requestIdentity(entry) ??
        `research-model-usage:${index}:${typeof wrapper.phase === "string" ? wrapper.phase : "unknown"}`,
      provider:
        typeof wrapper.provider === "string"
          ? wrapper.provider
          : input.provider,
      modelId,
      configuredModelId,
      rawUsage,
      attributionMetadata: entry,
      invocationExpected:
        typeof wrapper.modelInvoked === "boolean"
          ? wrapper.modelInvoked
          : rawUsage != null,
    });
  });
}

function generationUsageUnits(generationRuns: ApplicationGenerationRun[]) {
  const seenGenerationRunIds = new Set<string>();
  return generationRuns.flatMap((run) => {
    if (seenGenerationRunIds.has(run.id)) return [];
    seenGenerationRunIds.add(run.id);
    const refs = record(run.resultRefs);
    const attemptCount = nonNegativeInteger(refs.auditAttemptCount);
    const admissionFailure =
      refs.admissionFailure === true && attemptCount === 0;
    const knownCostUsd =
      nonNegativeNumber(run.estimatedCostUsd) ??
      nonNegativeNumber(refs.knownEstimatedCostUsd);
    return [measureUsageUnit({
      identity:
        requestIdentity({ tokenUsage: run.tokenUsage, resultRefs: run.resultRefs }) ??
        `generation-run:${run.id}`,
      provider: run.provider,
      modelId: run.modelId,
      configuredModelId:
        typeof refs.configuredModelId === "string"
          ? refs.configuredModelId
          : run.modelId,
      rawUsage: run.tokenUsage,
      attributionMetadata: run.resultRefs,
      invocationExpected: isModelProvider(run.provider) && !admissionFailure,
      terminalFailure:
        run.status === "provider_error" && !admissionFailure,
      explicitFallbackUsed: refs.fallbackUsed === true,
      attemptCount,
      unknownUsageAttempts: nonNegativeInteger(refs.unknownUsageAttempts),
      knownCostUsd,
      usageComplete:
        typeof refs.usageComplete === "boolean"
          ? refs.usageComplete
          : null,
    })];
  });
}

function usageUnitScore(unit: MeasuredUsageUnit) {
  return (
    (unit.authoritativeCostComplete ? 1_000_000 : 0) +
    (unit.usage.totalTokens > 0 ? 100_000 : 0) +
    (unit.costUsd != null ? 10_000 : 0) +
    unit.modelCalls * 100 -
    unit.unknownUsageAttempts
  );
}

function deduplicateUsageUnits(units: MeasuredUsageUnit[]) {
  const byIdentity = new Map<string, MeasuredUsageUnit>();
  for (const unit of units) {
    const existing = byIdentity.get(unit.identity);
    if (!existing || usageUnitScore(unit) > usageUnitScore(existing)) {
      byIdentity.set(unit.identity, unit);
    }
  }
  return Array.from(byIdentity.values());
}

export function collectReferencedGenerationRunIds(...values: unknown[]) {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown, collectStrings: boolean, depth: number) => {
    if (typeof current === "string") {
      if (collectStrings && current.trim()) ids.add(current.trim());
      return;
    }
    if (
      !current ||
      typeof current !== "object" ||
      depth > 8 ||
      seen.has(current)
    ) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, collectStrings, depth + 1));
      return;
    }
    for (const [key, entry] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (key === "generationRunId") {
        visit(entry, true, depth + 1);
      } else if (key === "generationRunIds") {
        visit(entry, true, depth + 1);
      } else {
        visit(entry, collectStrings, depth + 1);
      }
    }
  };
  values.forEach((value) => visit(value, false, 0));
  return ids;
}

export function selectScenarioGenerationRuns(input: {
  generationRuns: ApplicationGenerationRun[];
  runId: string;
  refreshRunId?: string | null;
  referencedGenerationRunIds?: ReadonlySet<string>;
  startedAt: Date;
  finishedAt: Date;
}) {
  const referencedIds = input.referencedGenerationRunIds ?? new Set<string>();
  return input.generationRuns.filter((run) => {
    if (
      run.updatedAt < input.startedAt ||
      run.updatedAt > input.finishedAt
    ) {
      return false;
    }
    if (referencedIds.has(run.id)) return true;
    const refs = record(run.resultRefs);
    if (refs.agentRunId === input.runId) return true;
    if (
      input.refreshRunId &&
      refs.refreshRunId === input.refreshRunId
    ) {
      return true;
    }
    if (run.idempotencyKey?.includes(input.runId)) return true;
    return Boolean(
      input.refreshRunId &&
      run.idempotencyKey?.includes(input.refreshRunId),
    );
  });
}

export function calculateApplicationModelMetrics(input: {
  provider: string;
  modelId: string;
  events: ApplicationModelEvent[];
  dossierModelUsage: unknown;
  generationRuns: ApplicationGenerationRun[];
}): ApplicationModelMetrics {
  const units = deduplicateUsageUnits([
    ...generationUsageUnits(input.generationRuns),
    ...eventUsageUnits(input),
    ...dossierUsageUnits({
      modelUsage: input.dossierModelUsage,
      provider: input.provider,
      modelId: input.modelId,
    }),
  ]);
  const totals = units.reduce(
    (aggregate, unit) => ({
      modelCalls: aggregate.modelCalls + unit.modelCalls,
      totalTokens: aggregate.totalTokens + unit.usage.totalTokens,
      estimatedCostUsd:
        aggregate.estimatedCostUsd + (unit.costUsd ?? 0),
      usageComplete:
        aggregate.usageComplete &&
        unit.authoritativeCostComplete,
    }),
    {
      modelCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
    },
  );
  const modelAttribution = {
    providers: Array.from(new Set(
      units.flatMap((unit) => unit.providers),
    )).sort(),
    configuredModelIds: Array.from(new Set(
      units.flatMap((unit) => unit.configuredModelIds),
    )).sort(),
    actualModelIds: Array.from(new Set(
      units.flatMap((unit) => unit.actualModelIds),
    )).sort(),
    routedProviders: Array.from(new Set(
      units.flatMap((unit) => unit.routedProviders),
    )).sort(),
    requestIds: Array.from(new Set(
      units.flatMap((unit) => unit.requestIds),
    )).sort(),
    failedModelIds: Array.from(new Set(
      units.flatMap((unit) => unit.failedModelIds),
    )).sort(),
    providerAttempts: totals.modelCalls,
    failedProviderAttempts: units.reduce(
      (total, unit) => total + unit.failedProviderAttempts,
      0,
    ),
    fallbackUsed: units.some((unit) => unit.fallbackUsed),
  };
  return {
    ...totals,
    estimatedCostUsd: Number(totals.estimatedCostUsd.toFixed(6)),
    modelAttribution,
  };
}
