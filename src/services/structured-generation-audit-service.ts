import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue } from "@/src/domain/types";
import {
  StructuredGenerationBudgetError,
  StructuredOutputError,
} from "@/src/lib/bedrock-structured-llm-client";
import {
  BedrockConverseAgentError,
  BedrockConverseLimitError,
  sanitizeBedrockConverseEventValue,
} from "@/src/lib/bedrock-converse-agent";
import {
  generationRunFailureTokenUsage,
  isStructuredGenerationAdmissionFailure,
} from "@/src/lib/generation-runs";
import {
  resolveActiveTextModelIdentity,
  type TextModelProfile,
} from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import {
  addModelTokenUsage,
  collectModelTokenUsage,
  collectReportedModelCostUsd,
  collectUnknownModelUsageAttempts,
  countCostedModelProviderAttempts,
  countModelUsageEntries,
  countModelProviderAttempts,
  resolveModelCostUsd,
} from "@/src/services/model-usage-service";

type AuditedGenerationKind =
  | "execution_routing"
  | "semantic_extraction"
  | "semantic_repair"
  | "highlight_verification"
  | "artifact_generation"
  | "capability_synthesis"
  | "coverage_audit"
  | "answer_completeness_audit"
  | "project_chat_planning"
  | "project_chat_verification";

type StructuredResult = {
  data: unknown;
  rawOutput: string;
  parsedOutput: JsonValue;
  tokenUsage: JsonValue | null;
  provider: string;
  priorEstimatedCostUsd?: number | null;
  modelId: string;
  transportMode: string;
  attempts: unknown;
  requestId?: string | null;
};

function json(value: unknown): Prisma.InputJsonValue {
  return sanitizeBedrockConverseEventValue(value) as Prisma.InputJsonValue;
}

export const EXACT_PARSED_OUTPUT_MAX_BYTES = 128 * 1024;

function exactParsedOutputJson(value: unknown): Prisma.InputJsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Exact parsed-output audit projection is not JSON serializable.");
  }
  if (serialized === undefined) {
    throw new Error("Exact parsed-output audit projection is not JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > EXACT_PARSED_OUTPUT_MAX_BYTES) {
    throw new Error(
      `Exact parsed-output audit projection exceeds ${EXACT_PARSED_OUTPUT_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  const parsed = JSON.parse(serialized) as JsonValue;
  return parsed as Prisma.InputJsonValue;
}

function rawPreview(raw: string | null) {
  if (!raw) return null;
  const safe = sanitizeBedrockConverseEventValue(raw);
  return typeof safe === "string" ? safe.slice(0, 4_000) : JSON.stringify(safe).slice(0, 4_000);
}

function rawHash(raw: string | null) {
  return raw ? createHash("sha256").update(raw).digest("hex") : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function collectProviderAttemptMetadata(value: unknown) {
  const attempts: JsonValue[] = [];
  const requestIds = new Set<string>();
  const routedProviders = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (
      !current ||
      typeof current !== "object" ||
      depth > 6 ||
      seen.has(current)
    ) {
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.failedAttempts)) {
      for (const attempt of record.failedAttempts) {
        const sanitized = sanitizeAuditedUsageEvidence(attempt).value;
        if (
          sanitized &&
          typeof sanitized === "object" &&
          !Array.isArray(sanitized)
        ) {
          attempts.push(sanitized);
        }
        visit(attempt, depth + 1);
      }
    }
    if (
      typeof record.routedProvider === "string" &&
      record.routedProvider.trim()
    ) {
      routedProviders.add(record.routedProvider.trim());
    }
    if (Array.isArray(record.routedProviders)) {
      record.routedProviders.forEach((provider) => {
        if (typeof provider === "string" && provider.trim()) {
          routedProviders.add(provider.trim());
        }
      });
    }
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
    Object.entries(record).forEach(([key, entry]) => {
      if (key !== "failedAttempts") visit(entry, depth + 1);
    });
  };
  visit(value, 0);
  return {
    failedAttempts: attempts,
    requestIds: Array.from(requestIds),
    routedProviders: Array.from(routedProviders),
  };
}

const AUDITED_USAGE_EVIDENCE_VERSION = 1;
// The durable envelope adds two container levels. Keeping source evidence at
// depth four or less guarantees every persisted usage leaf remains within the
// shared accounting collectors' depth-six traversal.
const MAX_AUDITED_USAGE_EVIDENCE_DEPTH = 4;
const MAX_AUDITED_USAGE_EVIDENCE_ITEMS = 256;
const auditedUsageNumberKeys = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
  "cost",
  "costUsd",
  "providerAttemptCount",
  "costedAttemptCount",
  "unknownUsageAttempts",
  "httpStatus",
]);
const auditedUsageStringKeys = new Set([
  "provider",
  "modelId",
  "requestId",
  "routedProvider",
  "status",
  "code",
  "errorType",
]);
const auditedUsageBooleanKeys = new Set(["retryable"]);
const auditedUsageStringArrayKeys = new Set([
  "providers",
  "modelIds",
  "requestIds",
  "routedProviders",
]);
const auditedUsageContainerKeys = new Set([
  "attempts",
  "failedAttempts",
  "usage",
  "tokenUsage",
  "batches",
  "phases",
]);
const auditedUsageSensitiveStringPattern =
  /https?:\/\/|\bBearer\s|sk-or-|(?:api[_ -]?key|authorization|cookie|credential|password|passwd|secret|private.?key|workspace)(?:[_:=/-]|\s|$)/i;

/**
 * Retains only metering and provider-attempt identity. Provider token-usage
 * objects are trusted as accounting evidence, not as a channel for persisting
 * prompts, response content, or raw error messages.
 */
function auditedUsageString(
  key: string,
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || auditedUsageSensitiveStringPattern.test(trimmed)) {
    return null;
  }
  if (key === "provider" || key === "routedProvider") {
    return trimmed.length <= 100 &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
      ? trimmed
      : null;
  }
  if (key === "status" || key === "code" || key === "errorType") {
    return trimmed.length <= 80 &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)
      ? trimmed
      : null;
  }
  if (key === "modelId") {
    return trimmed.length <= 200 &&
        !trimmed.includes("://") &&
        /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(trimmed)
      ? trimmed
      : null;
  }
  return trimmed.length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
    ? trimmed
    : null;
}

function mergeAuditedUsageStrings(
  key: "requestId" | "routedProvider",
  ...collections: readonly (readonly string[])[]
) {
  const merged = new Set<string>();
  for (const collection of collections) {
    for (const value of collection) {
      const sanitized = auditedUsageString(key, value);
      if (sanitized) merged.add(sanitized);
      if (merged.size >= MAX_AUDITED_USAGE_EVIDENCE_ITEMS) {
        return Array.from(merged);
      }
    }
  }
  return Array.from(merged);
}

function auditedUsageArrayStringKey(key: string) {
  switch (key) {
    case "providers":
      return "provider";
    case "modelIds":
      return "modelId";
    case "requestIds":
      return "requestId";
    case "routedProviders":
      return "routedProvider";
    default:
      return null;
  }
}

interface SanitizedAuditedUsageEvidence {
  value: JsonValue | null;
  truncated: boolean;
}

function sanitizeAuditedUsageEvidence(
  value: unknown,
): SanitizedAuditedUsageEvidence {
  const seen = new WeakSet<object>();
  let truncated = false;
  const visit = (current: unknown, depth: number): JsonValue | null => {
    if (!current || typeof current !== "object") {
      return null;
    }
    if (depth > MAX_AUDITED_USAGE_EVIDENCE_DEPTH || seen.has(current)) {
      truncated = true;
      return null;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > MAX_AUDITED_USAGE_EVIDENCE_ITEMS) {
        truncated = true;
      }
      return current
        .slice(0, MAX_AUDITED_USAGE_EVIDENCE_ITEMS)
        .flatMap((entry) => {
          const sanitized = visit(entry, depth + 1);
          return sanitized == null ? [] : [sanitized];
        });
    }

    const output: Record<string, JsonValue> = {};
    const entries = Object.entries(current as Record<string, unknown>);
    if (entries.length > MAX_AUDITED_USAGE_EVIDENCE_ITEMS) {
      truncated = true;
    }
    for (const [key, entry] of entries.slice(
      0,
      MAX_AUDITED_USAGE_EVIDENCE_ITEMS,
    )) {
      if (auditedUsageNumberKeys.has(key)) {
        if (
          typeof entry === "number" &&
          Number.isFinite(entry) &&
          entry >= 0
        ) {
          output[key] = entry;
        } else if (entry == null) {
          output[key] = null;
        }
        continue;
      }
      if (auditedUsageStringKeys.has(key)) {
        const sanitized = auditedUsageString(key, entry);
        if (sanitized != null) {
          output[key] = sanitized;
        } else if (
          key === "code" &&
          typeof entry === "number" &&
          Number.isFinite(entry)
        ) {
          output[key] = entry;
        } else if (entry == null) {
          output[key] = null;
        }
        continue;
      }
      if (auditedUsageBooleanKeys.has(key)) {
        if (typeof entry === "boolean") output[key] = entry;
        continue;
      }
      if (auditedUsageStringArrayKeys.has(key) && Array.isArray(entry)) {
        if (entry.length > MAX_AUDITED_USAGE_EVIDENCE_ITEMS) {
          truncated = true;
        }
        const singularKey = auditedUsageArrayStringKey(key)!;
        output[key] = entry
          .slice(0, MAX_AUDITED_USAGE_EVIDENCE_ITEMS)
          .flatMap((candidate) => {
            const sanitized = auditedUsageString(singularKey, candidate);
            return sanitized == null ? [] : [sanitized];
          });
        continue;
      }
      if (auditedUsageContainerKeys.has(key)) {
        const nested = visit(entry, depth + 1);
        if (nested != null) output[key] = nested;
      }
    }
    if (!Object.keys(output).length) return null;
    return output;
  };
  return { value: visit(value, 0), truncated };
}

function priorAuditedUsageEntries(value: unknown) {
  const prior = objectValue(value);
  let truncated = prior?.auditEvidenceTruncated === true;
  if (
    prior?.auditUsageEvidenceVersion === AUDITED_USAGE_EVIDENCE_VERSION &&
    Array.isArray(prior.attempts)
  ) {
    if (prior.attempts.length > MAX_AUDITED_USAGE_EVIDENCE_ITEMS) {
      truncated = true;
    }
    const attempts = prior.attempts
      .slice(0, MAX_AUDITED_USAGE_EVIDENCE_ITEMS)
      .flatMap((entry) => {
        const sanitized = sanitizeAuditedUsageEvidence(entry);
        truncated ||= sanitized.truncated;
        return sanitized.value == null ? [] : [sanitized.value];
      });
    return { attempts, truncated };
  }
  const sanitized = sanitizeAuditedUsageEvidence(value);
  return {
    attempts: sanitized.value == null ? [] : [sanitized.value],
    truncated: truncated || sanitized.truncated,
  };
}

function cumulativeAuditedUsageEvidence(input: {
  priorTokenUsage: unknown;
  currentTokenUsage: unknown;
  providerAttemptCount: number;
  unknownUsageAttempts: number;
}) {
  const current = sanitizeAuditedUsageEvidence(input.currentTokenUsage);
  const prior = priorAuditedUsageEntries(input.priorTokenUsage);
  const allAttempts = [
    ...prior.attempts,
    ...(current.value == null ? [] : [current.value]),
  ];
  const truncated =
    prior.truncated ||
    current.truncated ||
    allAttempts.length > MAX_AUDITED_USAGE_EVIDENCE_ITEMS;
  const attempts = allAttempts.slice(0, MAX_AUDITED_USAGE_EVIDENCE_ITEMS);
  if (!attempts.length) return { tokenUsage: null, truncated };
  return {
    tokenUsage: {
      auditUsageEvidenceVersion: AUDITED_USAGE_EVIDENCE_VERSION,
      attempts,
      providerAttemptCount: input.providerAttemptCount,
      unknownUsageAttempts: input.unknownUsageAttempts,
      ...(truncated ? { auditEvidenceTruncated: true } : {}),
    } satisfies JsonValue,
    truncated,
  };
}

function providerErrorUsage(error: unknown): JsonValue | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    failedAttempts?: unknown;
    unknownUsageAttempts?: unknown;
    providerAttemptCount?: unknown;
    tokenUsage?: unknown;
  };
  const providerAttemptCount = nonNegativeInteger(
    candidate.providerAttemptCount,
  );
  const unknownUsageAttempts = nonNegativeInteger(
    candidate.unknownUsageAttempts,
  );
  if (
    !Array.isArray(candidate.failedAttempts) &&
    providerAttemptCount == null &&
    unknownUsageAttempts == null
  ) {
    return null;
  }
  return sanitizeAuditedUsageEvidence({
    attempts: candidate.tokenUsage == null ? [] : [candidate.tokenUsage],
    failedAttempts: Array.isArray(candidate.failedAttempts)
      ? candidate.failedAttempts
      : [],
    providerAttemptCount: providerAttemptCount ?? 1,
    unknownUsageAttempts: unknownUsageAttempts ?? 1,
  }).value;
}

function cumulativeAuditUsage(input: {
  priorTokenUsage: unknown;
  priorResultRefs: unknown;
  currentTokenUsage: unknown;
  modelId: string;
  provider: string;
  priorEstimatedCostUsd?: number | null;
  countCurrentAttempt?: boolean;
}) {
  const countCurrentAttempt = input.countCurrentAttempt ?? true;
  const priorRefs = objectValue(input.priorResultRefs);
  const priorHasKnownUsage = input.priorTokenUsage != null;
  const currentUsage = collectModelTokenUsage(input.currentTokenUsage);
  const currentExplicitUnknownUsage = collectUnknownModelUsageAttempts(input.currentTokenUsage);
  const currentHasPositiveUsage = currentUsage.totalTokens > 0 ||
    currentUsage.inputTokens > 0 ||
    currentUsage.outputTokens > 0 ||
    currentUsage.cacheReadInputTokens > 0 ||
    currentUsage.cacheWriteInputTokens > 0;
  const currentHasKnownUsage = input.currentTokenUsage != null &&
    (currentExplicitUnknownUsage === 0 || currentHasPositiveUsage);
  const priorAttemptCount = nonNegativeInteger(priorRefs?.auditAttemptCount) ??
    (input.priorResultRefs != null || priorHasKnownUsage ? 1 : 0);
  const priorUnknownUsageAttempts = nonNegativeInteger(priorRefs?.unknownUsageAttempts) ??
    (input.priorResultRefs != null && !priorHasKnownUsage && input.modelId !== "mock" ? 1 : 0);
  const unknownUsageAttempts = priorUnknownUsageAttempts + (countCurrentAttempt
    ? (currentExplicitUnknownUsage || (!currentHasKnownUsage && input.modelId !== "mock" ? 1 : 0))
    : 0);
  const usage = addModelTokenUsage(
    collectModelTokenUsage(input.priorTokenUsage),
    currentUsage,
  );
  const explicitProviderAttemptCount = countModelProviderAttempts(
    input.currentTokenUsage,
  );
  const currentProviderAttemptCount = countCurrentAttempt
    ? Math.max(
        explicitProviderAttemptCount,
        currentExplicitUnknownUsage,
        input.modelId === "mock" ? 0 : 1,
      )
    : 0;
  const currentReportedCostUsd = collectReportedModelCostUsd(
    input.currentTokenUsage,
  );
  const currentUsageEntryCount = countModelUsageEntries(
    input.currentTokenUsage,
  );
  const currentCostedAttemptCount = countCostedModelProviderAttempts(
    input.currentTokenUsage,
  );
  const priorUsageEntryCount = countModelUsageEntries(input.priorTokenUsage);
  const priorCostedAttemptCount = countCostedModelProviderAttempts(
    input.priorTokenUsage,
  );
  const openRouter = input.provider.toLowerCase() === "openrouter";
  const priorCostComplete =
    !openRouter ||
    input.modelId === "mock" ||
    priorAttemptCount === 0 ||
    (
      priorUsageEntryCount > 0 &&
      priorCostedAttemptCount >= priorAttemptCount
    );
  const priorUsageComplete =
    priorRefs?.usageComplete !== false && priorCostComplete;
  const currentCostComplete =
    !countCurrentAttempt ||
    !openRouter ||
    input.modelId === "mock" ||
    (
      currentUsageEntryCount > 0 &&
      currentCostedAttemptCount >= currentProviderAttemptCount
    );
  const usageComplete =
    unknownUsageAttempts === 0 &&
    priorUsageComplete &&
    currentCostComplete;
  const priorKnownEstimatedCostUsd =
    input.priorEstimatedCostUsd ??
    nonNegativeNumber(priorRefs?.knownEstimatedCostUsd);
  const knownEstimatedCostUsd =
    input.provider === "openrouter"
      ? priorKnownEstimatedCostUsd != null || currentReportedCostUsd != null
        ? Number(
            (
              (priorKnownEstimatedCostUsd ?? 0) +
              (currentReportedCostUsd ?? 0)
            ).toFixed(8),
          )
        : null
      : resolveModelCostUsd({
          provider: input.provider,
          modelId: input.modelId,
          usage,
          rawUsage: {
            prior: input.priorTokenUsage,
            current: input.currentTokenUsage,
          },
        });

  return {
    usage,
    hasKnownUsage: priorHasKnownUsage || currentHasKnownUsage,
    auditAttemptCount: priorAttemptCount + currentProviderAttemptCount,
    currentProviderAttemptCount,
    unknownUsageAttempts,
    usageComplete,
    knownEstimatedCostUsd,
    // An unobserved provider attempt makes the total cost unknown. Retain the
    // priced known-token lower bound in resultRefs without presenting it as a
    // complete run cost.
    estimatedCostUsd: usageComplete ? knownEstimatedCostUsd : null,
  };
}

function finalizePersistedAuditUsage(input: {
  auditUsage: ReturnType<typeof cumulativeAuditUsage>;
  tokenUsage: JsonValue | null;
  evidenceTruncated: boolean;
  provider: string;
  modelId: string;
}) {
  const openRouter = input.provider.toLowerCase() === "openrouter";
  const persistedCostComplete =
    !openRouter ||
    input.modelId === "mock" ||
    input.auditUsage.auditAttemptCount === 0 ||
    (
      countModelUsageEntries(input.tokenUsage) > 0 &&
      countCostedModelProviderAttempts(input.tokenUsage) >=
        input.auditUsage.auditAttemptCount
    );
  const usageComplete =
    input.auditUsage.usageComplete &&
    !input.evidenceTruncated &&
    persistedCostComplete;
  return {
    ...input.auditUsage,
    usageComplete,
    estimatedCostUsd: usageComplete
      ? input.auditUsage.knownEstimatedCostUsd
      : null,
  };
}

function structuredAttemptCount(value: unknown) {
  return Array.isArray(value) ? value.length : null;
}

const hostAgentFailureCodes = new Set([
  "protocol_error",
  "iteration_limit_exceeded",
  "tool_call_limit_exceeded",
  "token_limit_exceeded",
  "output_token_limit_reached",
]);

function hostGenerationFailure(error: unknown) {
  if (error instanceof StructuredGenerationBudgetError) {
    return {
      code: error.code,
      validationErrors: {
        origin: "host_budget",
        code: error.code,
      } satisfies JsonValue,
    };
  }
  if (
    error instanceof BedrockConverseAgentError &&
    hostAgentFailureCodes.has(error.code)
  ) {
    return {
      code: error.code,
      validationErrors: {
        origin: "host_agent",
        code: error.code,
        ...(error instanceof BedrockConverseLimitError
          ? { limit: error.limit, actual: error.actual }
          : {}),
      } satisfies JsonValue,
    };
  }
  return null;
}

function structuredGenerationFailureStatus(input: {
  structured: StructuredOutputError | null;
  error: unknown;
}) {
  return input.structured?.status ??
    (hostGenerationFailure(input.error) ? "validation_error" : "provider_error");
}

function structuredGenerationFailureMessage(input: {
  structured: StructuredOutputError | null;
  error: unknown;
}) {
  if (input.error instanceof StructuredGenerationBudgetError) {
    return isStructuredGenerationAdmissionFailure(input.error)
      ? `Structured generation stopped before dispatch: ${input.error.code}.`
      : `Structured generation stopped after provider dispatch: ${input.error.code}.`;
  }
  if (input.structured) {
    return `Structured generation failed closed: ${input.structured.status}.`;
  }
  const hostFailure = hostGenerationFailure(input.error);
  if (hostFailure) {
    return `Structured generation failed closed at a host boundary: ${hostFailure.code}.`;
  }
  return "Structured generation provider request failed closed.";
}

function profileForAuditedKind(kind: AuditedGenerationKind): TextModelProfile {
  switch (kind) {
    case "execution_routing":
      return "routing";
    case "semantic_extraction":
    case "semantic_repair":
      return "code_extraction";
    case "capability_synthesis":
      return "routing";
    case "coverage_audit":
      return "verification";
    case "answer_completeness_audit":
      return "deep_synthesis";
    case "highlight_verification":
      return "verification";
    case "artifact_generation":
      return "verification";
    case "project_chat_planning":
      return "primary_answer";
    case "project_chat_verification":
      return "verification";
  }
}

export async function runAuditedStructuredGeneration<TResult extends StructuredResult>(input: {
  workItemId?: string;
  agentRunId?: string;
  kind: AuditedGenerationKind;
  idempotencyKey?: string;
  profile?: TextModelProfile;
  inputSummary: unknown;
  resultAttestation?: (result: TResult) => Record<string, unknown>;
  /**
   * Persists bounded host-side provenance that must survive a failed model
   * attempt, such as already-consumed shared inspection budget. Never include
   * prompts, raw source, or model output here.
   */
  failureResultAttestation?: (error: unknown) => Record<string, unknown>;
  /**
   * Persists the purpose-built attestation without the general event-preview
   * depth truncation. Use only for bounded attestations that must replay
   * exactly; the same hard byte cap as exact parsed output applies.
   */
  preserveResultAttestationExactly?: boolean;
  /**
   * Opts a schema-validated, purpose-built audit projection into lossless
   * persistence. The projection is JSON-round-tripped and hard-capped;
   * prompts, notebooks, and raw provider output do not belong here.
   */
  exactParsedOutput?: (result: TResult) => unknown;
  execute: () => Promise<TResult>;
}): Promise<TResult & { generationRunId: string | null }> {
  const startedAt = Date.now();
  const config =
    input.workItemId && input.idempotencyKey
      ? resolveActiveTextModelIdentity(
          input.profile ?? profileForAuditedKind(input.kind),
        )
      : null;
  const run = input.workItemId && input.idempotencyKey && config
    ? await prisma.generationRun.upsert({
        where: {
          workItemId_idempotencyKey: {
            workItemId: input.workItemId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        create: {
          workItemId: input.workItemId,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          status: "running",
          provider: config.provider,
          modelId: config.modelId,
          inputSummary: json(input.inputSummary),
        },
        update: {
          status: "running",
          provider: config.provider,
          modelId: config.modelId,
          inputSummary: json(input.inputSummary),
          validationErrors: Prisma.JsonNull,
        },
      })
    : null;

  try {
    const result = await input.execute();
    const resultAttestation = input.resultAttestation?.(result);
    if (run) {
      const cumulativeUsage = cumulativeAuditUsage({
        priorTokenUsage: run.tokenUsage,
        priorResultRefs: run.resultRefs,
        currentTokenUsage: result.tokenUsage,
        modelId: result.modelId,
        provider: result.provider,
        priorEstimatedCostUsd: run.estimatedCostUsd,
      });
      const evidence = cumulativeAuditedUsageEvidence({
        priorTokenUsage: run.tokenUsage,
        currentTokenUsage: result.tokenUsage,
        providerAttemptCount: cumulativeUsage.auditAttemptCount,
        unknownUsageAttempts: cumulativeUsage.unknownUsageAttempts,
      });
      const tokenUsage = evidence.tokenUsage;
      const auditUsage = finalizePersistedAuditUsage({
        auditUsage: cumulativeUsage,
        tokenUsage,
        evidenceTruncated: evidence.truncated,
        provider: result.provider,
        modelId: result.modelId,
      });
      const providerAttempts = collectProviderAttemptMetadata(tokenUsage);
      const resultRefs = {
        ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
        transportMode: result.transportMode,
        profile: input.profile ?? profileForAuditedKind(input.kind),
        configuredModelId: config!.modelId,
        requestId: auditedUsageString("requestId", result.requestId),
        requestIds: providerAttempts.requestIds,
        structuredAttemptCount: structuredAttemptCount(result.attempts),
        rawOutputHash: rawHash(result.rawOutput),
        durationMs: Date.now() - startedAt,
        auditAttemptCount: auditUsage.auditAttemptCount,
        providerAttemptCount: auditUsage.currentProviderAttemptCount,
        failedProviderAttempts: providerAttempts.failedAttempts,
        routedProviders: providerAttempts.routedProviders,
        unknownUsageAttempts: auditUsage.unknownUsageAttempts,
        auditEvidenceTruncated: evidence.truncated,
        usageComplete: auditUsage.usageComplete,
        knownEstimatedCostUsd: auditUsage.knownEstimatedCostUsd,
        ...(resultAttestation ? { resultAttestation } : {}),
      };
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          provider: result.provider,
          modelId: result.modelId,
          rawOutput: rawPreview(result.rawOutput),
          parsedOutput: input.exactParsedOutput
            ? exactParsedOutputJson(input.exactParsedOutput(result))
            : json(result.parsedOutput),
          validationErrors: Prisma.JsonNull,
          tokenUsage: tokenUsage == null ? Prisma.JsonNull : tokenUsage as Prisma.InputJsonValue,
          estimatedCostUsd: auditUsage.estimatedCostUsd,
          resultRefs: input.preserveResultAttestationExactly
            ? exactParsedOutputJson(resultRefs)
            : json(resultRefs),
        },
      });
    }
    return { ...result, generationRunId: run?.id ?? null };
  } catch (error) {
    if (run) {
      const structured = error instanceof StructuredOutputError ? error : null;
      const admissionFailure =
        isStructuredGenerationAdmissionFailure(error);
      const failureTokenUsage =
        structured?.tokenUsage ??
        generationRunFailureTokenUsage(error) ??
        providerErrorUsage(error);
      const cumulativeUsage = cumulativeAuditUsage({
        priorTokenUsage: run.tokenUsage,
        priorResultRefs: run.resultRefs,
        currentTokenUsage: failureTokenUsage,
        modelId: run.modelId,
        provider: run.provider ?? config!.provider,
        priorEstimatedCostUsd: run.estimatedCostUsd,
        countCurrentAttempt: !admissionFailure,
      });
      const evidence = cumulativeAuditedUsageEvidence({
        priorTokenUsage: run.tokenUsage,
        currentTokenUsage: failureTokenUsage,
        providerAttemptCount: cumulativeUsage.auditAttemptCount,
        unknownUsageAttempts: cumulativeUsage.unknownUsageAttempts,
      });
      const tokenUsage = evidence.tokenUsage;
      const auditUsage = finalizePersistedAuditUsage({
        auditUsage: cumulativeUsage,
        tokenUsage,
        evidenceTruncated: evidence.truncated,
        provider: run.provider ?? config!.provider,
        modelId: run.modelId,
      });
      const providerAttempts = collectProviderAttemptMetadata(tokenUsage);
      const hostRequestIds = error instanceof BedrockConverseAgentError
        ? error.requestIds
        : [];
      const hostRoutedProviders = error instanceof BedrockConverseAgentError
        ? error.routedProviders
        : [];
      const failureResultAttestation = input.failureResultAttestation?.(error);
      const hostFailure = hostGenerationFailure(error);
      const failureResultRefs = {
        ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
        transportMode: structured?.transportMode ?? null,
        profile: input.profile ?? profileForAuditedKind(input.kind),
        configuredModelId: config!.modelId,
        requestIds: mergeAuditedUsageStrings(
          "requestId",
          providerAttempts.requestIds,
          hostRequestIds,
        ),
        structuredAttemptCount: structuredAttemptCount(
          structured?.attempts,
        ),
        rawOutputHash: rawHash(structured?.rawOutput ?? null),
        message: structuredGenerationFailureMessage({
          structured,
          error,
        }),
        durationMs: Date.now() - startedAt,
        auditAttemptCount: auditUsage.auditAttemptCount,
        providerAttemptCount: auditUsage.currentProviderAttemptCount,
        failedProviderAttempts: providerAttempts.failedAttempts,
        routedProviders: mergeAuditedUsageStrings(
          "routedProvider",
          providerAttempts.routedProviders,
          hostRoutedProviders,
        ),
        unknownUsageAttempts: auditUsage.unknownUsageAttempts,
        auditEvidenceTruncated: evidence.truncated,
        usageComplete: auditUsage.usageComplete,
        knownEstimatedCostUsd: auditUsage.knownEstimatedCostUsd,
        admissionFailure,
        failureOrigin: hostFailure ? "host" : null,
        failureCode: hostFailure?.code ?? null,
        budgetCode:
          error instanceof StructuredGenerationBudgetError
            ? error.code
            : null,
        ...(failureResultAttestation
          ? { resultAttestation: failureResultAttestation }
          : {}),
      };
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: structuredGenerationFailureStatus({ structured, error }),
          rawOutput: rawPreview(structured?.rawOutput ?? null),
          validationErrors:
            structured?.validationErrors != null
              ? json(structured.validationErrors)
              : hostFailure
                ? json(hostFailure.validationErrors)
                : Prisma.JsonNull,
          tokenUsage: tokenUsage == null ? Prisma.JsonNull : tokenUsage as Prisma.InputJsonValue,
          estimatedCostUsd: auditUsage.estimatedCostUsd,
          resultRefs: input.preserveResultAttestationExactly
            ? exactParsedOutputJson(failureResultRefs)
            : json(failureResultRefs),
        },
      });
    }
    throw error;
  }
}
