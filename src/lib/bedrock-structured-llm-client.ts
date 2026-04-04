import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { z } from "zod";
import type { JsonValue } from "@/src/domain/types";

type GenerationFailureStatus = "provider_error" | "parse_error" | "validation_error";

export interface ConverseTextRuntime {
  converse(input: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
  }): Promise<{
    text: string;
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
  ) {
    super(message);
  }
}

class AwsBedrockConverseRuntime implements ConverseTextRuntime {
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
  }) {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.config.modelId,
        system: [
          {
            text: input.systemPrompt,
          },
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
          temperature: input.temperature,
        },
      }),
    );

    const text =
      response.output?.message?.content
        ?.map((contentBlock) => ("text" in contentBlock ? contentBlock.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim() ?? "";

    return {
      text,
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

  private parseStructuredOutput<T>(
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

    const structured = schema.safeParse(parsedJson);

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
      parsedJson: parsedJson as JsonValue,
    };
  }

  async generateStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodType<T>;
    maxTokens: number;
    temperature?: number;
    extraValidation?: (value: T) => string[];
  }) {
    const temperature = params.temperature ?? 0;

    let firstResponse;

    try {
      firstResponse = await this.runtime.converse({
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        maxTokens: params.maxTokens,
        temperature,
      });
    } catch (error) {
      throw new StructuredOutputError(
        error instanceof Error ? error.message : "Bedrock request failed.",
        "provider_error",
        null,
        null,
        null,
      );
    }

    const firstAttempt = this.parseStructuredOutput(
      params.schema,
      firstResponse.text,
      params.extraValidation,
    );

    if (firstAttempt.success) {
      return {
        data: firstAttempt.data,
        rawOutput: firstResponse.text,
        parsedOutput: firstAttempt.parsedJson,
        tokenUsage: firstResponse.tokenUsage,
        estimatedCostUsd: null,
        provider: this.config.provider,
        modelId: this.config.modelId,
        region: this.config.region,
      };
    }

    let repairResponse;

    try {
      repairResponse = await this.runtime.converse({
        systemPrompt:
          "You repair model outputs into strict JSON. Return JSON only. Do not add markdown, explanation, or code fences.",
        userPrompt: [
          "Repair the previous response so it is valid JSON for the original task.",
          "Validation problems:",
          JSON.stringify(firstAttempt.validationErrors, null, 2),
          "Original output:",
          firstResponse.text,
        ].join("\n\n"),
        maxTokens: params.maxTokens,
        temperature: 0,
      });
    } catch (error) {
      throw new StructuredOutputError(
        error instanceof Error ? error.message : "Bedrock repair request failed.",
        "provider_error",
        firstResponse.text,
        firstAttempt.validationErrors as JsonValue,
        firstResponse.tokenUsage,
      );
    }

    const repairedAttempt = this.parseStructuredOutput(
      params.schema,
      repairResponse.text,
      params.extraValidation,
    );

    const combinedRawOutput = [
      "Initial output:",
      firstResponse.text,
      "",
      "Repair output:",
      repairResponse.text,
    ].join("\n");

    if (repairedAttempt.success) {
      return {
        data: repairedAttempt.data,
        rawOutput: combinedRawOutput,
        parsedOutput: repairedAttempt.parsedJson,
        tokenUsage:
          firstResponse.tokenUsage || repairResponse.tokenUsage
            ? ({
                firstAttempt: firstResponse.tokenUsage,
                repairAttempt: repairResponse.tokenUsage,
              } as JsonValue)
            : null,
        estimatedCostUsd: null,
        provider: this.config.provider,
        modelId: this.config.modelId,
        region: this.config.region,
      };
    }

    throw new StructuredOutputError(
      "Bedrock output could not be repaired into valid structured JSON.",
      repairedAttempt.status,
      combinedRawOutput,
      repairedAttempt.validationErrors as JsonValue,
      firstResponse.tokenUsage || repairResponse.tokenUsage
        ? ({
            firstAttempt: firstResponse.tokenUsage,
            repairAttempt: repairResponse.tokenUsage,
          } as JsonValue)
        : null,
    );
  }
}
