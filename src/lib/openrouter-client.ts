import type {
  ContentBlock,
  ConverseCommandInput,
  Message,
  StopReason,
  TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";
import type { JsonValue } from "@/src/domain/types";
import type {
  BedrockConverseTransport,
  BedrockConverseTransportResponse,
} from "@/src/lib/bedrock-converse-agent";
import type { ConverseTextRuntime } from "@/src/lib/bedrock-structured-llm-client";
import type { OpenRouterTextConfig } from "@/src/lib/llm-config";

type FetchImplementation = typeof fetch;

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface OpenRouterToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenRouterResponse {
  id?: string;
  model?: string;
  provider?: string;
  choices?: Array<{
    finish_reason?: string | null;
    error?: {
      message?: string;
      code?: number | string;
      metadata?: unknown;
    };
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: OpenRouterToolCall[];
      reasoning_details?: JsonValue;
      refusal?: string | JsonValue | null;
    };
  }>;
  usage?: OpenRouterUsage;
  error?: {
    message?: string;
    code?: number | string;
    metadata?: unknown;
  };
}

export class OpenRouterRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly requestId: string | null = null,
    options?: {
      cause?: unknown;
      failedAttempts?: JsonValue[];
      unknownUsageAttempts?: number;
      providerAttemptCount?: number;
      code?: string | null;
      errorType?: string | null;
      retryAfter?: string | null;
      tokenUsage?: JsonValue | null;
      partialContent?: string | null;
    },
  ) {
    super(message, options);
    this.name = "OpenRouterRequestError";
    this.failedAttempts = options?.failedAttempts ?? [];
    this.unknownUsageAttempts = options?.unknownUsageAttempts ?? 1;
    this.providerAttemptCount = options?.providerAttemptCount ?? 1;
    this.code = options?.code ?? null;
    this.errorType = options?.errorType ?? null;
    this.retryAfter = options?.retryAfter ?? null;
    this.tokenUsage = options?.tokenUsage ?? null;
    this.partialContent = options?.partialContent ?? null;
  }

  readonly failedAttempts: JsonValue[];
  readonly unknownUsageAttempts: number;
  readonly providerAttemptCount: number;
  readonly code: string | null;
  readonly errorType: string | null;
  readonly retryAfter: string | null;
  readonly tokenUsage: JsonValue | null;
  readonly partialContent: string | null;
}

export function isRetryableModelProviderError(
  error: unknown,
): error is OpenRouterRequestError {
  return error instanceof OpenRouterRequestError && error.retryable;
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function normalizeUsage(
  usage: OpenRouterUsage | undefined,
  metadata: {
    requestId: string | null;
    modelId: string;
    provider: string | null;
  },
): JsonValue | null {
  if (!usage) return null;
  const inputTokens = Math.floor(nonNegativeNumber(usage.prompt_tokens));
  const outputTokens = Math.floor(nonNegativeNumber(usage.completion_tokens));
  const totalTokens =
    Math.floor(nonNegativeNumber(usage.total_tokens)) ||
    inputTokens + outputTokens;
  const cachedTokens = Math.floor(
    nonNegativeNumber(usage.prompt_tokens_details?.cached_tokens),
  );
  const cacheWriteTokens = Math.floor(
    nonNegativeNumber(usage.prompt_tokens_details?.cache_write_tokens),
  );
  const reasoningTokens = Math.floor(
    nonNegativeNumber(usage.completion_tokens_details?.reasoning_tokens),
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens: cachedTokens,
    cacheWriteInputTokens: cacheWriteTokens,
    reasoningTokens,
    cost:
      typeof usage.cost === "number" &&
      Number.isFinite(usage.cost) &&
      usage.cost >= 0
        ? usage.cost
        : null,
    requestId: metadata.requestId,
    modelId: metadata.modelId,
    routedProvider: metadata.provider,
    providerAttemptCount: 1,
  };
}

function responseText(
  content:
    | string
    | Array<{ type?: string; text?: string }>
    | null
    | undefined,
) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part?.type === "text" ? part.text ?? "" : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function combinedProviderTokenUsage(input: {
  primary: JsonValue | null;
  fallback: JsonValue | null;
  failedAttempts: JsonValue[];
  unknownUsageAttempts: number;
  providerAttemptCount: number;
  fallbackUsageMissingIsUnknown?: boolean;
}): JsonValue {
  const attempts = [input.primary, input.fallback].filter(
    (entry): entry is JsonValue => entry != null,
  );
  return {
    attempts,
    failedAttempts: input.failedAttempts,
    unknownUsageAttempts: input.unknownUsageAttempts +
      (
        input.fallback == null &&
        input.fallbackUsageMissingIsUnknown !== false
          ? 1
          : 0
      ),
    providerAttemptCount: input.providerAttemptCount,
  };
}

function parseToolArguments(toolCall: OpenRouterToolCall | undefined) {
  const raw = toolCall?.function?.arguments;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

function finishReason(value: string | null | undefined): string | null {
  switch (value) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filtered";
    default:
      return value || null;
  }
}

function providerRouting(config: OpenRouterTextConfig) {
  return {
    zdr: config.zeroDataRetention,
    require_parameters: config.requireParameters,
    allow_fallbacks: true,
    ...(config.providerOrder?.length
      ? { order: config.providerOrder }
      : {}),
  };
}

function headers(config: OpenRouterTextConfig) {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    // OpenRouter safely passes this through to Anthropic endpoints. It is
    // required for strict=true tools when a Sonnet fallback is selected.
    "x-anthropic-beta": "structured-outputs-2025-11-13",
    ...(config.siteUrl ? { "HTTP-Referer": config.siteUrl } : {}),
    "X-Title": config.appName,
  };
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function retryableHttpStatus(status: number) {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function errorMetadataType(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).error_type;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numericErrorStatus(code: number | string | undefined) {
  const numeric = typeof code === "number" ? code : Number(code);
  return Number.isInteger(numeric) && numeric >= 400 && numeric <= 599
    ? numeric
    : null;
}

function retryableOpenRouterError(input: {
  status: number | null;
  errorType: string | null;
  message: string;
}) {
  if (
    /auth|permission|forbidden|payment|billing|credit|refusal|content[_ -]?(?:policy|filter|moderation)|safety/i.test(
      `${input.errorType ?? ""} ${input.message}`,
    )
  ) {
    return false;
  }
  if (input.status != null) return retryableHttpStatus(input.status);
  return /rate[_ -]?limit|overload|unavailable|timeout|upstream|provider[_ -]?error|temporar/i.test(
    `${input.errorType ?? ""} ${input.message}`,
  );
}

async function parseResponseBody(
  response: Response,
  signal?: AbortSignal,
): Promise<OpenRouterResponse> {
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new OpenRouterRequestError(
      `OpenRouter response body could not be read: ${
        error instanceof Error ? error.message : "connection closed"
      }`,
      response.status,
      true,
      response.headers.get("x-request-id"),
      { cause: error },
    );
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as OpenRouterResponse;
  } catch {
    throw new OpenRouterRequestError(
      `OpenRouter returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
      retryableHttpStatus(response.status),
      response.headers.get("x-request-id"),
    );
  }
}

async function sendOpenRouterRequest(input: {
  config: OpenRouterTextConfig;
  modelId: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImplementation: FetchImplementation;
}) {
  let response: Response;
  try {
    response = await input.fetchImplementation(
      `${input.config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: headers(input.config),
        signal: combinedSignal(input.signal, input.config.requestTimeoutMs),
        body: JSON.stringify({
          ...input.body,
          model: input.modelId,
          provider: providerRouting(input.config),
          usage: { include: true },
        }),
      },
    );
  } catch (error) {
    if (error instanceof OpenRouterRequestError) throw error;
    // A user/workflow cancellation is a terminal local decision. Never turn
    // it into an infrastructure failure that can spend money on another model.
    if (input.signal?.aborted) throw error;
    throw new OpenRouterRequestError(
      `OpenRouter request failed before a response was received: ${
        error instanceof Error ? error.message : "network error"
      }`,
      null,
      true,
      null,
      { cause: error },
    );
  }

  const parsed = await parseResponseBody(response, input.signal);
  const requestId =
    response.headers.get("x-request-id") ||
    (typeof parsed.id === "string" ? parsed.id : null);
  const responseModelId = parsed.model?.trim() || input.modelId;
  const routedProvider = parsed.provider?.trim() || null;
  const responseUsage = normalizeUsage(parsed.usage, {
    requestId,
    modelId: responseModelId,
    provider: routedProvider,
  });
  if (!response.ok || parsed.error) {
    const providerMessage =
      parsed.error?.message?.trim() ||
      `OpenRouter returned HTTP ${response.status}.`;
    const errorType = errorMetadataType(parsed.error?.metadata);
    const payloadStatus = numericErrorStatus(parsed.error?.code);
    const status = response.ok ? payloadStatus : response.status;
    throw new OpenRouterRequestError(
      providerMessage,
      status,
      retryableOpenRouterError({
        status,
        errorType,
        message: providerMessage,
      }),
      requestId,
      {
        code: parsed.error?.code == null
          ? null
          : String(parsed.error.code),
        errorType,
        retryAfter: response.headers.get("retry-after"),
        tokenUsage: responseUsage,
        unknownUsageAttempts: responseUsage ? 0 : 1,
        partialContent: responseText(parsed.choices?.[0]?.message?.content),
      },
    );
  }
  if (!parsed.choices?.length) {
    throw new OpenRouterRequestError(
      "OpenRouter returned no completion choices.",
      response.status,
      true,
      requestId,
      {
        code: "no_completion_choices",
        retryAfter: response.headers.get("retry-after"),
        tokenUsage: responseUsage,
        unknownUsageAttempts: responseUsage ? 0 : 1,
      },
    );
  }
  const choice = parsed.choices[0]!;
  if (choice.error || choice.finish_reason === "error") {
    const providerMessage =
      choice.error?.message?.trim() ||
      "OpenRouter reported a provider error for the completion choice.";
    const errorType = errorMetadataType(choice.error?.metadata);
    const status = numericErrorStatus(choice.error?.code);
    throw new OpenRouterRequestError(
      providerMessage,
      status,
      retryableOpenRouterError({ status, errorType, message: providerMessage }),
      requestId,
      {
        code: choice.error?.code == null
          ? "choice_error"
          : String(choice.error.code),
        errorType,
        retryAfter: response.headers.get("retry-after"),
        tokenUsage: responseUsage,
        unknownUsageAttempts: responseUsage ? 0 : 1,
        partialContent: responseText(choice.message?.content),
      },
    );
  }
  if (
    choice.message?.refusal != null ||
    choice.finish_reason === "content_filter"
  ) {
    const refusal =
      typeof choice.message?.refusal === "string"
        ? choice.message.refusal
        : "The model blocked this response for safety or content-policy reasons.";
    throw new OpenRouterRequestError(
      refusal,
      null,
      false,
      requestId,
      {
        code: "response_blocked",
        errorType: "content_policy",
        tokenUsage: responseUsage,
        unknownUsageAttempts: responseUsage ? 0 : 1,
        partialContent: responseText(choice.message?.content),
      },
    );
  }

  return {
    response: parsed,
    requestId,
    modelId: responseModelId,
    routedProvider,
  };
}

export class OpenRouterChatCompletionsRuntime
  implements ConverseTextRuntime
{
  constructor(
    private readonly config: OpenRouterTextConfig,
    private readonly modelId = config.modelId,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async converse(
    input: Parameters<ConverseTextRuntime["converse"]>[0],
  ): Promise<Awaited<ReturnType<ConverseTextRuntime["converse"]>>> {
    const structuredOutput = input.structuredOutput;
    const strictTool =
      structuredOutput?.mode === "strict_tool_use"
        ? {
            tools: [
              {
                type: "function",
                function: {
                  name: structuredOutput.schemaName,
                  description: structuredOutput.schemaDescription,
                  parameters: structuredOutput.jsonSchema,
                  strict: true,
                },
              },
            ],
            tool_choice: {
              type: "function",
              function: { name: structuredOutput.schemaName },
            },
          }
        : {};
    const jsonSchema =
      structuredOutput &&
      (structuredOutput.mode === "json_schema" ||
        structuredOutput.mode === "bedrock_json_schema")
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: structuredOutput.schemaName,
                description: structuredOutput.schemaDescription,
                strict: true,
                schema: structuredOutput.jsonSchema,
              },
            },
          }
        : {};
    const result = await sendOpenRouterRequest({
      config: this.config,
      modelId: this.modelId,
      signal: input.signal,
      fetchImplementation: this.fetchImplementation,
      body: {
        messages: [
          {
            role: "system",
            // Strict ZDR forbids prompt-cache retention. Keep the stable
            // prefix, but never serialize cache_control for OpenRouter.
            content: input.systemPrompt,
          },
          { role: "user", content: input.userPrompt },
        ],
        // The ZDR-capable Azure endpoints for the selected OpenAI models
        // advertise max_completion_tokens rather than max_tokens. Sonnet 5
        // accepts this OpenAI-compatible spelling too, so one parameter keeps
        // require_parameters strict without excluding every ZDR endpoint.
        max_completion_tokens: input.maxTokens,
        ...(this.config.sendTemperature
          ? { temperature: input.effort ? 1 : input.temperature }
          : {}),
        ...(input.effort
          ? { reasoning: { effort: input.effort } }
          : {}),
        ...jsonSchema,
        ...strictTool,
      },
    });
    const choice = result.response.choices![0]!;
    const toolCall = choice.message?.tool_calls?.[0];

    return {
      text: responseText(choice.message?.content),
      structuredData: parseToolArguments(toolCall),
      stopReason: finishReason(choice.finish_reason),
      tokenUsage: normalizeUsage(result.response.usage, {
        requestId: result.requestId,
        modelId: result.modelId,
        provider: result.routedProvider,
      }),
      provider: "openrouter",
      modelId: result.modelId,
      requestId: result.requestId,
    };
  }
}

/**
 * OpenRouter already performs provider-level failover for the requested model.
 * This wrapper changes model families only when the normalized failure is an
 * infrastructure-class error; validation, moderation, and capability errors
 * never trigger the cross-model fallback.
 */
export class RetryableFallbackTextRuntime implements ConverseTextRuntime {
  constructor(
    private readonly primary: ConverseTextRuntime,
    private readonly fallback: ConverseTextRuntime,
    private readonly primaryModelId = "primary-model",
    private readonly fallbackModelId = "fallback-model",
  ) {}

  async converse(input: Parameters<ConverseTextRuntime["converse"]>[0]) {
    try {
      return await this.primary.converse(input);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (!isRetryableModelProviderError(error)) throw error;
      const primaryFailure = {
        provider: "openrouter",
        modelId: this.primaryModelId,
        requestId: error.requestId,
        status: "provider_error",
        httpStatus: error.status,
        code: error.code,
        errorType: error.errorType,
        retryAfter: error.retryAfter,
        retryable: true,
      } satisfies JsonValue;
      const failedPrimaryAttempts = [
        ...error.failedAttempts,
        primaryFailure,
      ];
      if (
        typeof input.maxProviderAttempts === "number" &&
        input.maxProviderAttempts < 2
      ) {
        throw error;
      }
      try {
        const response = await this.fallback.converse(input);
        return {
          ...response,
          tokenUsage: combinedProviderTokenUsage({
            primary: error.tokenUsage,
            fallback: response.tokenUsage,
            failedAttempts: failedPrimaryAttempts,
            unknownUsageAttempts: error.unknownUsageAttempts,
            providerAttemptCount: error.providerAttemptCount + 1,
          }),
        };
      } catch (fallbackError) {
        if (!(fallbackError instanceof OpenRouterRequestError)) {
          throw fallbackError;
        }
        throw new OpenRouterRequestError(
          fallbackError.message,
          fallbackError.status,
          fallbackError.retryable,
          fallbackError.requestId,
          {
            cause: fallbackError,
            failedAttempts: [
              ...failedPrimaryAttempts,
              {
                provider: "openrouter",
                modelId: this.fallbackModelId,
                requestId: fallbackError.requestId,
                status: "provider_error",
                httpStatus: fallbackError.status,
                code: fallbackError.code,
                errorType: fallbackError.errorType,
                retryAfter: fallbackError.retryAfter,
                retryable: fallbackError.retryable,
              },
              ...fallbackError.failedAttempts,
            ],
            unknownUsageAttempts:
              error.unknownUsageAttempts +
              fallbackError.unknownUsageAttempts,
            providerAttemptCount:
              error.providerAttemptCount +
              fallbackError.providerAttemptCount,
            code: fallbackError.code,
            errorType: fallbackError.errorType,
            retryAfter: fallbackError.retryAfter,
            partialContent: fallbackError.partialContent,
            tokenUsage: combinedProviderTokenUsage({
              primary: error.tokenUsage,
              fallback: fallbackError.tokenUsage,
              failedAttempts: [
                ...failedPrimaryAttempts,
                ...fallbackError.failedAttempts,
              ],
              unknownUsageAttempts:
                error.unknownUsageAttempts +
                fallbackError.unknownUsageAttempts,
              providerAttemptCount:
                error.providerAttemptCount +
                fallbackError.providerAttemptCount,
              fallbackUsageMissingIsUnknown: false,
            }),
          },
        );
      }
    }
  }
}

function blockText(block: ContentBlock) {
  if ("text" in block && typeof block.text === "string") return block.text;
  if ("json" in block && block.json !== undefined) {
    return JSON.stringify(block.json);
  }
  return "";
}

function messageContentText(content: ContentBlock[] | undefined) {
  return (content ?? []).map(blockText).filter(Boolean).join("\n");
}

function toOpenRouterMessages(messages: Message[]) {
  const output: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const toolResults = (message.content ?? []).filter(
      (block) => "toolResult" in block && block.toolResult,
    );
    const ordinaryText = messageContentText(
      (message.content ?? []).filter((block) => !("toolResult" in block)),
    );
    if (ordinaryText || !toolResults.length) {
      const toolCalls = (message.content ?? []).flatMap((block) =>
        "toolUse" in block && block.toolUse
          ? [
              {
                id: block.toolUse.toolUseId,
                type: "function",
                function: {
                  name: block.toolUse.name,
                  arguments: JSON.stringify(block.toolUse.input ?? {}),
                },
              },
            ]
          : [],
      );
      output.push({
        role: message.role,
        content: ordinaryText || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...reasoningDetailsFromContent(message.content),
      });
    }
    for (const block of toolResults) {
      if (!("toolResult" in block) || !block.toolResult) continue;
      output.push({
        role: "tool",
        tool_call_id: block.toolResult.toolUseId,
        content:
          messageContentText(block.toolResult.content as ContentBlock[]) ||
          JSON.stringify({ status: block.toolResult.status ?? "success" }),
      });
    }
  }
  return output;
}

const OPENROUTER_REASONING_DETAILS_CARRIER =
  "workbase_openrouter_reasoning_details";

function reasoningDetailsFromContent(content: ContentBlock[] | undefined) {
  const carrier = (content ?? []).find(
    (block) =>
      "$unknown" in block &&
      Array.isArray(block.$unknown) &&
      block.$unknown[0] === OPENROUTER_REASONING_DETAILS_CARRIER,
  );
  return carrier &&
    "$unknown" in carrier &&
    Array.isArray(carrier.$unknown)
    ? { reasoning_details: carrier.$unknown[1] }
    : {};
}

function agentToolConfig(input: ConverseCommandInput) {
  const tools = (input.toolConfig?.tools ?? []).flatMap((tool) => {
    if (!("toolSpec" in tool) || !tool.toolSpec) return [];
    return [
      {
        type: "function",
        function: {
          name: tool.toolSpec.name,
          description: tool.toolSpec.description,
          parameters:
            tool.toolSpec.inputSchema &&
            "json" in tool.toolSpec.inputSchema
              ? tool.toolSpec.inputSchema.json
              : {},
          strict: tool.toolSpec.strict ?? false,
        },
      },
    ];
  });
  const selectedTool =
    input.toolConfig?.toolChoice &&
    "tool" in input.toolConfig.toolChoice
      ? input.toolConfig.toolChoice.tool?.name
      : null;
  return {
    ...(tools.length ? { tools } : {}),
    ...(selectedTool
      ? {
          tool_choice: {
            type: "function",
            function: { name: selectedTool },
          },
        }
      : {}),
  };
}

export class OpenRouterConverseTransport implements BedrockConverseTransport {
  constructor(
    private readonly config: OpenRouterTextConfig,
    private readonly modelId = config.modelId,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async converse(
    input: ConverseCommandInput,
    options?: { signal?: AbortSignal },
  ): Promise<BedrockConverseTransportResponse> {
    const systemPrompt = (input.system ?? [])
      .flatMap((block) =>
        "text" in block && typeof block.text === "string" ? [block.text] : [],
      )
      .join("\n");
    const effort =
      input.additionalModelRequestFields &&
      typeof input.additionalModelRequestFields === "object" &&
      "output_config" in input.additionalModelRequestFields &&
      input.additionalModelRequestFields.output_config &&
      typeof input.additionalModelRequestFields.output_config === "object" &&
      "effort" in input.additionalModelRequestFields.output_config
        ? input.additionalModelRequestFields.output_config.effort
        : undefined;
    const result = await sendOpenRouterRequest({
      config: this.config,
      modelId: this.modelId,
      signal: options?.signal,
      fetchImplementation: this.fetchImplementation,
      body: {
        messages: [
          ...(systemPrompt
            ? [
                {
                  role: "system",
                  content: systemPrompt,
                },
              ]
            : []),
          ...toOpenRouterMessages(input.messages ?? []),
        ],
        max_completion_tokens: input.inferenceConfig?.maxTokens,
        ...(this.config.sendTemperature
          ? {
              temperature: effort
                ? 1
                : input.inferenceConfig?.temperature,
            }
          : {}),
        ...(Array.isArray(input.inferenceConfig?.stopSequences) &&
        input.inferenceConfig.stopSequences.length
          ? { stop: input.inferenceConfig.stopSequences }
          : {}),
        ...(typeof effort === "string"
          ? { reasoning: { effort } }
          : {}),
        ...agentToolConfig(input),
      },
    });
    const choice = result.response.choices![0]!;
    const content: ContentBlock[] = [
      ...(choice.message?.reasoning_details !== undefined
        ? [
            {
              // AWS's provider-neutral union gives us an opaque carrier that
              // survives message cloning. OpenRouter requires these details
              // to be replayed byte-for-byte on the next tool-loop request.
              $unknown: [
                OPENROUTER_REASONING_DETAILS_CARRIER,
                choice.message.reasoning_details,
              ],
            } as ContentBlock,
          ]
        : []),
      ...(responseText(choice.message?.content)
        ? [{ text: responseText(choice.message?.content) }]
        : []),
      ...(choice.message?.tool_calls ?? []).flatMap((call) => {
        const name = call.function?.name?.trim();
        const toolUseId = call.id?.trim();
        const parsed = parseToolArguments(call);
        if (!name || !toolUseId || parsed == null) return [];
        return [
          {
            toolUse: {
              toolUseId,
              name,
              input: parsed as never,
            },
          },
        ];
      }),
    ];
    const usage = normalizeUsage(result.response.usage, {
      requestId: result.requestId,
      modelId: result.modelId,
      provider: result.routedProvider,
    });

    return {
      message: { role: "assistant", content } as Message,
      stopReason: finishReason(choice.finish_reason) as StopReason | null,
      usage: usage as TokenUsage | null,
      requestId: result.requestId,
      provider: "openrouter",
      routedProvider: result.routedProvider,
      modelId: result.modelId,
      costUsd:
        usage &&
        typeof usage === "object" &&
        !Array.isArray(usage) &&
        typeof usage.cost === "number"
          ? usage.cost
          : null,
    };
  }
}

export class RetryableFallbackConverseTransport
  implements BedrockConverseTransport
{
  constructor(
    private readonly primary: BedrockConverseTransport,
    private readonly fallback: BedrockConverseTransport,
    private readonly primaryModelId = "primary-model",
    private readonly fallbackModelId = "fallback-model",
  ) {}

  async converse(
    input: ConverseCommandInput,
    options?: { signal?: AbortSignal },
  ) {
    try {
      return await this.primary.converse(input, options);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (!isRetryableModelProviderError(error)) throw error;
      const primaryFailure = {
        provider: "openrouter",
        modelId: this.primaryModelId,
        requestId: error.requestId,
        status: "provider_error",
        httpStatus: error.status,
        code: error.code,
        errorType: error.errorType,
        retryAfter: error.retryAfter,
        retryable: true,
      } satisfies JsonValue;
      const failedPrimaryAttempts = [
        ...error.failedAttempts,
        primaryFailure,
      ];
      try {
        const response = await this.fallback.converse(input, options);
        return {
          ...response,
          usage: combinedProviderTokenUsage({
            primary: error.tokenUsage,
            fallback: response.usage as JsonValue | null,
            failedAttempts: failedPrimaryAttempts,
            unknownUsageAttempts: error.unknownUsageAttempts,
            providerAttemptCount: error.providerAttemptCount + 1,
          }) as unknown as TokenUsage,
        };
      } catch (fallbackError) {
        if (!(fallbackError instanceof OpenRouterRequestError)) {
          throw fallbackError;
        }
        throw new OpenRouterRequestError(
          fallbackError.message,
          fallbackError.status,
          fallbackError.retryable,
          fallbackError.requestId,
          {
            cause: fallbackError,
            failedAttempts: [
              ...failedPrimaryAttempts,
              {
                provider: "openrouter",
                modelId: this.fallbackModelId,
                requestId: fallbackError.requestId,
                status: "provider_error",
                httpStatus: fallbackError.status,
                code: fallbackError.code,
                errorType: fallbackError.errorType,
                retryAfter: fallbackError.retryAfter,
                retryable: fallbackError.retryable,
              },
              ...fallbackError.failedAttempts,
            ],
            unknownUsageAttempts:
              error.unknownUsageAttempts +
              fallbackError.unknownUsageAttempts,
            providerAttemptCount:
              error.providerAttemptCount +
              fallbackError.providerAttemptCount,
            code: fallbackError.code,
            errorType: fallbackError.errorType,
            retryAfter: fallbackError.retryAfter,
            partialContent: fallbackError.partialContent,
            tokenUsage: combinedProviderTokenUsage({
              primary: error.tokenUsage,
              fallback: fallbackError.tokenUsage,
              failedAttempts: [
                ...failedPrimaryAttempts,
                ...fallbackError.failedAttempts,
              ],
              unknownUsageAttempts:
                error.unknownUsageAttempts +
                fallbackError.unknownUsageAttempts,
              providerAttemptCount:
                error.providerAttemptCount +
                fallbackError.providerAttemptCount,
              fallbackUsageMissingIsUnknown: false,
            }),
          },
        );
      }
    }
  }
}
