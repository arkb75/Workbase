import type { JsonValue } from "@/src/domain/types";

export interface ModelTokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens?: number;
}

const usageKeys = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
] as const;

export function countModelUsageEntries(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    if (usageKeys.some((key) => typeof record[key] === "number")) {
      total += 1;
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

/**
 * Counts provider HTTP/model dispatches without confusing a logical wrapper
 * response for a single attempt. New runtimes report providerAttemptCount;
 * legacy leaf usage objects conservatively count as one.
 */
export function countModelProviderAttempts(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    const explicit = finiteTokenCount(record.providerAttemptCount);
    if (explicit > 0) {
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

function finiteTokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function collectModelTokenUsage(value: unknown): ModelTokenUsageTotals {
  const totals: ModelTokenUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    const hasUsage = usageKeys.some((key) => typeof record[key] === "number");
    if (hasUsage) {
      const inputTokens = finiteTokenCount(record.inputTokens);
      const outputTokens = finiteTokenCount(record.outputTokens);
      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
      totals.totalTokens += finiteTokenCount(record.totalTokens) || inputTokens + outputTokens;
      totals.cacheReadInputTokens += finiteTokenCount(record.cacheReadInputTokens);
      totals.cacheWriteInputTokens += finiteTokenCount(record.cacheWriteInputTokens);
      const reasoningTokens = finiteTokenCount(record.reasoningTokens);
      if (reasoningTokens) {
        totals.reasoningTokens =
          (totals.reasoningTokens ?? 0) + reasoningTokens;
      }
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return totals;
}

export function collectUnknownModelUsageAttempts(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    const explicit = finiteTokenCount(record.unknownUsageAttempts);
    if (explicit > 0) {
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

export function collectReportedModelCostUsd(value: unknown) {
  let total = 0;
  let observed = false;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    const reportedCost =
      typeof record.cost === "number"
        ? record.cost
        : typeof record.costUsd === "number"
          ? record.costUsd
          : null;
    if (
      typeof reportedCost === "number" &&
      Number.isFinite(reportedCost) &&
      reportedCost >= 0
    ) {
      total += reportedCost;
      observed = true;
      // A normalized usage object may also contain nested detail fields, but
      // they do not represent additional billable requests.
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return observed ? Number(total.toFixed(8)) : null;
}

export function countReportedModelCostEntries(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    const reportedCost =
      typeof record.cost === "number"
        ? record.cost
        : typeof record.costUsd === "number"
          ? record.costUsd
          : null;
    if (
      typeof reportedCost === "number" &&
      Number.isFinite(reportedCost) &&
      reportedCost >= 0
    ) {
      total += 1;
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

/**
 * Counts provider attempts whose authoritative cost was returned by the
 * provider. Normalized aggregate usage can declare costedAttemptCount; older
 * usage shapes are counted from cost-bearing leaves.
 */
export function countCostedModelProviderAttempts(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    const explicit = finiteTokenCount(record.costedAttemptCount);
    if (explicit > 0) {
      total += explicit;
      return;
    }
    const reportedCost =
      typeof record.cost === "number"
        ? record.cost
        : typeof record.costUsd === "number"
          ? record.costUsd
          : null;
    if (
      typeof reportedCost === "number" &&
      Number.isFinite(reportedCost) &&
      reportedCost >= 0
    ) {
      total += 1;
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

export function addModelTokenUsage(
  ...values: ModelTokenUsageTotals[]
): ModelTokenUsageTotals {
  return values.reduce<ModelTokenUsageTotals>((total, value) => {
    const reasoningTokens =
      (total.reasoningTokens ?? 0) + (value.reasoningTokens ?? 0);
    return {
      inputTokens: total.inputTokens + value.inputTokens,
      outputTokens: total.outputTokens + value.outputTokens,
      totalTokens: total.totalTokens + value.totalTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + value.cacheReadInputTokens,
      cacheWriteInputTokens: total.cacheWriteInputTokens + value.cacheWriteInputTokens,
      ...(reasoningTokens ? { reasoningTokens } : {}),
    };
  }, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
}

export function modelTokenUsageJson(value: unknown): JsonValue | null {
  if (value == null) return null;
  return collectModelTokenUsage(value) as unknown as JsonValue;
}

function configuredRate(name: string, fallback: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

export function estimateBedrockCostUsd(modelId: string, usage: ModelTokenUsageTotals) {
  if (modelId === "mock") return 0;
  if (!/claude-sonnet-4-6/i.test(modelId)) return null;
  // Sonnet 4.6 Bedrock rates per million tokens. Environment overrides make
  // pricing changes operational rather than code changes.
  const inputRate = configuredRate("WORKBASE_BEDROCK_INPUT_USD_PER_MILLION", 3);
  const outputRate = configuredRate("WORKBASE_BEDROCK_OUTPUT_USD_PER_MILLION", 15);
  const cacheReadRate = configuredRate("WORKBASE_BEDROCK_CACHE_READ_USD_PER_MILLION", 0.3);
  const cacheWriteRate = configuredRate("WORKBASE_BEDROCK_CACHE_WRITE_USD_PER_MILLION", 3.75);
  const cost = (
    usage.inputTokens * inputRate +
    usage.outputTokens * outputRate +
    usage.cacheReadInputTokens * cacheReadRate +
    usage.cacheWriteInputTokens * cacheWriteRate
  ) / 1_000_000;
  return Number(cost.toFixed(6));
}

export function resolveModelCostUsd(input: {
  provider: string;
  modelId: string;
  usage: ModelTokenUsageTotals;
  rawUsage?: unknown;
}) {
  const reportedCost = collectReportedModelCostUsd(input.rawUsage);
  if (reportedCost != null) return reportedCost;
  return input.provider === "bedrock"
    ? estimateBedrockCostUsd(input.modelId, input.usage)
    : input.modelId === "mock"
      ? 0
      : null;
}
