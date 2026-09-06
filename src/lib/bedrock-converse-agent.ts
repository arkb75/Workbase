import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message,
  type StopReason,
  type TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { z } from "zod";
import type { JsonValue } from "@/src/domain/types";
import {
  toBedrockCompatibleJsonSchema,
  type JsonSchemaObject,
} from "@/src/lib/llm-json-schemas";

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOOL_CALLS = 16;
const DEFAULT_MAX_TOTAL_TOKENS = 120_000;
const DEFAULT_MAX_TOKENS_PER_ITERATION = 4_096;
const MAX_EMPTY_TOOL_USE_RECOVERIES = 1;
const DEFAULT_EVENT_STRING_LIMIT = 512;
const DEFAULT_EVENT_COLLECTION_LIMIT = 20;
const DEFAULT_EVENT_DEPTH_LIMIT = 5;

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|credential|password|passwd|secret|private.?key|api.?key|token)/i;
const SAFE_NUMERIC_USAGE_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
  "cost",
  "costUsd",
  "unknownUsageAttempts",
]);
const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[^\s,;]+/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
];

export interface BedrockConverseTransportResponse {
  message: Message | null;
  stopReason: StopReason | string | null;
  usage: TokenUsage | null;
  requestId: string | null;
  provider?: string;
  routedProvider?: string | null;
  modelId?: string;
  costUsd?: number | null;
}

export interface BedrockConverseTransport {
  /** Opt in only when the selected provider/model supports both together. */
  readonly supportsReasoningWithForcedTool?: boolean;
  converse(
    input: ConverseCommandInput,
    options?: { signal?: AbortSignal },
  ): Promise<BedrockConverseTransportResponse>;
}

export class AwsBedrockConverseTransport implements BedrockConverseTransport {
  private readonly client: BedrockRuntimeClient;

  constructor(config: { region: string; profile?: string }) {
    this.client = new BedrockRuntimeClient({
      region: config.region,
      credentials: config.profile
        ? fromIni({
            profile: config.profile,
          })
        : undefined,
    });
  }

  async converse(
    input: ConverseCommandInput,
    options?: { signal?: AbortSignal },
  ): Promise<BedrockConverseTransportResponse> {
    const response = await this.client.send(new ConverseCommand(input), {
      abortSignal: options?.signal,
    });

    return {
      message: response.output?.message ?? null,
      stopReason: response.stopReason ?? null,
      usage: response.usage ?? null,
      requestId: response.$metadata.requestId ?? null,
    };
  }
}

export interface BedrockConverseAgentLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  /**
   * Optional cap on newly processed semantic tokens. Cached input replay is
   * excluded, while output is always charged. maxTotalTokens remains the raw
   * cumulative-transcript runaway guard.
   */
  maxSemanticTokens?: number;
}

export interface BedrockConverseAgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
  unknownUsageAttempts?: number;
  failedAttempts?: JsonValue[];
  providerAttemptCount?: number;
  costedAttemptCount?: number;
  routedProviders?: string[];
}

export interface BedrockConverseToolContext {
  iteration: number;
  toolCall: number;
  toolUseId: string;
  signal?: AbortSignal;
}

export interface BedrockConverseTool {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
  jsonSchema: JsonSchemaObject;
  strict?: boolean;
  /** Number of malformed calls the model may correct before the run fails. */
  maxRecoverableInvalidInputAttempts?: number;
  /** Return true when a successful normalized result completes the agent run. */
  isTerminalResult?: (result: JsonValue) => boolean;
  execute(
    input: unknown,
    context: BedrockConverseToolContext,
  ): unknown | Promise<unknown>;
}

interface TypedBedrockConverseTool<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  jsonSchema: JsonSchemaObject;
  strict?: boolean;
  /** Number of malformed calls the model may correct before the run fails. */
  maxRecoverableInvalidInputAttempts?: number;
  /** Return true when a successful normalized result completes the agent run. */
  isTerminalResult?: (result: JsonValue) => boolean;
  execute(
    input: TInput,
    context: BedrockConverseToolContext,
  ): unknown | Promise<unknown>;
}

/**
 * Preserves the handler's inferred input type while exposing a uniform runtime tool.
 * The runtime always validates with the paired Zod schema before calling execute.
 */
export function defineBedrockConverseTool<TInput>(
  tool: TypedBedrockConverseTool<TInput>,
): BedrockConverseTool {
  return {
    ...tool,
    inputSchema: tool.inputSchema as z.ZodType<unknown>,
    execute(input, context) {
      return tool.execute(input as TInput, context);
    },
  };
}

export type BedrockConverseToolOutcome =
  | "success"
  | "invalid_input"
  | "unknown_tool"
  | "execution_error";

export type BedrockConverseAgentEvent =
  | {
      type: "model_call_started";
      iteration: number;
      messageCount: number;
      profile?: string;
    }
  | {
      type: "model_call_completed";
      iteration: number;
      stopReason: string;
      requestId: string | null;
      durationMs: number;
      usage: BedrockConverseAgentTokenUsage;
      aggregateUsage: BedrockConverseAgentTokenUsage;
      provider?: string;
      routedProvider?: string | null;
      modelId?: string;
      costUsd?: number | null;
      profile?: string;
    }
  | {
      type: "model_call_failed";
      iteration: number;
      durationMs: number;
      usage: BedrockConverseAgentTokenUsage;
      aggregateUsage: BedrockConverseAgentTokenUsage;
      provider: string;
      modelId: string;
      requestIds: string[];
      routedProviders: string[];
      providerStatus: number | null;
      retryable: boolean | null;
      providerCode: string | null;
      profile?: string;
    }
  | {
      type: "tool_call_started";
      iteration: number;
      toolCall: number;
      toolUseId: string;
      toolName: string;
      input: JsonValue;
    }
  | {
      type: "tool_call_completed";
      iteration: number;
      toolCall: number;
      toolUseId: string;
      toolName: string;
      outcome: BedrockConverseToolOutcome;
      durationMs: number;
      output: JsonValue;
    };

export interface BedrockConverseAgentRunInput {
  systemPrompt?: string;
  messages: readonly Message[];
  tools?: readonly BedrockConverseTool[];
  maxTokens?: number;
  temperature?: number;
  effort?: "low" | "medium" | "high";
  enablePromptCaching?: boolean;
  limits?: Partial<BedrockConverseAgentLimits>;
  signal?: AbortSignal;
  /** Re-evaluated before every model turn; return null to leave tool choice automatic. */
  forceTool?: (context: {
    iteration: number;
    toolCalls: number;
  }) => string | null | undefined;
  onEvent?: (event: BedrockConverseAgentEvent) => void | Promise<void>;
}

export interface BedrockConverseAgentRunResult {
  text: string;
  assistantMessage: Message;
  messages: Message[];
  stopReason: "end_turn" | "stop_sequence" | "tool_use";
  terminalTool?: {
    name: string;
    toolUseId: string;
  };
  iterations: number;
  toolCalls: number;
  usage: BedrockConverseAgentTokenUsage;
  events: BedrockConverseAgentEvent[];
  provider?: string;
  routedProviders?: string[];
  modelId?: string;
  requestIds?: string[];
  reportedCostUsd?: number | null;
}

export type BedrockConverseAgentErrorCode =
  | "configuration_error"
  | "provider_error"
  | "model_capability_error"
  | "protocol_error"
  | "iteration_limit_exceeded"
  | "tool_call_limit_exceeded"
  | "token_limit_exceeded"
  | "output_token_limit_reached"
  | "response_blocked"
  | "malformed_model_response";

interface BedrockConverseAgentErrorOptions {
  stopReason?: string | null;
  iterations?: number;
  toolCalls?: number;
  usage?: BedrockConverseAgentTokenUsage;
  cause?: unknown;
  providerStatus?: number | null;
  retryable?: boolean | null;
  providerCode?: string | null;
  events?: BedrockConverseAgentEvent[];
  requestIds?: string[];
  routedProviders?: string[];
  reportedCostUsd?: number | null;
}

export class BedrockConverseAgentError extends Error {
  readonly stopReason: string | null;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: BedrockConverseAgentTokenUsage;
  override readonly cause?: unknown;
  readonly providerStatus: number | null;
  readonly retryable: boolean | null;
  readonly providerCode: string | null;
  readonly events: BedrockConverseAgentEvent[];
  readonly requestIds: string[];
  readonly routedProviders: string[];
  readonly reportedCostUsd: number | null;
  readonly tokenUsage: BedrockConverseAgentTokenUsage;

  constructor(
    message: string,
    readonly code: BedrockConverseAgentErrorCode,
    options: BedrockConverseAgentErrorOptions = {},
  ) {
    super(message);
    this.name = "BedrockConverseAgentError";
    this.stopReason = options.stopReason ?? null;
    this.iterations = options.iterations ?? 0;
    this.toolCalls = options.toolCalls ?? 0;
    this.usage = options.usage ?? emptyTokenUsage();
    this.cause = options.cause;
    this.providerStatus = options.providerStatus ?? null;
    this.retryable = options.retryable ?? null;
    this.providerCode = options.providerCode ?? null;
    this.events = options.events ?? [];
    this.requestIds = options.requestIds ?? [];
    this.routedProviders = options.routedProviders ?? [];
    this.reportedCostUsd = options.reportedCostUsd ?? null;
    this.tokenUsage = this.usage;
  }
}

export class BedrockConverseModelCapabilityError extends BedrockConverseAgentError {
  constructor(message: string, options: BedrockConverseAgentErrorOptions = {}) {
    super(message, "model_capability_error", options);
    this.name = "BedrockConverseModelCapabilityError";
  }
}

export class BedrockConverseProviderError extends BedrockConverseAgentError {
  constructor(message: string, options: BedrockConverseAgentErrorOptions = {}) {
    super(message, "provider_error", options);
    this.name = "BedrockConverseProviderError";
  }
}

export class BedrockConverseLimitError extends BedrockConverseAgentError {
  constructor(
    message: string,
    code:
      | "iteration_limit_exceeded"
      | "tool_call_limit_exceeded"
      | "token_limit_exceeded"
      | "output_token_limit_reached",
    readonly limit: number,
    readonly actual: number,
    options: BedrockConverseAgentErrorOptions = {},
  ) {
    super(message, code, options);
    this.name = "BedrockConverseLimitError";
  }
}

function emptyTokenUsage(): BedrockConverseAgentTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}

export function bedrockConverseAgentSemanticTokenCount(
  usage: Pick<
    BedrockConverseAgentTokenUsage,
    "totalTokens" | "outputTokens" | "cacheReadInputTokens"
  >,
) {
  return Math.max(
    usage.outputTokens,
    usage.totalTokens - usage.cacheReadInputTokens,
  );
}

function normalizeTokenCount(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? 0) : 0;
}

function normalizeTokenUsage(usage: TokenUsage | null): BedrockConverseAgentTokenUsage {
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);
  const reportedTotal = normalizeTokenCount(usage?.totalTokens);

  const extendedUsage = usage as
    | (TokenUsage & {
        reasoningTokens?: number;
        cost?: number;
        unknownUsageAttempts?: number;
        failedAttempts?: JsonValue[];
        providerAttemptCount?: number;
        costedAttemptCount?: number;
        routedProvider?: string | null;
        attempts?: unknown[];
      })
    | null;
  const nestedUsage = Array.isArray(extendedUsage?.attempts)
    ? extendedUsage.attempts.reduce<BedrockConverseAgentTokenUsage>(
        (aggregate, attempt) =>
          addTokenUsage(
            aggregate,
            normalizeTokenUsage(attempt as TokenUsage),
          ),
        emptyTokenUsage(),
      )
    : null;
  const reasoningTokens = normalizeTokenCount(extendedUsage?.reasoningTokens);
  const costUsd =
    typeof extendedUsage?.cost === "number" &&
    Number.isFinite(extendedUsage.cost) &&
    extendedUsage.cost >= 0
      ? extendedUsage.cost
      : null;
  const unknownUsageAttempts = normalizeTokenCount(
    extendedUsage?.unknownUsageAttempts,
  );
  const failedAttempts = Array.isArray(extendedUsage?.failedAttempts)
    ? extendedUsage.failedAttempts
    : [];
  const explicitProviderAttemptCount = normalizeTokenCount(
    extendedUsage?.providerAttemptCount,
  );
  const providerAttemptCount =
    explicitProviderAttemptCount ||
    nestedUsage?.providerAttemptCount ||
    0;
  const additionalProviderAttemptCount = nestedUsage
    ? Math.max(
        0,
        providerAttemptCount - (nestedUsage.providerAttemptCount ?? 0),
      )
    : providerAttemptCount;
  const costedAttemptCount =
    normalizeTokenCount(extendedUsage?.costedAttemptCount) ||
    nestedUsage?.costedAttemptCount ||
    (costUsd != null ? 1 : 0);
  const additionalCostedAttemptCount = nestedUsage
    ? Math.max(
        0,
        costedAttemptCount - (nestedUsage.costedAttemptCount ?? 0),
      )
    : costedAttemptCount;
  const routedProviders = Array.from(new Set([
    ...(nestedUsage?.routedProviders ?? []),
    ...(typeof extendedUsage?.routedProvider === "string" &&
    extendedUsage.routedProvider.trim()
      ? [extendedUsage.routedProvider.trim()]
      : []),
  ]));

  return addTokenUsage(nestedUsage ?? emptyTokenUsage(), {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
    cacheReadInputTokens: normalizeTokenCount(usage?.cacheReadInputTokens),
    cacheWriteInputTokens: normalizeTokenCount(usage?.cacheWriteInputTokens),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(costUsd != null ? { costUsd } : {}),
    ...(unknownUsageAttempts ? { unknownUsageAttempts } : {}),
    ...(failedAttempts.length ? { failedAttempts } : {}),
    ...(additionalProviderAttemptCount
      ? { providerAttemptCount: additionalProviderAttemptCount }
      : {}),
    ...(additionalCostedAttemptCount
      ? { costedAttemptCount: additionalCostedAttemptCount }
      : {}),
    ...(routedProviders.length ? { routedProviders } : {}),
  });
}

function uniqueStrings(values: readonly string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function providerAttemptCountForAddition(
  aggregate: BedrockConverseAgentTokenUsage,
  next: BedrockConverseAgentTokenUsage,
) {
  return (
    (aggregate.providerAttemptCount ?? 0) +
    (next.providerAttemptCount ?? 0)
  );
}

function routedProvidersForAddition(
  aggregate: BedrockConverseAgentTokenUsage,
  next: BedrockConverseAgentTokenUsage,
) {
  return uniqueStrings([
    ...(aggregate.routedProviders ?? []),
    ...(next.routedProviders ?? []),
  ]);
}

function usageAdditionMetadata(
  aggregate: BedrockConverseAgentTokenUsage,
  next: BedrockConverseAgentTokenUsage,
) {
  const providerAttemptCount = providerAttemptCountForAddition(
    aggregate,
    next,
  );
  const routedProviders = routedProvidersForAddition(aggregate, next);
  const costedAttemptCount =
    (aggregate.costedAttemptCount ?? 0) +
    (next.costedAttemptCount ?? 0);
  return {
    ...(providerAttemptCount ? { providerAttemptCount } : {}),
    ...(costedAttemptCount ? { costedAttemptCount } : {}),
    ...(routedProviders.length ? { routedProviders } : {}),
  };
}

function addTokenUsage(
  aggregate: BedrockConverseAgentTokenUsage,
  next: BedrockConverseAgentTokenUsage,
): BedrockConverseAgentTokenUsage {
  const reasoningTokens =
    (aggregate.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  const hasCost =
    typeof aggregate.costUsd === "number" ||
    typeof next.costUsd === "number";
  const costUsd = (aggregate.costUsd ?? 0) + (next.costUsd ?? 0);
  const unknownUsageAttempts =
    (aggregate.unknownUsageAttempts ?? 0) +
    (next.unknownUsageAttempts ?? 0);
  const failedAttempts = [
    ...(aggregate.failedAttempts ?? []),
    ...(next.failedAttempts ?? []),
  ];
  return {
    inputTokens: aggregate.inputTokens + next.inputTokens,
    outputTokens: aggregate.outputTokens + next.outputTokens,
    totalTokens: aggregate.totalTokens + next.totalTokens,
    cacheReadInputTokens:
      aggregate.cacheReadInputTokens + next.cacheReadInputTokens,
    cacheWriteInputTokens:
      aggregate.cacheWriteInputTokens + next.cacheWriteInputTokens,
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(hasCost ? { costUsd: Number(costUsd.toFixed(8)) } : {}),
    ...(unknownUsageAttempts ? { unknownUsageAttempts } : {}),
    ...(failedAttempts.length ? { failedAttempts } : {}),
    ...usageAdditionMetadata(aggregate, next),
  };
}

function truncate(value: string, maxLength = DEFAULT_EVENT_STRING_LIMIT) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function redactSensitiveString(value: string) {
  return SENSITIVE_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

/** Produces a bounded JSON value suitable for persisted progress and audit events. */
export function sanitizeBedrockConverseEventValue(value: unknown): JsonValue {
  const seen = new WeakSet<object>();

  function visit(current: unknown, depth: number): JsonValue {
    if (current == null) {
      return null;
    }

    if (typeof current === "string") {
      return truncate(redactSensitiveString(current));
    }

    if (typeof current === "number") {
      return Number.isFinite(current) ? current : String(current);
    }

    if (typeof current === "boolean") {
      return current;
    }

    if (typeof current === "bigint") {
      return current.toString();
    }

    if (typeof current !== "object") {
      return `[${typeof current}]`;
    }

    if (depth >= DEFAULT_EVENT_DEPTH_LIMIT) {
      return "[depth limit]";
    }

    if (seen.has(current)) {
      return "[circular]";
    }

    seen.add(current);

    if (current instanceof Date) {
      return current.toISOString();
    }

    if (Array.isArray(current)) {
      const sanitized = current
        .slice(0, DEFAULT_EVENT_COLLECTION_LIMIT)
        .map((entry) => visit(entry, depth + 1));

      if (current.length > DEFAULT_EVENT_COLLECTION_LIMIT) {
        sanitized.push(`[${current.length - DEFAULT_EVENT_COLLECTION_LIMIT} more items]`);
      }

      return sanitized;
    }

    const entries = Object.entries(current)
      .slice(0, DEFAULT_EVENT_COLLECTION_LIMIT)
      .map(([key, nestedValue]) => [
        truncate(key, 128),
        SENSITIVE_KEY_PATTERN.test(key) &&
        !(SAFE_NUMERIC_USAGE_KEYS.has(key) && typeof nestedValue === "number")
          ? "[REDACTED]"
          : visit(nestedValue, depth + 1),
      ]);

    if (Object.keys(current).length > DEFAULT_EVENT_COLLECTION_LIMIT) {
      entries.push([
        "[truncated]",
        `${Object.keys(current).length - DEFAULT_EVENT_COLLECTION_LIMIT} more fields`,
      ]);
    }

    return Object.fromEntries(entries) as JsonValue;
  }

  return visit(value, 0);
}

function normalizeToolResult(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new Error("Tool result was not JSON serializable.");
  }

  return JSON.parse(serialized) as JsonValue;
}

function validationIssues(error: z.ZodError): JsonValue {
  return error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

function createToolError(code: string, message: string, issues?: JsonValue): JsonValue {
  return {
    error: {
      code,
      message,
      ...(issues ? { issues } : {}),
    },
  };
}

function safeToolErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = String(error.code);
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
}

function createToolResultBlock(params: {
  toolUseId: string;
  value: JsonValue;
}): ContentBlock {
  return {
    toolResult: {
      toolUseId: params.toolUseId,
      content: [
        {
          json: params.value as never,
        },
      ],
    },
  };
}

function readText(message: Message) {
  return (
    message.content
      ?.flatMap((block) => ("text" in block && block.text ? [block.text] : []))
      .join("\n")
      .trim() ?? ""
  );
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content ? [...message.content] : message.content,
  }));
}

function validateMessages(messages: readonly Message[]) {
  for (const [index, message] of messages.entries()) {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      !message.content?.length
    ) {
      throw new BedrockConverseAgentError(
        `Converse agent message ${index + 1} must have a user or assistant role and at least one content block.`,
        "configuration_error",
      );
    }
  }
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BedrockConverseAgentError(
      `${name} must be a positive safe integer.`,
      "configuration_error",
    );
  }

  return value;
}

function resolveLimits(
  overrides: Partial<BedrockConverseAgentLimits> | undefined,
  defaults: Partial<BedrockConverseAgentLimits> | undefined,
): BedrockConverseAgentLimits {
  const maxSemanticTokens =
    overrides?.maxSemanticTokens ?? defaults?.maxSemanticTokens;
  return {
    maxIterations: positiveInteger(
      overrides?.maxIterations ?? defaults?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      "maxIterations",
    ),
    maxToolCalls: positiveInteger(
      overrides?.maxToolCalls ?? defaults?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
      "maxToolCalls",
    ),
    maxTotalTokens: positiveInteger(
      overrides?.maxTotalTokens ?? defaults?.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
      "maxTotalTokens",
    ),
    ...(maxSemanticTokens === undefined ? {} : {
      maxSemanticTokens: positiveInteger(
        maxSemanticTokens,
        "maxSemanticTokens",
      ),
    }),
  };
}

function validateTools(tools: readonly BedrockConverseTool[]) {
  const names = new Set<string>();

  for (const tool of tools) {
    if (!tool.name.trim()) {
      throw new BedrockConverseAgentError(
        "Every Converse agent tool must have a non-empty name.",
        "configuration_error",
      );
    }

    if (names.has(tool.name)) {
      throw new BedrockConverseAgentError(
        `Converse agent tool names must be unique; received duplicate \"${truncate(tool.name, 128)}\".`,
        "configuration_error",
      );
    }

    if (tool.jsonSchema.type !== "object") {
      throw new BedrockConverseAgentError(
        `Tool \"${truncate(tool.name, 128)}\" must declare a top-level object JSON schema.`,
        "configuration_error",
      );
    }

    if (
      tool.maxRecoverableInvalidInputAttempts !== undefined &&
      (
        !Number.isSafeInteger(tool.maxRecoverableInvalidInputAttempts) ||
        tool.maxRecoverableInvalidInputAttempts < 0
      )
    ) {
      throw new BedrockConverseAgentError(
        `Tool \"${truncate(tool.name, 128)}\" maxRecoverableInvalidInputAttempts must be a non-negative safe integer.`,
        "configuration_error",
      );
    }

    names.add(tool.name);
  }
}

export function estimateBedrockConverseInputTokens(input: {
  systemPrompt?: string;
  messages: readonly Message[];
  tools?: readonly BedrockConverseTool[];
}) {
  const serialized = JSON.stringify({
    systemPrompt: input.systemPrompt ?? "",
    messages: input.messages,
    tools: (input.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      jsonSchema: tool.jsonSchema,
    })),
  });
  // This is deliberately conservative for mixed prose/JSON/tool payloads.
  // It is not billing telemetry; it prevents an obviously oversized follow-up
  // call before that call is sent to a provider.
  return Math.max(1, Math.ceil(serialized.length / 3));
}

function getProviderErrorName(error: unknown) {
  if (error && typeof error === "object" && "name" in error) {
    return String(error.name);
  }

  return "UnknownProviderError";
}

function getProviderErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return truncate(error.message.trim(), 1_000);
  }

  return "The model provider request failed without an error message.";
}

function isModelCapabilityError(error: unknown) {
  const name = getProviderErrorName(error);
  const message = getProviderErrorMessage(error);
  const declaredCapability =
    error &&
      typeof error === "object" &&
      "capability" in error &&
      typeof error.capability === "string"
      ? error.capability
      : null;
  const status =
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : null;

  if (/UnsupportedOperation|NotSupported/i.test(name)) {
    return true;
  }

  const isProviderValidationFailure =
    /ValidationException/i.test(name) ||
    (
      /OpenRouterRequestError/i.test(name) &&
      (status === 400 || status === 404 || status === 422)
    );
  if (!isProviderValidationFailure) {
    return false;
  }

  return (
    declaredCapability !== null ||
    /(?:does not|doesn't|not|isn't|unsupported|unavailable).{0,80}(?:support|available|enabled).{0,80}(?:chat|completion|converse|tool|function|parameter|response format|reasoning)/i.test(
      message,
    ) ||
    /(?:chat|completion|converse|tool|function|parameter|response format|reasoning).{0,80}(?:not supported|unsupported|unavailable|not enabled)/i.test(
      message,
    )
  );
}

function existingToolUseIds(messages: readonly Message[]) {
  const ids = new Set<string>();

  for (const message of messages) {
    for (const block of message.content ?? []) {
      if ("toolUse" in block && block.toolUse?.toolUseId) {
        ids.add(block.toolUse.toolUseId);
      }
    }
  }

  return ids;
}

interface RequestedToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

function readRequestedTools(
  message: Message,
  seenToolUseIds: Set<string>,
  state: BedrockConverseAgentErrorOptions,
): RequestedToolUse[] {
  const requestedTools: RequestedToolUse[] = [];

  for (const block of message.content ?? []) {
    if (!("toolUse" in block) || !block.toolUse) {
      continue;
    }

    const { toolUseId, name, input } = block.toolUse;

    if (!toolUseId || !name || input === undefined) {
      throw new BedrockConverseAgentError(
        "The model provider returned a malformed tool request without an ID, name, or input.",
        "protocol_error",
        state,
      );
    }

    if (seenToolUseIds.has(toolUseId)) {
      throw new BedrockConverseAgentError(
        `The model provider reused tool request ID \"${truncate(toolUseId, 128)}\".`,
        "protocol_error",
        state,
      );
    }

    seenToolUseIds.add(toolUseId);
    requestedTools.push({ toolUseId, name, input });
  }

  return requestedTools;
}

export class BedrockConverseAgent {
  constructor(
    private readonly transport: BedrockConverseTransport,
    private readonly config: {
      modelId: string;
      defaultLimits?: Partial<BedrockConverseAgentLimits>;
      providerLabel?: string;
      modelProfile?: string;
    },
  ) {
    if (!config.modelId.trim()) {
      throw new BedrockConverseAgentError(
        "A model ID is required for Converse agent runs.",
        "configuration_error",
      );
    }
  }

  private providerLabel() {
    return this.config.providerLabel?.trim() || "Bedrock";
  }

  static fromConfig(config: {
    provider: "bedrock";
    region: string;
    modelId: string;
    profile?: string;
    defaultLimits?: Partial<BedrockConverseAgentLimits>;
  }) {
    return new BedrockConverseAgent(
      new AwsBedrockConverseTransport({
        region: config.region,
        profile: config.profile,
      }),
      {
        modelId: config.modelId,
        defaultLimits: config.defaultLimits,
      },
    );
  }

  async run(input: BedrockConverseAgentRunInput): Promise<BedrockConverseAgentRunResult> {
    if (!input.messages.length) {
      throw new BedrockConverseAgentError(
        `A ${this.providerLabel()} agent run requires at least one message.`,
        "configuration_error",
      );
    }

    const maxTokens = positiveInteger(
      input.maxTokens ?? DEFAULT_MAX_TOKENS_PER_ITERATION,
      "maxTokens",
    );
    const temperature = input.temperature ?? 0;

    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      throw new BedrockConverseAgentError(
        "temperature must be between 0 and 1.",
        "configuration_error",
      );
    }

    const limits = resolveLimits(input.limits, this.config.defaultLimits);
    const tools = input.tools ?? [];
    validateMessages(input.messages);
    validateTools(tools);

    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const messages = cloneMessages(input.messages);
    const seenToolUseIds = existingToolUseIds(messages);
    const events: BedrockConverseAgentEvent[] = [];
    let aggregateUsage = emptyTokenUsage();
    let actualProvider: string | undefined;
    const routedProviders = new Set<string>();
    let actualModelId: string | undefined;
    let reportedCostUsd = 0;
    let hasReportedCost = false;
    const requestIds: string[] = [];
    const invalidInputAttemptsByTool = new Map<string, number>();
    let emptyToolUseRecoveryCount = 0;
    let iterations = 0;
    let toolCalls = 0;

    const emit = async (event: BedrockConverseAgentEvent) => {
      events.push(event);
      await input.onEvent?.(event);
    };
    const failureOptions = (
      options: BedrockConverseAgentErrorOptions = {},
    ): BedrockConverseAgentErrorOptions => ({
      ...options,
      events: [...events],
      requestIds: [...requestIds],
      routedProviders: Array.from(routedProviders),
      reportedCostUsd:
        hasReportedCost && (aggregateUsage.unknownUsageAttempts ?? 0) === 0
          ? Number(reportedCostUsd.toFixed(8))
          : null,
    });

    while (true) {
      if (iterations >= limits.maxIterations) {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} agent exceeded its ${limits.maxIterations}-iteration limit.`,
          "iteration_limit_exceeded",
          limits.maxIterations,
          iterations + 1,
          failureOptions({ iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (iterations > 0) {
        const estimatedNextInputTokens = estimateBedrockConverseInputTokens({
          systemPrompt: input.systemPrompt,
          messages,
          tools,
        });
        const projectedTotalTokens =
          aggregateUsage.totalTokens + estimatedNextInputTokens;
        if (projectedTotalTokens > limits.maxTotalTokens) {
          throw new BedrockConverseLimitError(
            `${this.providerLabel()} agent stopped before an oversized follow-up model call would exceed its ${limits.maxTotalTokens}-token budget.`,
            "token_limit_exceeded",
            limits.maxTotalTokens,
            projectedTotalTokens,
            failureOptions({ iterations, toolCalls, usage: aggregateUsage }),
          );
        }
      }

      const nextIteration = iterations + 1;
      const requestedForcedToolName = input.forceTool?.({
        iteration: nextIteration,
        toolCalls,
      });
      const forcedToolName = requestedForcedToolName?.trim() || null;
      if (requestedForcedToolName != null && !forcedToolName) {
        throw new BedrockConverseAgentError(
          "A forced Converse tool name must be non-empty.",
          "configuration_error",
          failureOptions({ iterations, toolCalls, usage: aggregateUsage }),
        );
      }
      if (forcedToolName && !toolByName.has(forcedToolName)) {
        throw new BedrockConverseAgentError(
          `Cannot force unknown Converse tool "${truncate(forcedToolName, 128)}".`,
          "configuration_error",
          failureOptions({ iterations, toolCalls, usage: aggregateUsage }),
        );
      }
      iterations = nextIteration;
      const reasoningEffort = !forcedToolName ||
          this.transport.supportsReasoningWithForcedTool === true
        ? input.effort
        : undefined;
      await emit({
        type: "model_call_started",
        iteration: iterations,
        messageCount: messages.length,
        ...(this.config.modelProfile
          ? { profile: this.config.modelProfile }
          : {}),
      });

      let response: BedrockConverseTransportResponse;
      const providerStartedAt = Date.now();

      try {
        const cachePoint = { cachePoint: { type: "default" as const } };
        response = await this.transport.converse(
          {
            modelId: this.config.modelId,
            system: input.systemPrompt
              ? [
                  {
                    text: input.systemPrompt,
                  },
                  ...(input.enablePromptCaching ? [cachePoint] : []),
                ]
              : undefined,
            messages,
            inferenceConfig: {
              maxTokens,
              temperature: reasoningEffort ? 1 : temperature,
            },
            toolConfig: tools.length
              ? {
                  tools: [
                    ...tools.map((tool) => ({
                      toolSpec: {
                        name: tool.name,
                        description: tool.description,
                        inputSchema: {
                          json: toBedrockCompatibleJsonSchema(tool.jsonSchema) as never,
                        },
                        strict: tool.strict,
                      },
                    })),
                    ...(input.enablePromptCaching ? [cachePoint] : []),
                  ],
                  ...(forcedToolName
                    ? { toolChoice: { tool: { name: forcedToolName } } }
                    : {}),
                }
              : undefined,
            additionalModelRequestFields: reasoningEffort
              ? {
                  thinking: { type: "adaptive" },
                  output_config: { effort: reasoningEffort },
                }
              : undefined,
          },
          { signal: input.signal },
        );
      } catch (error) {
        if (
          input.signal?.aborted ||
          (
            error &&
            typeof error === "object" &&
            "name" in error &&
            String(error.name) === "AbortError"
          )
        ) {
          throw error;
        }
        const providerFailure = error && typeof error === "object"
          ? error as {
              status?: unknown;
              retryable?: unknown;
              code?: unknown;
              requestId?: unknown;
              tokenUsage?: unknown;
              unknownUsageAttempts?: unknown;
              providerAttemptCount?: unknown;
              failedAttempts?: unknown;
            }
          : null;
        let failureUsage = normalizeTokenUsage(
          (providerFailure?.tokenUsage ?? null) as TokenUsage | null,
        );
        const reportedUnknownAttempts =
          typeof providerFailure?.unknownUsageAttempts === "number"
            ? Math.max(
                0,
                Math.floor(providerFailure.unknownUsageAttempts),
              )
            : providerFailure?.tokenUsage
              ? 0
              : 1;
        const reportedProviderAttempts = normalizeTokenCount(
          typeof providerFailure?.providerAttemptCount === "number"
            ? providerFailure.providerAttemptCount
            : undefined,
        ) || 1;
        const failedAttempts = Array.isArray(
          providerFailure?.failedAttempts,
        )
          ? providerFailure.failedAttempts.map((attempt) =>
              sanitizeBedrockConverseEventValue(attempt)
            )
          : [];
        failureUsage = addTokenUsage(failureUsage, {
          ...emptyTokenUsage(),
          unknownUsageAttempts: Math.max(
            0,
            reportedUnknownAttempts -
              (failureUsage.unknownUsageAttempts ?? 0),
          ),
          providerAttemptCount: Math.max(
            0,
            reportedProviderAttempts -
              (failureUsage.providerAttemptCount ?? 0),
          ),
          ...(failedAttempts.length ? { failedAttempts } : {}),
        });
        aggregateUsage = addTokenUsage(aggregateUsage, failureUsage);
        const failureRequestIds = uniqueStrings([
          ...(typeof providerFailure?.requestId === "string"
            ? [providerFailure.requestId]
            : []),
          ...failedAttempts.flatMap((attempt) =>
            attempt &&
            typeof attempt === "object" &&
            !Array.isArray(attempt) &&
            typeof attempt.requestId === "string"
              ? [attempt.requestId]
              : []
          ),
        ]);
        failureRequestIds.forEach((requestId) => {
          if (!requestIds.includes(requestId)) requestIds.push(requestId);
        });
        for (const routedProvider of failureUsage.routedProviders ?? []) {
          routedProviders.add(routedProvider);
        }
        await emit({
          type: "model_call_failed",
          iteration: iterations,
          durationMs: Math.max(0, Date.now() - providerStartedAt),
          usage: failureUsage,
          aggregateUsage,
          provider: this.providerLabel().toLowerCase(),
          modelId: this.config.modelId,
          requestIds: failureRequestIds,
          routedProviders: failureUsage.routedProviders ?? [],
          providerStatus:
            typeof providerFailure?.status === "number"
              ? providerFailure.status
              : null,
          retryable:
            typeof providerFailure?.retryable === "boolean"
              ? providerFailure.retryable
              : null,
          providerCode:
            typeof providerFailure?.code === "string"
              ? providerFailure.code
              : null,
          ...(this.config.modelProfile
            ? { profile: this.config.modelProfile }
            : {}),
        });
        const providerName = getProviderErrorName(error);
        const providerMessage = getProviderErrorMessage(error);
        const errorState = failureOptions({
          iterations,
          toolCalls,
          usage: aggregateUsage,
          cause: error,
          providerStatus:
            typeof providerFailure?.status === "number"
              ? providerFailure.status
              : null,
          retryable:
            typeof providerFailure?.retryable === "boolean"
              ? providerFailure.retryable
              : null,
          providerCode:
            typeof providerFailure?.code === "string"
              ? providerFailure.code
              : null,
        });

        if (providerFailure?.code === "response_blocked") {
          throw new BedrockConverseAgentError(
            `${this.providerLabel()} blocked the response for safety or content-policy reasons.`,
            "response_blocked",
            errorState,
          );
        }

        if (isModelCapabilityError(error)) {
          throw new BedrockConverseModelCapabilityError(
            `${this.providerLabel()} model \"${this.config.modelId}\" rejected the request as unsupported. Configure a model that supports the required chat completion${tools.length ? " and tool use" : ""}. Provider response (${providerName}): ${providerMessage}`,
            errorState,
          );
        }

        throw new BedrockConverseProviderError(
          `${this.providerLabel()} request failed for model \"${this.config.modelId}\" (${providerName}): ${providerMessage}`,
          errorState,
        );
      }

      const iterationUsage = normalizeTokenUsage(response.usage);
      const responseProvider =
        response.provider ?? this.providerLabel().toLowerCase();
      const unreportedOpenRouterUsageAttempts =
        responseProvider.toLowerCase() === "openrouter"
          ? Math.max(
              0,
              (iterationUsage.providerAttemptCount ?? 1) -
                (iterationUsage.costedAttemptCount ?? 0) -
                (iterationUsage.unknownUsageAttempts ?? 0),
            )
          : 0;
      if (unreportedOpenRouterUsageAttempts) {
        iterationUsage.unknownUsageAttempts =
          (iterationUsage.unknownUsageAttempts ?? 0) +
          unreportedOpenRouterUsageAttempts;
      }
      aggregateUsage = addTokenUsage(aggregateUsage, iterationUsage);
      const stopReason = response.stopReason;
      actualProvider = response.provider ?? actualProvider;
      if (response.routedProvider) {
        routedProviders.add(response.routedProvider);
      }
      for (const routedProvider of iterationUsage.routedProviders ?? []) {
        routedProviders.add(routedProvider);
      }
      actualModelId = response.modelId ?? actualModelId;
      if (response.requestId) requestIds.push(response.requestId);
      if (typeof iterationUsage.costUsd === "number") {
        reportedCostUsd += iterationUsage.costUsd;
        hasReportedCost = true;
      }

      await emit({
        type: "model_call_completed",
        iteration: iterations,
        stopReason: stopReason ?? "missing",
        requestId: response.requestId,
        durationMs: Math.max(0, Date.now() - providerStartedAt),
        usage: iterationUsage,
        aggregateUsage,
        ...(response.provider ? { provider: response.provider } : {}),
        ...(response.routedProvider
          ? { routedProvider: response.routedProvider }
          : {}),
        ...(response.modelId ? { modelId: response.modelId } : {}),
        ...(response.costUsd != null ? { costUsd: response.costUsd } : {}),
        ...(this.config.modelProfile
          ? { profile: this.config.modelProfile }
          : {}),
      });

      if (!stopReason) {
        throw new BedrockConverseProviderError(
          `${this.providerLabel()} response did not include a stop reason.`,
          failureOptions({
            iterations,
            toolCalls,
            usage: aggregateUsage,
            retryable: true,
            providerCode: "incomplete_response",
          }),
        );
      }

      const recoverableEmptyToolUseMessage =
        stopReason === "tool_use" &&
        response.message?.role === "assistant" &&
        Array.isArray(response.message.content) &&
        response.message.content.length === 0;
      if (
        !response.message ||
        response.message.role !== "assistant" ||
        (
          !response.message.content?.length &&
          !recoverableEmptyToolUseMessage
        )
      ) {
        throw new BedrockConverseProviderError(
          `${this.providerLabel()} response did not include a complete assistant message.`,
          failureOptions({
            stopReason,
            iterations,
            toolCalls,
            usage: aggregateUsage,
            retryable: true,
            providerCode: "incomplete_response",
          }),
        );
      }

      messages.push(response.message);

      const semanticTokens = bedrockConverseAgentSemanticTokenCount(
        aggregateUsage,
      );
      const semanticTokenLimitExceeded =
        limits.maxSemanticTokens !== undefined &&
        semanticTokens > limits.maxSemanticTokens;
      const responseToolRequests = (response.message.content ?? []).flatMap(
        (block) =>
          "toolUse" in block && block.toolUse ? [block.toolUse] : [],
      );
      const soleResponseToolRequest =
        responseToolRequests.length === 1 ? responseToolRequests[0] : null;
      const soleResponseTool = soleResponseToolRequest?.name
        ? toolByName.get(soleResponseToolRequest.name)
        : undefined;
      const canDeferPostResponseTokenLimit =
        stopReason === "tool_use" &&
        Boolean(
          soleResponseToolRequest?.toolUseId &&
          soleResponseToolRequest.input !== undefined &&
          soleResponseTool?.isTerminalResult,
        );

      if (semanticTokenLimitExceeded && !canDeferPostResponseTokenLimit) {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} agent exceeded its ${limits.maxSemanticTokens}-semantic-token budget before completing an answer.`,
          "token_limit_exceeded",
          limits.maxSemanticTokens!,
          semanticTokens,
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (stopReason === "end_turn" || stopReason === "stop_sequence") {
        if (forcedToolName) {
          throw new BedrockConverseAgentError(
            `${this.providerLabel()} completed a turn without calling forced tool "${truncate(forcedToolName, 128)}".`,
            "protocol_error",
            failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
          );
        }
        const unexpectedToolUse = (response.message.content ?? []).some(
          (block) => "toolUse" in block && block.toolUse,
        );

        if (unexpectedToolUse) {
          throw new BedrockConverseAgentError(
            `${this.providerLabel()} returned tool requests with stop reason \"${stopReason}\".`,
            "protocol_error",
            failureOptions({
              stopReason,
              iterations,
              toolCalls,
              usage: aggregateUsage,
            }),
          );
        }

        return {
          text: readText(response.message),
          assistantMessage: response.message,
          messages,
          stopReason,
          iterations,
          toolCalls,
          usage: aggregateUsage,
          events,
          ...(actualProvider ? { provider: actualProvider } : {}),
          ...(routedProviders.size
            ? { routedProviders: Array.from(routedProviders) }
            : {}),
          ...(actualModelId ? { modelId: actualModelId } : {}),
          ...(requestIds.length ? { requestIds } : {}),
          ...(hasReportedCost
            ? {
                reportedCostUsd:
                  (aggregateUsage.unknownUsageAttempts ?? 0) === 0
                    ? Number(reportedCostUsd.toFixed(8))
                    : null,
              }
            : {}),
        };
      }

      const totalTokenLimitExceeded =
        aggregateUsage.totalTokens > limits.maxTotalTokens;
      if (totalTokenLimitExceeded && !canDeferPostResponseTokenLimit) {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} agent exceeded its ${limits.maxTotalTokens}-token budget before completing an answer.`,
          "token_limit_exceeded",
          limits.maxTotalTokens,
          aggregateUsage.totalTokens,
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (stopReason === "max_tokens") {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} model \"${this.config.modelId}\" reached the per-iteration output limit of ${maxTokens} tokens.`,
          "output_token_limit_reached",
          maxTokens,
          iterationUsage.outputTokens,
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (
        stopReason === "guardrail_intervened" ||
        stopReason === "content_filtered"
      ) {
        throw new BedrockConverseAgentError(
          `${this.providerLabel()} did not complete the response because ${stopReason.replaceAll("_", " ")}.`,
          "response_blocked",
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (
        stopReason === "malformed_model_output" ||
        stopReason === "malformed_tool_use"
      ) {
        throw new BedrockConverseAgentError(
          `${this.providerLabel()} stopped after producing ${stopReason.replaceAll("_", " ")}.`,
          "malformed_model_response",
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (stopReason === "model_context_window_exceeded") {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} model \"${this.config.modelId}\" exceeded its context window. Reduce the conversation or retrieved context.`,
          "token_limit_exceeded",
          limits.maxTotalTokens,
          aggregateUsage.totalTokens,
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (stopReason !== "tool_use") {
        throw new BedrockConverseAgentError(
          `${this.providerLabel()} returned unsupported stop reason \"${truncate(stopReason, 128)}\".`,
          "protocol_error",
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      const requestedTools = readRequestedTools(
        response.message,
        seenToolUseIds,
        failureOptions({
          stopReason,
          iterations,
          toolCalls,
          usage: aggregateUsage,
        }),
      );

      if (!requestedTools.length) {
        if (
          tools.length > 0 &&
          emptyToolUseRecoveryCount < MAX_EMPTY_TOOL_USE_RECOVERIES
        ) {
          emptyToolUseRecoveryCount += 1;
          messages.push({
            role: "user",
            content: [{
              text: forcedToolName
                ? `Your previous response indicated tool use but did not include a valid tool request. Call the required tool "${forcedToolName}" now with an ID, its exact name, and JSON input matching its schema. Do not narrate.`
                : "Your previous response indicated tool use but did not include a valid tool request. Call exactly one available tool now with an ID, its exact name, and JSON input matching its schema. Do not narrate.",
            }],
          });
          continue;
        }
        throw new BedrockConverseAgentError(
          `${this.providerLabel()} stopped for tool use without returning a tool request.`,
          "protocol_error",
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      const terminalCapableRequests = requestedTools.filter(
        (requestedTool) =>
          Boolean(toolByName.get(requestedTool.name)?.isTerminalResult),
      );
      if (terminalCapableRequests.length && requestedTools.length !== 1) {
        throw new BedrockConverseAgentError(
          `${this.providerLabel()} returned a terminal-capable tool request together with another tool request. Terminal-capable tools must be called alone.`,
          "protocol_error",
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (
        forcedToolName &&
        (
          requestedTools.length !== 1 ||
          requestedTools[0]?.name !== forcedToolName
        )
      ) {
        throw new BedrockConverseAgentError(
          `${this.providerLabel()} did not call forced tool "${truncate(forcedToolName, 128)}" exactly once.`,
          "protocol_error",
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (toolCalls + requestedTools.length > limits.maxToolCalls) {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} agent would exceed its ${limits.maxToolCalls}-tool-call limit.`,
          "tool_call_limit_exceeded",
          limits.maxToolCalls,
          toolCalls + requestedTools.length,
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      const toolResults: ContentBlock[] = [];
      let terminalTool: BedrockConverseAgentRunResult["terminalTool"];

      for (const requestedTool of requestedTools) {
        toolCalls += 1;
        const startedAt = Date.now();
        const safeToolUseId = truncate(
          redactSensitiveString(requestedTool.toolUseId),
          128,
        );
        const safeToolName = truncate(redactSensitiveString(requestedTool.name), 128);

        await emit({
          type: "tool_call_started",
          iteration: iterations,
          toolCall: toolCalls,
          toolUseId: safeToolUseId,
          toolName: safeToolName,
          input: sanitizeBedrockConverseEventValue(requestedTool.input),
        });

        const tool = toolByName.get(requestedTool.name);
        let outcome: BedrockConverseToolOutcome;
        let modelResult: JsonValue;
        let isTerminalResult = false;
        let terminalPredicateFailed = false;
        let terminalPredicateCause: unknown;
        let invalidInputRecoveryExceeded = false;
        let invalidInputAttemptCount = 0;

        if (!tool) {
          outcome = "unknown_tool";
          modelResult = createToolError(
            "unknown_tool",
            `No tool named \"${safeToolName}\" is available.`,
          );
        } else {
          const parsedInput = tool.inputSchema.safeParse(requestedTool.input);

          if (!parsedInput.success) {
            outcome = "invalid_input";
            invalidInputAttemptCount =
              (invalidInputAttemptsByTool.get(requestedTool.name) ?? 0) + 1;
            invalidInputAttemptsByTool.set(
              requestedTool.name,
              invalidInputAttemptCount,
            );
            invalidInputRecoveryExceeded =
              tool.maxRecoverableInvalidInputAttempts !== undefined &&
              invalidInputAttemptCount >
                tool.maxRecoverableInvalidInputAttempts;
            modelResult = createToolError(
              "invalid_tool_input",
              `Input for tool \"${safeToolName}\" did not match its schema.`,
              validationIssues(parsedInput.error),
            );
          } else {
            try {
              modelResult = normalizeToolResult(
                await tool.execute(parsedInput.data, {
                  iteration: iterations,
                  toolCall: toolCalls,
                  toolUseId: requestedTool.toolUseId,
                  signal: input.signal,
                }),
              );
              outcome = "success";
            } catch (error) {
              outcome = "execution_error";
              const errorCode = safeToolErrorCode(error);
              modelResult = createToolError(
                errorCode ?? "tool_execution_failed",
                errorCode
                  ? `Tool \"${safeToolName}\" failed with ${errorCode}.`
                  : `Tool \"${safeToolName}\" failed.`,
              );
            }
          }
        }

        if (outcome === "success" && tool?.isTerminalResult) {
          try {
            isTerminalResult = tool.isTerminalResult(modelResult);
          } catch (error) {
            terminalPredicateFailed = true;
            terminalPredicateCause = error;
          }
        }

        toolResults.push(
          createToolResultBlock({
            toolUseId: requestedTool.toolUseId,
            value: modelResult,
          }),
        );

        await emit({
          type: "tool_call_completed",
          iteration: iterations,
          toolCall: toolCalls,
          toolUseId: safeToolUseId,
          toolName: safeToolName,
          outcome,
          durationMs: Math.max(0, Date.now() - startedAt),
          output: sanitizeBedrockConverseEventValue(modelResult),
        });

        if (invalidInputRecoveryExceeded) {
          throw new BedrockConverseAgentError(
            `Tool \"${safeToolName}\" exceeded its ${tool?.maxRecoverableInvalidInputAttempts}-attempt malformed-input recovery allowance on invalid call ${invalidInputAttemptCount}.`,
            "protocol_error",
            failureOptions({
              stopReason,
              iterations,
              toolCalls,
              usage: aggregateUsage,
            }),
          );
        }

        if (terminalPredicateFailed) {
          throw new BedrockConverseAgentError(
            `Terminal-result predicate for tool "${safeToolName}" failed after the tool completed successfully.`,
            "configuration_error",
            failureOptions({
              stopReason,
              iterations,
              toolCalls,
              usage: aggregateUsage,
              cause: terminalPredicateCause,
            }),
          );
        }

        if (isTerminalResult) {
          terminalTool = {
            name: requestedTool.name,
            toolUseId: requestedTool.toolUseId,
          };
        }
      }

      messages.push({
        role: "user",
        content: toolResults,
      });

      if (terminalTool) {
        return {
          text: readText(response.message),
          assistantMessage: response.message,
          messages,
          stopReason: "tool_use",
          terminalTool,
          iterations,
          toolCalls,
          usage: aggregateUsage,
          events,
          ...(actualProvider ? { provider: actualProvider } : {}),
          ...(routedProviders.size
            ? { routedProviders: Array.from(routedProviders) }
            : {}),
          ...(actualModelId ? { modelId: actualModelId } : {}),
          ...(requestIds.length ? { requestIds } : {}),
          ...(hasReportedCost
            ? {
                reportedCostUsd:
                  (aggregateUsage.unknownUsageAttempts ?? 0) === 0
                    ? Number(reportedCostUsd.toFixed(8))
                    : null,
              }
            : {}),
        };
      }

      if (semanticTokenLimitExceeded) {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} agent exceeded its ${limits.maxSemanticTokens}-semantic-token budget before completing an answer.`,
          "token_limit_exceeded",
          limits.maxSemanticTokens!,
          semanticTokens,
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }

      if (totalTokenLimitExceeded) {
        throw new BedrockConverseLimitError(
          `${this.providerLabel()} agent exceeded its ${limits.maxTotalTokens}-token budget before completing an answer.`,
          "token_limit_exceeded",
          limits.maxTotalTokens,
          aggregateUsage.totalTokens,
          failureOptions({ stopReason, iterations, toolCalls, usage: aggregateUsage }),
        );
      }
    }
  }
}
