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

export interface StructuredOutputAttemptRecord {
  mode: StructuredOutputTransportMode;
  phase: StructuredGenerationPhase;
  status: "success" | GenerationFailureStatus;
  validationErrors: JsonValue | null;
  errorMessage?: string | null;
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
  }>;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly status: GenerationFailureStatus,
    public readonly rawOutput: string | null,
    public readonly validationErrors: JsonValue | null,
    public readonly tokenUsage: JsonValue | null,
    public readonly transportMode: StructuredOutputTransportMode | null,
    public readonly attempts: JsonValue | null,
  ) {
    super(message);
  }
}

function normalizeJsonValue(value: unknown): JsonValue | null {
  if (value == null) {
    return null;
  }

  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function normalizeAttemptRecords(attempts: StructuredOutputAttemptRecord[]) {
  return normalizeJsonValue(attempts);
}

function numericTokenUsage(value: JsonValue | null, key: "inputTokens" | "outputTokens" | "totalTokens") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? Math.floor(candidate)
    : 0;
}

function estimatedInputTokenReserve(input: Parameters<ConverseTextRuntime["converse"]>[0]) {
  const schemaBytes = input.structuredOutput
    ? Buffer.byteLength(JSON.stringify(input.structuredOutput.jsonSchema), "utf8") +
      Buffer.byteLength(input.structuredOutput.schemaName, "utf8") +
      Buffer.byteLength(input.structuredOutput.schemaDescription, "utf8")
    : 0;
  const promptBytes = Buffer.byteLength(input.systemPrompt, "utf8") +
    Buffer.byteLength(input.userPrompt, "utf8") +
    schemaBytes;
  // Source code and English prompts normally encode several UTF-8 bytes per
  // token. Reserving one token per two bytes remains deliberately conservative
  // for mixed code/JSON while avoiding the old one-byte assumption, which
  // rejected safe requests and starved their output before any provider call.
  // The fixed reserve covers Bedrock's message/tool envelope. Actual reported
  // usage is still enforced after every call, so this is admission headroom,
  // not a replacement for the hard cumulative budget.
  return Math.ceil(promptBytes / 2) + 512;
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
          input.structuredOutput?.mode === "bedrock_json_schema"
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
      { abortSignal: AbortSignal.timeout(requestTimeoutMs) },
    );

    return {
      text: readTextFromContent(response.output?.message?.content),
      structuredData: readToolInputFromContent(response.output?.message?.content),
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
      provider: "bedrock";
      region: string;
      modelId: string;
    },
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
  }) {
    const temperature = params.temperature ?? 0;
    const effort = params.effort ?? "high";
    const transportPreference = params.transportPreference ?? [
      "bedrock_json_schema",
      "strict_tool_use",
      "text_repair_fallback",
    ];
    const nativeModes = transportPreference.filter(
      (mode): mode is NativeStructuredOutputMode => mode !== "text_repair_fallback",
    );
    const attempts: StructuredOutputAttemptRecord[] = [];
    const observedTokenUsage: JsonValue[] = [];
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
      if (budget) {
        if (budget.usage.modelCalls >= budget.limits.maxModelCalls) {
          throw new StructuredGenerationBudgetError(
            "model_call_budget_exhausted",
            `The structured-generation model-call budget of ${budget.limits.maxModelCalls} is exhausted.`,
            snapshotStructuredGenerationBudget(budget),
          );
        }
        if (phase === "repair" && budget.usage.repairPasses >= budget.limits.maxRepairPasses) {
          throw new StructuredGenerationBudgetError(
            "repair_budget_exhausted",
            `The structured-generation repair budget of ${budget.limits.maxRepairPasses} is exhausted.`,
            snapshotStructuredGenerationBudget(budget),
          );
        }
        const remainingTokens = budget.limits.maxTotalTokens - budget.usage.totalTokens;
        const inputTokenReserve = estimatedInputTokenReserve(request);
        const permittedOutputTokens = Math.min(
          request.maxTokens,
          budget.limits.maxOutputTokens,
          remainingTokens - inputTokenReserve,
        );
        if (permittedOutputTokens < 1) {
          throw new StructuredGenerationBudgetError(
            "token_budget_exhausted",
            `The structured-generation token budget is exhausted before another bounded request can start.`,
            snapshotStructuredGenerationBudget(budget),
          );
        }
        budget.usage.modelCalls += 1;
        if (phase === "repair") budget.usage.repairPasses += 1;
        boundedRequest = { ...request, maxTokens: permittedOutputTokens };
      }
      let response: Awaited<ReturnType<ConverseTextRuntime["converse"]>>;
      try {
        response = await this.runtime.converse(boundedRequest);
      } catch (error) {
        unknownUsageAttempts += 1;
        if (budget) budget.usage.unknownUsageCalls += 1;
        throw error;
      }
      if (response.tokenUsage) observedTokenUsage.push(response.tokenUsage);
      else unknownUsageAttempts += 1;
      if (!budget) return response;
      const inputTokens = numericTokenUsage(response.tokenUsage, "inputTokens");
      const outputTokens = numericTokenUsage(response.tokenUsage, "outputTokens");
      const reportedTotal = numericTokenUsage(response.tokenUsage, "totalTokens");
      const totalTokens = reportedTotal || inputTokens + outputTokens;
      if (!response.tokenUsage) budget.usage.unknownUsageCalls += 1;
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
    };
    let lastFailure:
      | {
          status: GenerationFailureStatus;
          rawOutput: string | null;
          validationErrors: JsonValue | null;
          tokenUsage: JsonValue | null;
          transportMode: StructuredOutputTransportMode;
        }
      | null = null;

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
          structuredOutput: {
            mode,
            schemaName: params.schemaName,
            schemaDescription: params.schemaDescription,
            jsonSchema: params.jsonSchema,
          },
        }, "generation");
      } catch (error) {
        if (error instanceof StructuredGenerationBudgetError) throw error;
        attempts.push({
          mode,
          phase: "generation",
          status: "provider_error",
          validationErrors: null,
          errorMessage: error instanceof Error ? error.message : "Bedrock request failed.",
        });
        lastFailure = {
          status: "provider_error",
          rawOutput: null,
          validationErrors: null,
          tokenUsage: null,
          transportMode: mode,
        };
        continue;
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
        });

        return {
          data: parsed.data,
          rawOutput: parsed.rawOutput,
          parsedOutput: parsed.parsedJson,
          tokenUsage: tokenUsageSnapshot(),
          estimatedCostUsd: null,
          provider: this.config.provider,
          modelId: this.config.modelId,
          region: this.config.region,
          transportMode: mode,
          attempts,
        };
      }

      attempts.push({
        mode,
        phase: "generation",
        status: parsed.status,
        validationErrors: parsed.validationErrors as JsonValue,
        errorMessage: null,
      });
      lastFailure = {
        status: parsed.status,
        rawOutput: parsed.rawOutput,
        validationErrors: parsed.validationErrors as JsonValue,
        tokenUsage: response.tokenUsage,
        transportMode: mode,
      };
    }

    if (!transportPreference.includes("text_repair_fallback")) {
      throw new StructuredOutputError(
        "Bedrock output did not satisfy the required structured schema.",
        lastFailure?.status ?? "provider_error",
        lastFailure?.rawOutput ?? null,
        lastFailure?.validationErrors ?? null,
        tokenUsageSnapshot(),
        lastFailure?.transportMode ?? null,
        normalizeAttemptRecords(attempts),
      );
    }

    let firstTextResponse: Awaited<ReturnType<ConverseTextRuntime["converse"]>>;
    const repairSource = params.repairStrategy === "repair_last_failure" ? lastFailure : null;

    if (repairSource?.rawOutput) {
      firstTextResponse = {
        text: repairSource.rawOutput,
        structuredData: null,
        tokenUsage: repairSource.tokenUsage,
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
        }, "generation");
      } catch (error) {
        if (error instanceof StructuredGenerationBudgetError) throw error;
        attempts.push({
          mode: "text_repair_fallback",
          phase: "generation",
          status: "provider_error",
          validationErrors: null,
          errorMessage: error instanceof Error ? error.message : "Bedrock request failed.",
        });

        throw new StructuredOutputError(
          error instanceof Error ? error.message : "Bedrock request failed.",
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
        });
      }

      return {
        data: firstAttempt.data,
        rawOutput: firstAttempt.rawOutput,
        parsedOutput: firstAttempt.parsedJson,
        tokenUsage: tokenUsageSnapshot(),
        estimatedCostUsd: null,
        provider: this.config.provider,
        modelId: this.config.modelId,
        region: this.config.region,
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
        errorMessage: null,
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
      }, "repair");
    } catch (error) {
      if (error instanceof StructuredGenerationBudgetError) throw error;
      attempts.push({
        mode: "text_repair_fallback",
        phase: "repair",
        status: "provider_error",
        validationErrors: null,
        errorMessage:
          error instanceof Error ? error.message : "Bedrock repair request failed.",
      });

      throw new StructuredOutputError(
        error instanceof Error ? error.message : "Bedrock repair request failed.",
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
      });

      return {
        data: repairedAttempt.data,
        rawOutput: combinedRawOutput,
        parsedOutput: repairedAttempt.parsedJson,
        tokenUsage: tokenUsageSnapshot(),
        estimatedCostUsd: null,
        provider: this.config.provider,
        modelId: this.config.modelId,
        region: this.config.region,
        transportMode: "text_repair_fallback" as const,
        attempts,
      };
    }

    attempts.push({
      mode: "text_repair_fallback",
      phase: "repair",
      status: repairedAttempt.status,
      validationErrors: repairedAttempt.validationErrors as JsonValue,
      errorMessage: null,
    });

    throw new StructuredOutputError(
      "Bedrock output could not be repaired into valid structured JSON.",
      repairedAttempt.status,
      combinedRawOutput,
      repairedAttempt.validationErrors as JsonValue,
      tokenUsageSnapshot(),
      "text_repair_fallback",
      normalizeAttemptRecords(attempts),
    );
  }
}
