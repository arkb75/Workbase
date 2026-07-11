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
const DEFAULT_EVENT_STRING_LIMIT = 512;
const DEFAULT_EVENT_COLLECTION_LIMIT = 20;
const DEFAULT_EVENT_DEPTH_LIMIT = 5;

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|credential|password|passwd|secret|private.?key|api.?key|token)/i;
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
}

export interface BedrockConverseTransport {
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
}

export interface BedrockConverseAgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
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
    }
  | {
      type: "model_call_completed";
      iteration: number;
      stopReason: string;
      requestId: string | null;
      usage: BedrockConverseAgentTokenUsage;
      aggregateUsage: BedrockConverseAgentTokenUsage;
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
  onEvent?: (event: BedrockConverseAgentEvent) => void | Promise<void>;
}

export interface BedrockConverseAgentRunResult {
  text: string;
  assistantMessage: Message;
  messages: Message[];
  stopReason: "end_turn" | "stop_sequence";
  iterations: number;
  toolCalls: number;
  usage: BedrockConverseAgentTokenUsage;
  events: BedrockConverseAgentEvent[];
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
}

export class BedrockConverseAgentError extends Error {
  readonly stopReason: string | null;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: BedrockConverseAgentTokenUsage;
  override readonly cause?: unknown;

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

function normalizeTokenCount(value: number | undefined) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? 0) : 0;
}

function normalizeTokenUsage(usage: TokenUsage | null): BedrockConverseAgentTokenUsage {
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);
  const reportedTotal = normalizeTokenCount(usage?.totalTokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
    cacheReadInputTokens: normalizeTokenCount(usage?.cacheReadInputTokens),
    cacheWriteInputTokens: normalizeTokenCount(usage?.cacheWriteInputTokens),
  };
}

function addTokenUsage(
  aggregate: BedrockConverseAgentTokenUsage,
  next: BedrockConverseAgentTokenUsage,
): BedrockConverseAgentTokenUsage {
  return {
    inputTokens: aggregate.inputTokens + next.inputTokens,
    outputTokens: aggregate.outputTokens + next.outputTokens,
    totalTokens: aggregate.totalTokens + next.totalTokens,
    cacheReadInputTokens:
      aggregate.cacheReadInputTokens + next.cacheReadInputTokens,
    cacheWriteInputTokens:
      aggregate.cacheWriteInputTokens + next.cacheWriteInputTokens,
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
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : visit(nestedValue, depth + 1),
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
        `Bedrock Converse message ${index + 1} must have a user or assistant role and at least one content block.`,
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
  };
}

function validateTools(tools: readonly BedrockConverseTool[]) {
  const names = new Set<string>();

  for (const tool of tools) {
    if (!tool.name.trim()) {
      throw new BedrockConverseAgentError(
        "Every Bedrock Converse tool must have a non-empty name.",
        "configuration_error",
      );
    }

    if (names.has(tool.name)) {
      throw new BedrockConverseAgentError(
        `Bedrock Converse tool names must be unique; received duplicate \"${truncate(tool.name, 128)}\".`,
        "configuration_error",
      );
    }

    if (tool.jsonSchema.type !== "object") {
      throw new BedrockConverseAgentError(
        `Tool \"${truncate(tool.name, 128)}\" must declare a top-level object JSON schema.`,
        "configuration_error",
      );
    }

    names.add(tool.name);
  }
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

  return "The Bedrock Converse request failed without an error message.";
}

function isModelCapabilityError(error: unknown) {
  const name = getProviderErrorName(error);
  const message = getProviderErrorMessage(error);

  if (/UnsupportedOperation|NotSupported/i.test(name)) {
    return true;
  }

  if (!/ValidationException/i.test(name)) {
    return false;
  }

  return (
    /(?:does not|doesn't|not|isn't|unsupported|unavailable).{0,80}(?:support|available|enabled).{0,80}(?:converse|tool|function)/i.test(
      message,
    ) ||
    /(?:converse|tool|function).{0,80}(?:not supported|unsupported|unavailable|not enabled)/i.test(
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
        "Bedrock returned a malformed tool request without an ID, name, or input.",
        "protocol_error",
        state,
      );
    }

    if (seenToolUseIds.has(toolUseId)) {
      throw new BedrockConverseAgentError(
        `Bedrock reused tool request ID \"${truncate(toolUseId, 128)}\".`,
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
    },
  ) {
    if (!config.modelId.trim()) {
      throw new BedrockConverseAgentError(
        "A Bedrock model ID is required for Converse agent runs.",
        "configuration_error",
      );
    }
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
        "A Bedrock Converse agent run requires at least one message.",
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
    let iterations = 0;
    let toolCalls = 0;

    const emit = async (event: BedrockConverseAgentEvent) => {
      events.push(event);
      await input.onEvent?.(event);
    };

    while (true) {
      if (iterations >= limits.maxIterations) {
        throw new BedrockConverseLimitError(
          `Bedrock Converse agent exceeded its ${limits.maxIterations}-iteration limit.`,
          "iteration_limit_exceeded",
          limits.maxIterations,
          iterations + 1,
          { iterations, toolCalls, usage: aggregateUsage },
        );
      }

      iterations += 1;
      await emit({
        type: "model_call_started",
        iteration: iterations,
        messageCount: messages.length,
      });

      let response: BedrockConverseTransportResponse;

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
              temperature: input.effort ? 1 : temperature,
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
                }
              : undefined,
            additionalModelRequestFields: input.effort
              ? {
                  thinking: { type: "adaptive" },
                  output_config: { effort: input.effort },
                }
              : undefined,
          },
          { signal: input.signal },
        );
      } catch (error) {
        const providerName = getProviderErrorName(error);
        const providerMessage = getProviderErrorMessage(error);
        const errorState = {
          iterations,
          toolCalls,
          usage: aggregateUsage,
          cause: error,
        };

        if (isModelCapabilityError(error)) {
          throw new BedrockConverseModelCapabilityError(
            `Bedrock model \"${this.config.modelId}\" rejected the Converse request as unsupported. Configure a model that supports Bedrock Converse${tools.length ? " tool use" : ""}. Provider response (${providerName}): ${providerMessage}`,
            errorState,
          );
        }

        throw new BedrockConverseProviderError(
          `Bedrock Converse request failed for model \"${this.config.modelId}\" (${providerName}): ${providerMessage}`,
          errorState,
        );
      }

      const iterationUsage = normalizeTokenUsage(response.usage);
      aggregateUsage = addTokenUsage(aggregateUsage, iterationUsage);
      const stopReason = response.stopReason;

      await emit({
        type: "model_call_completed",
        iteration: iterations,
        stopReason: stopReason ?? "missing",
        requestId: response.requestId,
        usage: iterationUsage,
        aggregateUsage,
      });

      if (aggregateUsage.totalTokens > limits.maxTotalTokens) {
        throw new BedrockConverseLimitError(
          `Bedrock Converse agent exceeded its ${limits.maxTotalTokens}-token budget.`,
          "token_limit_exceeded",
          limits.maxTotalTokens,
          aggregateUsage.totalTokens,
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      if (!stopReason) {
        throw new BedrockConverseAgentError(
          "Bedrock Converse response did not include a stop reason.",
          "protocol_error",
          { iterations, toolCalls, usage: aggregateUsage },
        );
      }

      if (
        !response.message ||
        response.message.role !== "assistant" ||
        !response.message.content?.length
      ) {
        throw new BedrockConverseAgentError(
          "Bedrock Converse response did not include a complete assistant message.",
          "protocol_error",
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      messages.push(response.message);

      if (stopReason === "end_turn" || stopReason === "stop_sequence") {
        const unexpectedToolUse = (response.message.content ?? []).some(
          (block) => "toolUse" in block && block.toolUse,
        );

        if (unexpectedToolUse) {
          throw new BedrockConverseAgentError(
            `Bedrock returned tool requests with stop reason \"${stopReason}\".`,
            "protocol_error",
            { stopReason, iterations, toolCalls, usage: aggregateUsage },
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
        };
      }

      if (stopReason === "max_tokens") {
        throw new BedrockConverseLimitError(
          `Bedrock model \"${this.config.modelId}\" reached the per-iteration output limit of ${maxTokens} tokens.`,
          "output_token_limit_reached",
          maxTokens,
          iterationUsage.outputTokens,
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      if (
        stopReason === "guardrail_intervened" ||
        stopReason === "content_filtered"
      ) {
        throw new BedrockConverseAgentError(
          `Bedrock did not complete the response because ${stopReason.replaceAll("_", " ")}.`,
          "response_blocked",
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      if (
        stopReason === "malformed_model_output" ||
        stopReason === "malformed_tool_use"
      ) {
        throw new BedrockConverseAgentError(
          `Bedrock stopped after producing ${stopReason.replaceAll("_", " ")}.`,
          "malformed_model_response",
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      if (stopReason === "model_context_window_exceeded") {
        throw new BedrockConverseLimitError(
          `Bedrock model \"${this.config.modelId}\" exceeded its context window. Reduce the conversation or retrieved context.`,
          "token_limit_exceeded",
          limits.maxTotalTokens,
          aggregateUsage.totalTokens,
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      if (stopReason !== "tool_use") {
        throw new BedrockConverseAgentError(
          `Bedrock Converse returned unsupported stop reason \"${truncate(stopReason, 128)}\".`,
          "protocol_error",
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      const requestedTools = readRequestedTools(response.message, seenToolUseIds, {
        stopReason,
        iterations,
        toolCalls,
        usage: aggregateUsage,
      });

      if (!requestedTools.length) {
        throw new BedrockConverseAgentError(
          "Bedrock stopped for tool use without returning a tool request.",
          "protocol_error",
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      if (toolCalls + requestedTools.length > limits.maxToolCalls) {
        throw new BedrockConverseLimitError(
          `Bedrock Converse agent would exceed its ${limits.maxToolCalls}-tool-call limit.`,
          "tool_call_limit_exceeded",
          limits.maxToolCalls,
          toolCalls + requestedTools.length,
          { stopReason, iterations, toolCalls, usage: aggregateUsage },
        );
      }

      const toolResults: ContentBlock[] = [];

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
      }

      messages.push({
        role: "user",
        content: toolResults,
      });
    }
  }
}
