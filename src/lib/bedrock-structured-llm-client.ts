import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { z } from "zod";
import type { JsonValue } from "@/src/domain/types";
import { toBedrockCompatibleJsonSchema } from "@/src/lib/llm-json-schemas";
import type {
  JsonSchemaObject,
  StructuredOutputTransportMode,
} from "@/src/lib/llm-json-schemas";

type GenerationFailureStatus = "provider_error" | "parse_error" | "validation_error";
type StructuredGenerationPhase = "generation" | "repair";
type NativeStructuredOutputMode = Exclude<
  StructuredOutputTransportMode,
  "text_repair_fallback"
>;

function isCallerCancellation(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    String(error.name) === "AbortError",
  );
}

export interface StructuredOutputAttemptRecord {
  mode: StructuredOutputTransportMode;
  phase: StructuredGenerationPhase;
  status: "success" | GenerationFailureStatus;
  validationErrors: JsonValue | null;
  errorMessage?: string | null;
  stopReason?: string | null;
}

export interface StructuredGenerationBudgetUsage {
  modelCalls: number;
  repairPasses: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  unknownUsageCalls: number;
}

export interface StructuredGenerationBudget {
  limits: {
    maxModelCalls: number;
    maxRepairPasses: number;
    maxOutputTokens: number;
    maxTotalTokens: number;
  };
  usage: StructuredGenerationBudgetUsage;
}

type StructuredGenerationBudgetReservations = {
  modelCalls: number;
  totalTokens: number;
  waiters: Set<() => void>;
};

// Reservations are deliberately kept out of the persisted/public usage shape:
// they exist only while provider requests are in flight. JavaScript executes
// each admission section synchronously, so one shared budget can safely admit
// concurrent callers without a lock while still preventing them from spending
// the same remaining token or provider-call capacity.
const structuredGenerationBudgetReservations = new WeakMap<
  StructuredGenerationBudget,
  StructuredGenerationBudgetReservations
>();

function reservationsForStructuredGenerationBudget(
  budget: StructuredGenerationBudget,
) {
  const existing = structuredGenerationBudgetReservations.get(budget);
  if (existing) return existing;
  const created = {
    modelCalls: 0,
    totalTokens: 0,
    waiters: new Set<() => void>(),
  };
  structuredGenerationBudgetReservations.set(budget, created);
  return created;
}

function waitForStructuredGenerationBudgetReservation(
  reservations: StructuredGenerationBudgetReservations,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Cancelled", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const resume = () => {
      signal?.removeEventListener("abort", cancel);
      reservations.waiters.delete(resume);
      resolve();
    };
    const cancel = () => {
      reservations.waiters.delete(resume);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    reservations.waiters.add(resume);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function notifyStructuredGenerationBudgetWaiters(
  reservations: StructuredGenerationBudgetReservations,
) {
  for (const resume of [...reservations.waiters]) resume();
}

export class StructuredGenerationBudgetError extends Error {
  constructor(
    public readonly code:
      | "model_call_budget_exhausted"
      | "repair_budget_exhausted"
      | "token_budget_exhausted",
    message: string,
    public readonly usage: StructuredGenerationBudgetUsage,
  ) {
    super(message);
    this.name = "StructuredGenerationBudgetError";
  }
}

export function createStructuredGenerationBudget(input: StructuredGenerationBudget["limits"]): StructuredGenerationBudget {
  const positiveInteger = (value: number, label: string) => {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
    return value;
  };
  return {
    limits: {
      maxModelCalls: positiveInteger(input.maxModelCalls, "maxModelCalls"),
      maxRepairPasses: positiveInteger(input.maxRepairPasses, "maxRepairPasses"),
      maxOutputTokens: positiveInteger(input.maxOutputTokens, "maxOutputTokens"),
      maxTotalTokens: positiveInteger(input.maxTotalTokens, "maxTotalTokens"),
    },
    usage: {
      modelCalls: 0,
      repairPasses: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      unknownUsageCalls: 0,
    },
  };
}

export function snapshotStructuredGenerationBudget(budget: StructuredGenerationBudget): StructuredGenerationBudgetUsage {
  return { ...budget.usage };
}

export interface ConverseTextRuntime {
  converse(input: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
    effort?: "low" | "medium" | "high";
    enablePromptCaching?: boolean;
    signal?: AbortSignal;
    /**
     * Maximum provider HTTP dispatches available to this logical model call.
     * Fallback runtimes must honor this before issuing another paid request.
     */
    maxProviderAttempts?: number;
    structuredOutput?: {
      mode: NativeStructuredOutputMode;
      schemaName: string;
      schemaDescription: string;
      jsonSchema: JsonSchemaObject;
    };
  }): Promise<{
    text: string;
    structuredData: unknown;
    tokenUsage: JsonValue | null;
    stopReason?: string | null;
    provider?: string;
    modelId?: string;
    requestId?: string | null;
  }>;
}

export class StructuredOutputError extends Error {
  readonly providerStatus: number | null;
  readonly retryable: boolean | null;
  readonly providerCode: string | null;
  override readonly cause?: unknown;

  constructor(
    message: string,
    public readonly status: GenerationFailureStatus,
    public readonly rawOutput: string | null,
    public readonly validationErrors: JsonValue | null,
    public readonly tokenUsage: JsonValue | null,
    public readonly transportMode: StructuredOutputTransportMode | null,
    public readonly attempts: JsonValue | null,
    options?: {
      providerStatus?: number | null;
      retryable?: boolean | null;
      providerCode?: string | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.providerStatus = options?.providerStatus ?? null;
    this.retryable = options?.retryable ?? null;
    this.providerCode = options?.providerCode ?? null;
    this.cause = options?.cause;
  }
}

function normalizeJsonValue(value: unknown): JsonValue | null {
  if (value == null) {
    return null;
  }

  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function tokenUsageWithRequestId(
  tokenUsage: JsonValue | null,
  requestId: string | null | undefined,
): JsonValue | null {
  const normalizedRequestId =
    typeof requestId === "string" &&
      requestId.trim().length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestId.trim())
      ? requestId.trim()
      : null;
  if (
    !normalizedRequestId ||
    !tokenUsage ||
    typeof tokenUsage !== "object" ||
    Array.isArray(tokenUsage)
  ) {
    return tokenUsage;
  }

  // OpenRouter already includes its request ID in normalized usage. Bedrock
  // exposes the equivalent identity on response.$metadata instead. Enriching
  // the provider-neutral usage leaf here makes every structured caller persist
  // the same durable attempt identity, including callers that do not use the
  // higher-level structured-generation audit wrapper.
  return {
    ...tokenUsage,
    requestId: normalizedRequestId,
  };
}

function normalizeAttemptRecords(attempts: StructuredOutputAttemptRecord[]) {
  return normalizeJsonValue(attempts);
}

function numericTokenUsage(
  value: JsonValue | null,
  key: "inputTokens" | "outputTokens" | "totalTokens",
) {
  let total = 0;
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
    const isUsageLeaf = ["inputTokens", "outputTokens", "totalTokens"].some(
      (usageKey) => typeof record[usageKey] === "number",
    );
    if (isUsageLeaf) {
      const candidate = record[key];
      if (
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate >= 0
      ) {
        total += Math.floor(candidate);
      } else if (key === "totalTokens") {
        total +=
          Math.floor(
            typeof record.inputTokens === "number" &&
            record.inputTokens >= 0
              ? record.inputTokens
              : 0,
          ) +
          Math.floor(
            typeof record.outputTokens === "number" &&
            record.outputTokens >= 0
              ? record.outputTokens
              : 0,
          );
      }
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

function reportedCostIn(value: JsonValue | null) {
  let total = 0;
  let observed = false;
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
    if (
      typeof record.cost === "number" &&
      Number.isFinite(record.cost) &&
      record.cost >= 0
    ) {
      total += record.cost;
      observed = true;
      return;
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return observed ? total : null;
}

function unknownUsageAttemptsIn(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const candidate = (value as Record<string, unknown>).unknownUsageAttempts;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate > 0
    ? candidate
    : 0;
}

function providerAttemptCountIn(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 1;
  const candidate = (value as Record<string, unknown>).providerAttemptCount;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate > 0
    ? candidate
    : 1;
}

function providerErrorAttemptCount(error: unknown) {
  if (!error || typeof error !== "object") return 1;
  const candidate = (error as { providerAttemptCount?: unknown })
    .providerAttemptCount;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate > 0
    ? candidate
    : 1;
}

function allowsStructuredTransportFallback(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : null;
  const message =
    error instanceof Error ? error.message : String(error);
  const declaredCapability =
    "capability" in error && typeof error.capability === "string"
      ? error.capability
      : null;
  const capabilityLike =
    declaredCapability === "structured_output" ||
    declaredCapability === "tool_use" ||
    declaredCapability === "parameters" ||
    /(?:unsupported|not supported|does not support|unavailable|not enabled).{0,100}(?:json schema|response[_ -]?format|structured output|tool|function|parameter)|(?:json schema|response[_ -]?format|structured output|tool|function|parameter).{0,100}(?:unsupported|not supported|unavailable|not enabled)/i.test(
      message,
    );
  return capabilityLike &&
    (
      /ValidationException|UnsupportedOperation|NotSupported/i.test(name) ||
      status === 400 ||
      status === 404 ||
      status === 422
    );
}

function providerFailureMetadata(error: unknown): JsonValue | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    failedAttempts?: unknown;
    unknownUsageAttempts?: unknown;
    providerAttemptCount?: unknown;
    tokenUsage?: unknown;
  };
  if (!Array.isArray(candidate.failedAttempts)) return null;
  return normalizeJsonValue({
    attempts: candidate.tokenUsage == null ? [] : [candidate.tokenUsage],
    failedAttempts: candidate.failedAttempts,
    unknownUsageAttempts:
      typeof candidate.unknownUsageAttempts === "number"
        ? candidate.unknownUsageAttempts
        : candidate.failedAttempts.length,
    providerAttemptCount:
      typeof candidate.providerAttemptCount === "number"
        ? candidate.providerAttemptCount
        : candidate.failedAttempts.length,
  });
}

function tokenDensityFloor(value: string) {
  const units = value.match(/[a-z0-9_]+|[^\s]/giu) ?? [];
  return units.reduce((total, unit) => {
    if (!/^[a-z0-9_]+$/iu.test(unit) || unit.length < 24) {
      return total + 1;
    }
    // Long homogeneous fixture strings compress into very few tokens, while
    // hashes, minified identifiers, and other high-entropy runs commonly do
    // not. Charge the latter at a conservative two bytes per token without
    // reintroducing the blanket /2 estimate that starved ordinary source-code
    // prompts.
    const distinctCharacters = new Set(unit.toLowerCase()).size;
    return total + (
      distinctCharacters >= 8
        ? Math.ceil(Buffer.byteLength(unit, "utf8") / 2)
        : 1
    );
  }, 0);
}

function estimatedInputTokenReserve(input: Parameters<ConverseTextRuntime["converse"]>[0]) {
  const segments = [
    input.systemPrompt,
    input.userPrompt,
    ...(input.structuredOutput
      ? [
          JSON.stringify(input.structuredOutput.jsonSchema),
          input.structuredOutput.schemaName,
          input.structuredOutput.schemaDescription,
        ]
      : []),
  ];
  const promptBytes = segments.reduce(
    (total, segment) => total + Buffer.byteLength(segment, "utf8"),
    0,
  );
  const densityFloor = segments.reduce(
    (total, segment) => total + tokenDensityFloor(segment),
    0,
  );
  // Calibrate the admission reserve to the repository workloads this client
  // actually sends. Mixed TypeScript/JSON prompts in live Bedrock usage remain
  // above three UTF-8 bytes per reported input token after the structured
  // schema is included. The former one-token-per-two-bytes estimate reserved
  // almost twice the provider-reported input and silently reduced a 4K output
  // request to roughly 2K, causing otherwise schema-constrained JSON to end at
  // max_tokens. Three bytes per token plus a larger fixed envelope remains
  // conservative for the observed payloads while preserving the declared
  // output ceiling. The lexical density floor separately protects minified
  // JSON, one-character token streams, hashes, and identifiers that can fall
  // below three bytes per token. Actual usage is still enforced after every
  // provider call because this remains an admission estimate, not a tokenizer.
  return Math.max(Math.ceil(promptBytes / 3), densityFloor) + 768;
}

function readTextFromContent(content: ContentBlock[] | undefined) {
  return (
    content
      ?.map((contentBlock) => ("text" in contentBlock ? contentBlock.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim() ?? ""
  );
}

function readToolInputFromContent(content: ContentBlock[] | undefined) {
  for (const contentBlock of content ?? []) {
    if ("toolUse" in contentBlock && contentBlock.toolUse?.input !== undefined) {
      return normalizeJsonValue(contentBlock.toolUse.input);
    }
  }

  return null;
}

export class AwsBedrockConverseRuntime implements ConverseTextRuntime {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly config: {
      region: string;
      modelId: string;
      profile?: string;
    },
  ) {
    this.client = new BedrockRuntimeClient({
      region: config.region,
      credentials: config.profile
        ? fromIni({
            profile: config.profile,
          })
        : undefined,
    });
  }

  async converse(input: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
    effort?: "low" | "medium" | "high";
    enablePromptCaching?: boolean;
    signal?: AbortSignal;
    structuredOutput?: {
      mode: NativeStructuredOutputMode;
      schemaName: string;
      schemaDescription: string;
      jsonSchema: JsonSchemaObject;
    };
  }) {
    const configuredTimeout = Number(process.env.WORKBASE_BEDROCK_REQUEST_TIMEOUT_MS ?? 240_000);
    const requestTimeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(600_000, Math.max(30_000, configuredTimeout))
      : 240_000;
    const bedrockCompatibleSchema = input.structuredOutput
      ? toBedrockCompatibleJsonSchema(input.structuredOutput.jsonSchema)
      : null;

    const cachePoint = { cachePoint: { type: "default" as const } };
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.config.modelId,
        system: [
          {
            text: input.systemPrompt,
          },
          ...(input.enablePromptCaching ? [cachePoint] : []),
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                text: input.userPrompt,
              },
            ],
          },
        ],
        inferenceConfig: {
          maxTokens: input.maxTokens,
          temperature:
            input.effort && input.structuredOutput?.mode !== "strict_tool_use"
              ? 1
              : input.temperature,
        },
        outputConfig:
          input.structuredOutput?.mode === "bedrock_json_schema" ||
          input.structuredOutput?.mode === "json_schema"
            ? {
                textFormat: {
                  type: "json_schema",
                  structure: {
                    jsonSchema: {
                      name: input.structuredOutput.schemaName,
                      description: input.structuredOutput.schemaDescription,
                      schema: JSON.stringify(bedrockCompatibleSchema),
                    },
                  },
                },
              }
            : undefined,
        toolConfig:
          input.structuredOutput?.mode === "strict_tool_use"
            ? {
                tools: [
                  {
                    toolSpec: {
                      name: input.structuredOutput.schemaName,
                      description: input.structuredOutput.schemaDescription,
                      inputSchema: {
                        json: bedrockCompatibleSchema as never,
                      },
                      strict: true,
                    },
                  },
                  ...(input.enablePromptCaching ? [cachePoint] : []),
                ],
                toolChoice: {
                  tool: {
                    name: input.structuredOutput.schemaName,
                  },
                },
              }
            : undefined,
        // Bedrock rejects adaptive thinking when a request forces a specific tool.
        // Native JSON-schema output still receives the requested adaptive effort;
        // the strict-tool fallback prioritizes schema enforcement instead.
        additionalModelRequestFields:
          input.effort && input.structuredOutput?.mode !== "strict_tool_use"
          ? {
              thinking: { type: "adaptive" },
              output_config: { effort: input.effort },
            }
          : undefined,
      }),
      {
        abortSignal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(requestTimeoutMs)])
          : AbortSignal.timeout(requestTimeoutMs),
      },
    );

    return {
      text: readTextFromContent(response.output?.message?.content),
      structuredData: readToolInputFromContent(response.output?.message?.content),
      stopReason: response.stopReason ?? null,
      provider: "bedrock",
      modelId: this.config.modelId,
      requestId: response.$metadata?.requestId ?? null,
      tokenUsage:
        response.usage && typeof response.usage === "object"
          ? (JSON.parse(JSON.stringify(response.usage)) as JsonValue)
          : null,
    };
  }
}

function stripCodeFences(rawOutput: string) {
  return rawOutput
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function extractJsonCandidate(rawOutput: string) {
  const stripped = stripCodeFences(rawOutput);

  if (!stripped) {
    return stripped;
  }

  const firstObjectIndex = stripped.indexOf("{");
  const firstArrayIndex = stripped.indexOf("[");
  const startIndexes = [firstObjectIndex, firstArrayIndex].filter((index) => index >= 0);

  if (!startIndexes.length) {
    return stripped;
  }

  const startIndex = Math.min(...startIndexes);
  const openingChar = stripped[startIndex];
  const closingChar = openingChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < stripped.length; index += 1) {
    const char = stripped[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === openingChar) {
      depth += 1;
      continue;
    }

    if (char === closingChar) {
      depth -= 1;

      if (depth === 0) {
        return stripped.slice(startIndex, index + 1);
      }
    }
  }

  return stripped;
}

function normalizeValidationErrors(error: z.ZodError | string[]) {
  if (Array.isArray(error)) {
    return error;
  }

  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function normalizeRepairMappings(mappings: readonly string[] | undefined) {
  return mappings?.length ? mappings.join("\n") : "No field remapping rules were provided.";
}

function buildSchemaAwareRepairPrompt(params: {
  schemaName: string;
  schemaDescription: string;
  jsonSchema: JsonSchemaObject;
  exampleOutput: JsonValue | undefined;
  requiredFieldPaths: readonly string[] | undefined;
  repairMappings: readonly string[] | undefined;
  validationErrors: JsonValue | null;
  originalOutput: string;
}) {
  return [
    "<task>",
    `Repair the previous response so it matches the ${params.schemaName} schema exactly.`,
    "</task>",
    "",
    "<rules>",
    "Return JSON only.",
    "Do not wrap the JSON in prose or markdown.",
    "Do not invent missing semantic content that cannot be recovered from the original output.",
    "</rules>",
    "",
    "<target_schema_description>",
    params.schemaDescription,
    "</target_schema_description>",
    "",
    "<target_json_schema>",
    JSON.stringify(params.jsonSchema, null, 2),
    "</target_json_schema>",
    "",
    "<required_fields>",
    JSON.stringify(params.requiredFieldPaths ?? [], null, 2),
    "</required_fields>",
    "",
    "<field_mappings>",
    normalizeRepairMappings(params.repairMappings),
    "</field_mappings>",
    "",
    "<example_output>",
    params.exampleOutput ? JSON.stringify(params.exampleOutput, null, 2) : "null",
    "</example_output>",
    "",
    "<validation_errors>",
    JSON.stringify(params.validationErrors, null, 2),
    "</validation_errors>",
    "",
    "<original_output>",
    params.originalOutput,
    "</original_output>",
  ].join("\n");
}

export class BedrockStructuredLlmClient {
  constructor(
    private readonly runtime: ConverseTextRuntime,
    private readonly config: {
      provider: string;
      region?: string | null;
      modelId: string;
      defaultTransportPreference?: StructuredOutputTransportMode[];
    },
    private readonly repairRuntime?: ConverseTextRuntime,
  ) {}

  static fromConfig(config: {
    provider: "bedrock";
    region: string;
    modelId: string;
    profile?: string;
  }) {
    return new BedrockStructuredLlmClient(
      new AwsBedrockConverseRuntime(config),
      {
        provider: config.provider,
        region: config.region,
        modelId: config.modelId,
      },
    );
  }

  private providerName() {
    return this.config.provider === "bedrock" ? "Bedrock" : "Model provider";
  }

  private validateStructuredValue<T>(
    schema: z.ZodType<T>,
    parsedValue: unknown,
    extraValidation?: (value: T) => string[],
  ) {
    const structured = schema.safeParse(parsedValue);

    if (!structured.success) {
      return {
        success: false as const,
        status: "validation_error" as const,
        validationErrors: normalizeValidationErrors(structured.error),
      };
    }

    const extraValidationErrors = extraValidation?.(structured.data) ?? [];

    if (extraValidationErrors.length) {
      return {
        success: false as const,
        status: "validation_error" as const,
        validationErrors: normalizeValidationErrors(extraValidationErrors),
      };
    }

    return {
      success: true as const,
      data: structured.data,
      parsedJson: parsedValue as JsonValue,
    };
  }

  private parseStructuredText<T>(
    schema: z.ZodType<T>,
    rawOutput: string,
    extraValidation?: (value: T) => string[],
  ) {
    let parsedJson: unknown;

    try {
      parsedJson = JSON.parse(extractJsonCandidate(rawOutput));
    } catch {
      return {
        success: false as const,
        status: "parse_error" as const,
        validationErrors: ["Model output was not valid JSON."],
      };
    }

    return this.validateStructuredValue(schema, parsedJson, extraValidation);
  }

  private parseStructuredResponse<T>(params: {
    schema: z.ZodType<T>;
    rawText: string;
    structuredData: unknown;
    extraValidation?: (value: T) => string[];
  }) {
    const attempt =
      params.structuredData != null
        ? this.validateStructuredValue(
            params.schema,
            params.structuredData,
            params.extraValidation,
          )
        : this.parseStructuredText(params.schema, params.rawText, params.extraValidation);

    return {
      ...attempt,
      rawOutput:
        params.structuredData != null
          ? JSON.stringify(params.structuredData, null, 2)
          : params.rawText,
    };
  }

  async generateStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodType<T>;
    schemaName: string;
    schemaDescription: string;
    jsonSchema: JsonSchemaObject;
    exampleOutput?: JsonValue;
    requiredFieldPaths?: readonly string[];
    repairMappings?: readonly string[];
    transportPreference?: StructuredOutputTransportMode[];
    repairStrategy?: "fresh_then_repair" | "repair_last_failure";
    maxTokens: number;
    temperature?: number;
    effort?: "low" | "medium" | "high";
    budget?: StructuredGenerationBudget;
    extraValidation?: (value: T) => string[];
    signal?: AbortSignal;
  }) {
    const temperature = params.temperature ?? 0;
    const effort = params.effort ?? "high";
    const transportPreference =
      params.transportPreference ??
      this.config.defaultTransportPreference ??
      ["bedrock_json_schema", "strict_tool_use", "text_repair_fallback"];
    const nativeModes = transportPreference.filter(
      (mode): mode is NativeStructuredOutputMode => mode !== "text_repair_fallback",
    );
    const attempts: StructuredOutputAttemptRecord[] = [];
    const observedTokenUsage: JsonValue[] = [];
    let reportedCostUsd = 0;
    let hasReportedCost = false;
    let unknownUsageAttempts = 0;
    const tokenUsageSnapshot = (): JsonValue | null => {
      if (!observedTokenUsage.length && !unknownUsageAttempts) return null;
      // Preserve the existing single-call shape for callers that inspect raw
      // provider fields, while retaining every charged attempt on fallbacks.
      if (observedTokenUsage.length === 1 && !unknownUsageAttempts) {
        return observedTokenUsage[0]!;
      }
      return {
        attempts: observedTokenUsage,
        unknownUsageAttempts,
      } as JsonValue;
    };
    const converse = async (
      request: Parameters<ConverseTextRuntime["converse"]>[0],
      phase: StructuredGenerationPhase,
    ) => {
      const budget = params.budget;
      let boundedRequest = request;
      let releaseAdmissionReservation = () => {};
      if (budget) {
        const reservations = reservationsForStructuredGenerationBudget(budget);
        while (true) {
          if (
            budget.usage.modelCalls + reservations.modelCalls >=
              budget.limits.maxModelCalls
          ) {
            if (budget.usage.modelCalls >= budget.limits.maxModelCalls) {
              throw new StructuredGenerationBudgetError(
                "model_call_budget_exhausted",
                `The structured-generation model-call budget of ${budget.limits.maxModelCalls} is exhausted.`,
                snapshotStructuredGenerationBudget(budget),
              );
            }
            await waitForStructuredGenerationBudgetReservation(
              reservations,
              params.signal,
            );
            continue;
          }
          if (phase === "repair" && budget.usage.repairPasses >= budget.limits.maxRepairPasses) {
            throw new StructuredGenerationBudgetError(
              "repair_budget_exhausted",
              `The structured-generation repair budget of ${budget.limits.maxRepairPasses} is exhausted.`,
              snapshotStructuredGenerationBudget(budget),
            );
          }
          const permanentlyAvailableTokens =
            budget.limits.maxTotalTokens - budget.usage.totalTokens;
          const currentlyAvailableTokens =
            permanentlyAvailableTokens - reservations.totalTokens;
          const inputTokenReserve = estimatedInputTokenReserve(request);
          // Bedrock reports cache reads/writes in the charged total in addition
          // to ordinary input and output tokens. Cacheable prompt tokens are a
          // subset of the request input, so one extra input-sized reserve is a
          // conservative ceiling that keeps concurrent admission from spending
          // the same cache-accounting headroom twice.
          const cacheTokenReserve =
            this.config.provider === "bedrock" &&
            request.enablePromptCaching
            ? inputTokenReserve
            : 0;
          const requiresCacheAwareFit =
            cacheTokenReserve > 0 &&
            (reservations.totalTokens > 0 || budget.usage.totalTokens > 0);
          // Charged usage determines the request's real output ceiling. In-flight
          // reservations may delay admission, but must never shrink maxTokens and
          // turn a healthy structured request into a likely truncation.
          const permittedOutputTokens = Math.min(
            request.maxTokens,
            budget.limits.maxOutputTokens,
            permanentlyAvailableTokens -
              inputTokenReserve -
              (requiresCacheAwareFit ? cacheTokenReserve : 0),
          );
          if (permittedOutputTokens < 1) {
            throw new StructuredGenerationBudgetError(
              "token_budget_exhausted",
              `The structured-generation token budget is exhausted before another bounded request can start.`,
              snapshotStructuredGenerationBudget(budget),
            );
          }
          const requestTokenReservation =
            inputTokenReserve + cacheTokenReserve + permittedOutputTokens;
          if (
            requestTokenReservation > currentlyAvailableTokens &&
            reservations.totalTokens > 0
          ) {
            await waitForStructuredGenerationBudgetReservation(
              reservations,
              params.signal,
            );
            continue;
          }
          // Do not shrink a lone request's established output ceiling merely
          // because cache usage could reach its conservative maximum; actual
          // provider usage is still enforced after that response. For concurrent
          // or subsequent calls, require the full cache-aware reservation to fit
          // so they can never share already reserved or spent headroom.
          budget.usage.modelCalls += 1;
          if (phase === "repair") budget.usage.repairPasses += 1;
          // OpenRouter's configured fallback runtime can make at most one second
          // provider attempt. Direct Bedrock Converse has no cross-model fallback
          // and ignores maxProviderAttempts, so reserving a second attempt there
          // would only suppress useful concurrent synthesis work.
          const repairCallReserve =
            phase !== "repair" &&
            transportPreference.includes("text_repair_fallback") &&
            budget.usage.repairPasses < budget.limits.maxRepairPasses
              ? 1
              : 0;
          const availableAdditionalCalls =
            budget.limits.maxModelCalls -
            budget.usage.modelCalls -
            reservations.modelCalls -
            repairCallReserve;
          const providerAttemptLimit =
            this.config.provider !== "bedrock" &&
            availableAdditionalCalls >= 1 &&
            currentlyAvailableTokens >= requestTokenReservation * 2
              ? 2
              : 1;
          const reservedAdditionalCalls = providerAttemptLimit - 1;
          const reservedTokens = requestTokenReservation * providerAttemptLimit;
          reservations.modelCalls += reservedAdditionalCalls;
          reservations.totalTokens += reservedTokens;
          let reservationReleased = false;
          releaseAdmissionReservation = () => {
            if (reservationReleased) return;
            reservationReleased = true;
            reservations.modelCalls -= reservedAdditionalCalls;
            reservations.totalTokens -= reservedTokens;
            notifyStructuredGenerationBudgetWaiters(reservations);
          };
          boundedRequest = {
            ...request,
            maxTokens: permittedOutputTokens,
            maxProviderAttempts: providerAttemptLimit,
          };
          break;
        }
      }
      const chargeConservativeUnknownUsage = (attemptCount = 1) => {
        if (!budget) return;
        const baseInputTokens = estimatedInputTokenReserve(boundedRequest);
        const estimatedInputTokens = baseInputTokens *
          (
            this.config.provider === "bedrock" &&
            boundedRequest.enablePromptCaching
              ? 2
              : 1
          );
        const estimatedOutputTokens = boundedRequest.maxTokens;
        budget.usage.inputTokens += estimatedInputTokens * attemptCount;
        budget.usage.outputTokens += estimatedOutputTokens * attemptCount;
        budget.usage.totalTokens +=
          (estimatedInputTokens + estimatedOutputTokens) * attemptCount;
      };
      let response: Awaited<ReturnType<ConverseTextRuntime["converse"]>>;
      try {
        response = await (
          phase === "repair" && this.repairRuntime
            ? this.repairRuntime
            : this.runtime
        ).converse(boundedRequest);
      } catch (error) {
        try {
          if (isCallerCancellation(error, params.signal)) throw error;
          const providerAttemptCount = providerErrorAttemptCount(error);
          if (budget && providerAttemptCount > 1) {
            budget.usage.modelCalls += providerAttemptCount - 1;
          }
          const errorTokenUsage =
            error &&
            typeof error === "object" &&
            "tokenUsage" in error
              ? normalizeJsonValue(error.tokenUsage)
              : null;
          const failedAttemptCount =
            error &&
            typeof error === "object" &&
            "unknownUsageAttempts" in error &&
            typeof error.unknownUsageAttempts === "number"
              ? Math.max(0, Math.floor(error.unknownUsageAttempts))
              : errorTokenUsage
                ? 0
                : 1;
          unknownUsageAttempts += failedAttemptCount;
          const failureMetadata = providerFailureMetadata(error);
          if (failureMetadata) observedTokenUsage.push(failureMetadata);
          if (budget) {
            budget.usage.unknownUsageCalls += failedAttemptCount;
            // A disconnected or malformed provider response may still represent
            // a fully charged request. Consume the request's conservative
            // admission reserve so an unmetered attempt cannot bypass a shared
            // cumulative token ceiling through transport fallback.
            if (failedAttemptCount) {
              chargeConservativeUnknownUsage(failedAttemptCount);
            }
            if (errorTokenUsage) {
              const knownInput = numericTokenUsage(
                errorTokenUsage,
                "inputTokens",
              );
              const knownOutput = numericTokenUsage(
                errorTokenUsage,
                "outputTokens",
              );
              budget.usage.inputTokens += knownInput;
              budget.usage.outputTokens += knownOutput;
              budget.usage.totalTokens +=
                numericTokenUsage(errorTokenUsage, "totalTokens") ||
                knownInput + knownOutput;
            }
          }
        } finally {
          releaseAdmissionReservation();
        }
        throw error;
      }
      try {
        response = {
          ...response,
          tokenUsage: tokenUsageWithRequestId(
            response.tokenUsage,
            response.requestId,
          ),
        };
        const providerAttemptCount = providerAttemptCountIn(
          response.tokenUsage,
        );
        if (budget && providerAttemptCount > 1) {
          budget.usage.modelCalls += providerAttemptCount - 1;
        }
        if (response.tokenUsage) {
          observedTokenUsage.push(response.tokenUsage);
          const responseUnknownUsageAttempts = unknownUsageAttemptsIn(
            response.tokenUsage,
          );
          unknownUsageAttempts += responseUnknownUsageAttempts;
          if (budget && responseUnknownUsageAttempts) {
            budget.usage.unknownUsageCalls += responseUnknownUsageAttempts;
            chargeConservativeUnknownUsage(responseUnknownUsageAttempts);
          }
          const responseReportedCost = reportedCostIn(response.tokenUsage);
          if (responseReportedCost != null) {
            reportedCostUsd += responseReportedCost;
            hasReportedCost = true;
          }
        }
        else unknownUsageAttempts += 1;
        if (!budget) return response;
        const inputTokens = numericTokenUsage(response.tokenUsage, "inputTokens");
        const outputTokens = numericTokenUsage(response.tokenUsage, "outputTokens");
        const reportedTotal = numericTokenUsage(response.tokenUsage, "totalTokens");
        const totalTokens = reportedTotal || inputTokens + outputTokens;
        if (!response.tokenUsage) {
          budget.usage.unknownUsageCalls += 1;
          chargeConservativeUnknownUsage();
          return response;
        }
        budget.usage.inputTokens += inputTokens;
        budget.usage.outputTokens += outputTokens;
        budget.usage.totalTokens += totalTokens;
        if (budget.usage.totalTokens > budget.limits.maxTotalTokens) {
          throw new StructuredGenerationBudgetError(
            "token_budget_exhausted",
            `The provider reported ${budget.usage.totalTokens} cumulative tokens, exceeding the ${budget.limits.maxTotalTokens}-token budget.`,
            snapshotStructuredGenerationBudget(budget),
          );
        }
        return response;
      } finally {
        releaseAdmissionReservation();
      }
    };
    let lastFailure:
      | {
          status: GenerationFailureStatus;
          rawOutput: string | null;
          validationErrors: JsonValue | null;
          tokenUsage: JsonValue | null;
          transportMode: StructuredOutputTransportMode;
          stopReason: string | null;
        }
      | null = null;
    let hitOutputTokenLimit = false;

    for (const mode of nativeModes) {
      let response;

      try {
        response = await converse({
          systemPrompt: params.systemPrompt,
          userPrompt: params.userPrompt,
          maxTokens: params.maxTokens,
          temperature,
          effort,
          enablePromptCaching: true,
          signal: params.signal,
          structuredOutput: {
            mode,
            schemaName: params.schemaName,
            schemaDescription: params.schemaDescription,
            jsonSchema: params.jsonSchema,
          },
        }, "generation");
      } catch (error) {
        if (error instanceof StructuredGenerationBudgetError) throw error;
        if (isCallerCancellation(error, params.signal)) throw error;
        attempts.push({
          mode,
          phase: "generation",
          status: "provider_error",
          validationErrors: null,
          errorMessage:
            error instanceof Error
              ? error.message
              : `${this.providerName()} request failed.`,
        });
        lastFailure = {
          status: "provider_error",
          rawOutput: null,
          validationErrors: null,
          tokenUsage: null,
          transportMode: mode,
          stopReason: null,
        };
        if (!allowsStructuredTransportFallback(error)) {
          throw error;
        }
        continue;
      }

      if (
        response.stopReason === "content_filtered" ||
        response.stopReason === "guardrail_intervened"
      ) {
        attempts.push({
          mode,
          phase: "generation",
          status: "provider_error",
          validationErrors: null,
          errorMessage: "The model provider blocked the structured response.",
          stopReason: response.stopReason,
        });
        throw new StructuredOutputError(
          "The model provider blocked the structured response.",
          "provider_error",
          response.text || null,
          null,
          tokenUsageSnapshot(),
          mode,
          normalizeAttemptRecords(attempts),
          {
            retryable: false,
            providerCode: "response_blocked",
          },
        );
      }

      const parsed = this.parseStructuredResponse({
        schema: params.schema,
        rawText: response.text,
        structuredData: response.structuredData,
        extraValidation: params.extraValidation,
      });

      if (parsed.success) {
        attempts.push({
          mode,
          phase: "generation",
          status: "success",
          validationErrors: null,
          stopReason: response.stopReason ?? null,
        });

        return {
          data: parsed.data,
          rawOutput: parsed.rawOutput,
          parsedOutput: parsed.parsedJson,
          tokenUsage: tokenUsageSnapshot(),
          estimatedCostUsd: unknownUsageAttempts === 0 && hasReportedCost
            ? Number(reportedCostUsd.toFixed(8))
            : null,
          provider: response.provider ?? this.config.provider,
          modelId: response.modelId ?? this.config.modelId,
          region: this.config.region ?? null,
          requestId: response.requestId ?? null,
          transportMode: mode,
          attempts,
        };
      }

      attempts.push({
        mode,
        phase: "generation",
        status: parsed.status,
        validationErrors: parsed.validationErrors as JsonValue,
        errorMessage:
          response.stopReason === "max_tokens"
            ? `${this.providerName()} stopped at the output-token ceiling before returning complete structured output.`
            : null,
        stopReason: response.stopReason ?? null,
      });
      lastFailure = {
        status: parsed.status,
        rawOutput: parsed.rawOutput,
        validationErrors: parsed.validationErrors as JsonValue,
        tokenUsage: response.tokenUsage,
        transportMode: mode,
        stopReason: response.stopReason ?? null,
      };
      if (response.stopReason === "max_tokens") {
        // Switching from native JSON schema to strict tool use repeats the same
        // full synthesis with the same output ceiling. Preserve the charged
        // partial result and route it directly into the single bounded repair
        // pass instead of paying for a predictably identical truncation.
        hitOutputTokenLimit = true;
        break;
      }
    }

    if (!transportPreference.includes("text_repair_fallback")) {
      throw new StructuredOutputError(
        `${this.providerName()} output did not satisfy the required structured schema.`,
        lastFailure?.status ?? "provider_error",
        lastFailure?.rawOutput ?? null,
        lastFailure?.validationErrors ?? null,
        tokenUsageSnapshot(),
        lastFailure?.transportMode ?? null,
        normalizeAttemptRecords(attempts),
      );
    }

    let firstTextResponse: Awaited<ReturnType<ConverseTextRuntime["converse"]>>;
    const repairSource =
      params.repairStrategy === "repair_last_failure" || hitOutputTokenLimit
        ? lastFailure
        : null;

    if (hitOutputTokenLimit && !repairSource?.rawOutput) {
      throw new StructuredOutputError(
        `${this.providerName()} reached the output-token ceiling without returning partial structured output that could be repaired.`,
        lastFailure?.status ?? "parse_error",
        null,
        lastFailure?.validationErrors ?? null,
        tokenUsageSnapshot(),
        lastFailure?.transportMode ?? null,
        normalizeAttemptRecords(attempts),
      );
    }

    if (repairSource?.rawOutput) {
      firstTextResponse = {
        text: repairSource.rawOutput,
        structuredData: null,
        tokenUsage: repairSource.tokenUsage,
        stopReason: repairSource.stopReason,
      };
    } else {
      try {
        firstTextResponse = await converse({
          systemPrompt: params.systemPrompt,
          userPrompt: params.userPrompt,
          maxTokens: params.maxTokens,
          temperature,
          effort,
          enablePromptCaching: true,
          signal: params.signal,
        }, "generation");
      } catch (error) {
        if (error instanceof StructuredGenerationBudgetError) throw error;
        if (isCallerCancellation(error, params.signal)) throw error;
        attempts.push({
          mode: "text_repair_fallback",
          phase: "generation",
          status: "provider_error",
          validationErrors: null,
          errorMessage:
            error instanceof Error
              ? error.message
              : `${this.providerName()} request failed.`,
        });

        throw new StructuredOutputError(
          error instanceof Error
            ? error.message
            : `${this.providerName()} request failed.`,
          "provider_error",
          lastFailure?.rawOutput ?? null,
          lastFailure?.validationErrors ?? null,
          tokenUsageSnapshot(),
          "text_repair_fallback",
          normalizeAttemptRecords(attempts),
        );
      }
    }

    const firstAttempt = this.parseStructuredResponse({
      schema: params.schema,
      rawText: firstTextResponse.text,
      structuredData: firstTextResponse.structuredData,
      extraValidation: params.extraValidation,
    });

    if (firstAttempt.success) {
      if (!repairSource?.rawOutput) {
        attempts.push({
          mode: "text_repair_fallback",
          phase: "generation",
          status: "success",
          validationErrors: null,
          errorMessage: null,
          stopReason: firstTextResponse.stopReason ?? null,
        });
      }

      return {
        data: firstAttempt.data,
        rawOutput: firstAttempt.rawOutput,
        parsedOutput: firstAttempt.parsedJson,
        tokenUsage: tokenUsageSnapshot(),
        estimatedCostUsd: unknownUsageAttempts === 0 && hasReportedCost
          ? Number(reportedCostUsd.toFixed(8))
          : null,
        provider: firstTextResponse.provider ?? this.config.provider,
        modelId: firstTextResponse.modelId ?? this.config.modelId,
        region: this.config.region ?? null,
        requestId: firstTextResponse.requestId ?? null,
        transportMode: "text_repair_fallback" as const,
        attempts,
      };
    }

    if (!repairSource?.rawOutput) {
      attempts.push({
        mode: "text_repair_fallback",
        phase: "generation",
        status: firstAttempt.status,
        validationErrors: firstAttempt.validationErrors as JsonValue,
        errorMessage:
          firstTextResponse.stopReason === "max_tokens"
            ? `${this.providerName()} stopped at the output-token ceiling before returning complete structured output.`
            : null,
        stopReason: firstTextResponse.stopReason ?? null,
      });
    }

    let repairResponse;

    try {
      repairResponse = await converse({
        systemPrompt:
          "You repair structured model outputs. Return JSON only and match the provided schema exactly.",
        userPrompt: buildSchemaAwareRepairPrompt({
          schemaName: params.schemaName,
          schemaDescription: params.schemaDescription,
          jsonSchema: params.jsonSchema,
          exampleOutput: params.exampleOutput,
          requiredFieldPaths: params.requiredFieldPaths,
          repairMappings: params.repairMappings,
          validationErrors: firstAttempt.validationErrors as JsonValue,
          originalOutput: firstAttempt.rawOutput,
        }),
        maxTokens: params.maxTokens,
        temperature: 0,
        effort: "medium",
        enablePromptCaching: true,
        signal: params.signal,
      }, "repair");
    } catch (error) {
      if (error instanceof StructuredGenerationBudgetError) throw error;
      if (isCallerCancellation(error, params.signal)) throw error;
      attempts.push({
        mode: "text_repair_fallback",
        phase: "repair",
        status: "provider_error",
        validationErrors: null,
        errorMessage:
          error instanceof Error
            ? error.message
            : `${this.providerName()} repair request failed.`,
      });

      throw new StructuredOutputError(
        error instanceof Error
          ? error.message
          : `${this.providerName()} repair request failed.`,
        "provider_error",
        firstAttempt.rawOutput,
        firstAttempt.validationErrors as JsonValue,
        tokenUsageSnapshot(),
        "text_repair_fallback",
        normalizeAttemptRecords(attempts),
      );
    }

    const repairedAttempt = this.parseStructuredResponse({
      schema: params.schema,
      rawText: repairResponse.text,
      structuredData: repairResponse.structuredData,
      extraValidation: params.extraValidation,
    });

    const combinedRawOutput = [
      "Initial output:",
      firstAttempt.rawOutput,
      "",
      "Repair output:",
      repairedAttempt.rawOutput,
    ].join("\n");

    if (repairedAttempt.success) {
      attempts.push({
        mode: "text_repair_fallback",
        phase: "repair",
        status: "success",
        validationErrors: null,
        errorMessage: null,
        stopReason: repairResponse.stopReason ?? null,
      });

      return {
        data: repairedAttempt.data,
        rawOutput: combinedRawOutput,
        parsedOutput: repairedAttempt.parsedJson,
        tokenUsage: tokenUsageSnapshot(),
        estimatedCostUsd: unknownUsageAttempts === 0 && hasReportedCost
          ? Number(reportedCostUsd.toFixed(8))
          : null,
        provider: repairResponse.provider ?? this.config.provider,
        modelId: repairResponse.modelId ?? this.config.modelId,
        region: this.config.region ?? null,
        requestId: repairResponse.requestId ?? null,
        transportMode: "text_repair_fallback" as const,
        attempts,
      };
    }

    attempts.push({
      mode: "text_repair_fallback",
      phase: "repair",
      status: repairedAttempt.status,
      validationErrors: repairedAttempt.validationErrors as JsonValue,
      errorMessage:
        repairResponse.stopReason === "max_tokens"
          ? `${this.providerName()} stopped at the output-token ceiling before returning complete structured output.`
          : null,
      stopReason: repairResponse.stopReason ?? null,
    });

    throw new StructuredOutputError(
      `${this.providerName()} output could not be repaired into valid structured JSON.`,
      repairedAttempt.status,
      combinedRawOutput,
      repairedAttempt.validationErrors as JsonValue,
      tokenUsageSnapshot(),
      "text_repair_fallback",
      normalizeAttemptRecords(attempts),
    );
  }
}
