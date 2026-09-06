import type { ConverseTextRuntime } from "@/src/lib/bedrock-structured-llm-client";
import { BedrockConverseAgent, defineBedrockConverseTool } from "@/src/lib/bedrock-converse-agent";
import { z } from "zod";
import type { OpenRouterTextConfig } from "@/src/lib/llm-config";
import {
  OpenRouterChatCompletionsRuntime,
  OpenRouterConverseTransport,
  OpenRouterRequestError,
  resetOpenRouterPacingForTests,
  RetryableFallbackTextRuntime,
  RetryableSameModelConverseTransport,
  RetryableSameModelTextRuntime,
} from "@/src/lib/openrouter-client";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => resetOpenRouterPacingForTests());

function config(
  overrides: Partial<OpenRouterTextConfig> = {},
): OpenRouterTextConfig {
  return {
    provider: "openrouter",
    baseUrl: "https://openrouter.example/api/v1",
    apiKey: "test-key",
    modelId: "openai/gpt-5.6-terra",
    fallbackModelId: "anthropic/claude-sonnet-5",
    profile: "primary_answer",
    requestTimeoutMs: 30_000,
    minRequestIntervalMs: 0,
    providerOrder: ["openai"],
    siteUrl: "https://workbase.example",
    appName: "Workbase test",
    zeroDataRetention: true,
    requireParameters: true,
    sendTemperature: false,
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "x-request-id": "req_header_1" },
  });
}

const constraintRichJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "optionalNote", "score", "items"],
  properties: {
    label: {
      type: "string",
      minLength: 2,
      maxLength: 40,
      enum: ["ready", "blocked"],
    },
    optionalNote: {
      anyOf: [
        { type: "string", maxLength: 120 },
        { type: "null" },
      ],
    },
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      multipleOf: 0.1,
    },
    items: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "integer",
        minimum: 0,
      },
    },
  },
};

const constraintCompatibleJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "optionalNote", "score", "items"],
  properties: {
    label: {
      type: "string",
      enum: ["ready", "blocked"],
    },
    optionalNote: {
      anyOf: [
        { type: "string" },
        { type: "null" },
      ],
    },
    score: {
      type: "number",
    },
    items: {
      type: "array",
      items: {
        type: "integer",
      },
    },
  },
};

interface StructuredRequestBody {
  response_format?: {
    json_schema: {
      schema: unknown;
    };
  };
  tools?: Array<{
    function: {
      parameters: unknown;
    };
  }>;
}

async function structuredRequestBody(
  modelId: string,
  mode: "json_schema" | "strict_tool_use",
) {
  const fetchMock = vi.fn().mockResolvedValue(
    response({
      choices: [
        mode === "strict_tool_use"
          ? {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "tool_compatible_schema",
                    function: {
                      name: "workbase_result",
                      arguments:
                        '{"label":"ready","optionalNote":null,"score":1,"items":[0,1]}',
                    },
                  },
                ],
              },
            }
          : {
              finish_reason: "stop",
              message: {
                content:
                  '{"label":"ready","optionalNote":null,"score":1,"items":[0,1]}',
              },
            },
      ],
    }),
  );
  const runtime = new OpenRouterChatCompletionsRuntime(
    config(),
    modelId,
    fetchMock,
  );
  await runtime.converse({
    systemPrompt: "Return the requested result.",
    userPrompt: "Return a ready result.",
    maxTokens: 128,
    temperature: 0,
    structuredOutput: {
      mode,
      schemaName: "workbase_result",
      schemaDescription: "A structured compatibility result.",
      jsonSchema: constraintRichJsonSchema,
    },
  });

  return JSON.parse(
    String(fetchMock.mock.calls[0]![1].body),
  ) as StructuredRequestBody;
}

function schemaFromStructuredRequest(body: StructuredRequestBody) {
  return body.response_format?.json_schema.schema ??
    body.tools?.[0]?.function.parameters;
}

describe("OpenRouterChatCompletionsRuntime", () => {
  it("requires strict ZDR, parameter support, usage accounting, and structured output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: "gen_1",
        model: "openai/gpt-5.6-terra-202607",
        provider: "openai",
        choices: [
          {
            finish_reason: "stop",
            message: { content: "{\"status\":\"ok\"}" },
          },
        ],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 4,
          total_tokens: 25,
          cost: 0.00042,
          prompt_tokens_details: { cached_tokens: 10 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }),
    );
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      fetchMock,
    );
    const result = await runtime.converse({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      maxTokens: 128,
      temperature: 0,
      effort: "low",
      enablePromptCaching: true,
      structuredOutput: {
        mode: "json_schema",
        schemaName: "status",
        schemaDescription: "A status result.",
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string" } },
        },
      },
    });

    const [, request] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(request.body));
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "HTTP-Referer": "https://workbase.example",
      "X-Title": "Workbase test",
      "x-anthropic-beta": "structured-outputs-2025-11-13",
    });
    expect(body.provider).toEqual({
      zdr: true,
      require_parameters: true,
      allow_fallbacks: true,
      order: ["openai"],
    });
    expect(body.usage).toEqual({ include: true });
    expect(body.max_completion_tokens).toBe(128);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "status", strict: true },
    });
    expect(body.messages[0].content).toBe("Return JSON.");
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(result).toMatchObject({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra-202607",
      requestId: "req_header_1",
      stopReason: "end_turn",
      tokenUsage: {
        inputTokens: 21,
        outputTokens: 4,
        totalTokens: 25,
        cacheReadInputTokens: 10,
        reasoningTokens: 2,
        provider: "openrouter",
        cost: 0.00042,
        routedProvider: "openai",
      },
    });
  });

  it("uses Anthropic's advertised max_tokens parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: "gen_anthropic_1",
        model: "anthropic/claude-sonnet-5",
        provider: "anthropic",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "tool_anthropic_status",
                  function: {
                    name: "status",
                    arguments: "{\"status\":\"ok\"}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          cost: 0.0001,
        },
      }),
    );
    const runtime = new OpenRouterChatCompletionsRuntime(
      config({ modelId: "anthropic/claude-sonnet-5" }),
      undefined,
      fetchMock,
    );

    const result = await runtime.converse({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      maxTokens: 128,
      temperature: 0,
      structuredOutput: {
        mode: "json_schema",
        schemaName: "status",
        schemaDescription: "A status result.",
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["status"],
          properties: { status: { type: "string" } },
        },
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.max_tokens).toBe(128);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(body.tools[0].function).not.toHaveProperty("strict");
    expect(result.structuredData).toEqual({ status: "ok" });
  });

  it("removes only unsupported constraints from Anthropic native and strict-tool schemas", async () => {
    for (const mode of ["json_schema", "strict_tool_use"] as const) {
      const body = await structuredRequestBody(
        "anthropic/claude-sonnet-5",
        mode,
      );
      expect(schemaFromStructuredRequest(body)).toEqual(
        constraintCompatibleJsonSchema,
      );
    }

    expect(constraintRichJsonSchema.properties.optionalNote.anyOf).toEqual([
      { type: "string", maxLength: 120 },
      { type: "null" },
    ]);
  });

  it("retains full JSON Schema constraints for OpenAI native and strict-tool requests", async () => {
    for (const mode of ["json_schema", "strict_tool_use"] as const) {
      const body = await structuredRequestBody(
        "openai/gpt-5.6-terra",
        mode,
      );
      expect(schemaFromStructuredRequest(body)).toEqual(
        constraintRichJsonSchema,
      );
    }
  });

  it("maps strict structured tool calls without parsing them as text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "tool_1",
                  function: {
                    name: "workbase_result",
                    arguments: "{\"status\":\"ok\"}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          total_tokens: 13,
          cost: 0.001,
        },
      }),
    );
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      fetchMock,
    );
    const result = await runtime.converse({
      systemPrompt: "Use the tool.",
      userPrompt: "Return ok.",
      maxTokens: 64,
      temperature: 0,
      structuredOutput: {
        mode: "strict_tool_use",
        schemaName: "workbase_result",
        schemaDescription: "A status result.",
        jsonSchema: { type: "object" },
      },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "workbase_result" },
    });
    expect(body.tools[0].function.strict).toBe(true);
    expect(result.structuredData).toEqual({ status: "ok" });
    expect(result.stopReason).toBe("tool_use");
  });

  it("classifies HTTP failures for safe fallback decisions", async () => {
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      vi.fn().mockResolvedValue(
        response({ error: { message: "rate limited" } }, 429),
      ),
    );
    await expect(
      runtime.converse({
        systemPrompt: "test",
        userPrompt: "test",
        maxTokens: 16,
        temperature: 0,
      }),
    ).rejects.toMatchObject({
      message: "OpenRouter rate-limited this request.",
      status: 429,
      retryable: true,
      requestId: "req_header_1",
    });
  });

  it("paces consecutive starts for the same model before they can burst", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(async () =>
        response({
          model: "openai/gpt-5.6-luna",
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      const runtime = new OpenRouterChatCompletionsRuntime(
        config({
          baseUrl: "https://paced-openrouter.example/api/v1",
          modelId: "openai/gpt-5.6-luna",
          minRequestIntervalMs: 2_500,
        }),
        undefined,
        fetchMock,
      );
      const input = {
        systemPrompt: "test",
        userPrompt: "test",
        maxTokens: 16,
        temperature: 0,
      };

      await runtime.converse(input);
      const second = runtime.converse(input);
      await vi.advanceTimersByTimeAsync(2_499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose provider billing URLs or key identifiers", async () => {
    const providerMessage =
      "Insufficient credits. Manage key sk-or-v1-sensitive at https://openrouter.ai/settings/keys/key_sensitive?workspace=ws_private";
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: providerMessage,
              code: 402,
              metadata: {
                error_type:
                  "billing_error https://openrouter.ai/settings/keys/key_sensitive",
              },
            },
          }),
          {
            status: 402,
            headers: {
              "x-request-id":
                "https://openrouter.ai/settings/keys/key_sensitive",
              "retry-after": "https://openrouter.ai/settings/credits",
            },
          },
        ),
      ),
    );

    let failure: unknown;
    try {
      await runtime.converse({
        systemPrompt: "test",
        userPrompt: "test",
        maxTokens: 16,
        temperature: 0,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenRouterRequestError);
    expect(failure).toMatchObject({
      message: "OpenRouter account credits are insufficient for this request.",
      status: 402,
      retryable: false,
      requestId: null,
      code: "402",
      errorType: null,
      retryAfter: null,
    });
    expect(JSON.stringify(failure)).not.toContain("key_sensitive");
    expect(String(failure)).not.toContain("openrouter.ai");
    expect(String(failure)).not.toContain("sk-or-");
  });

  it("retains only a typed capability signal from unsafe provider metadata", async () => {
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message:
                "JSON schema is not supported. Inspect key_sensitive at https://openrouter.ai/settings/keys/key_sensitive.",
              code: "workspace_private",
              metadata: { error_type: "key_sensitive" },
            },
            choices: [{
              message: {
                content:
                  "provider diagnostic key_sensitive https://openrouter.ai/settings/keys/key_sensitive",
              },
            }],
          }),
          {
            status: 400,
            headers: {
              "x-request-id": "sk-or-v1-sensitive",
              "retry-after": "key_sensitive 29 Jul 2026",
            },
          },
        ),
      ),
    );

    let failure: unknown;
    try {
      await runtime.converse({
        systemPrompt: "test",
        userPrompt: "test",
        maxTokens: 16,
        temperature: 0,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message:
        "The selected OpenRouter endpoint does not support the requested structured output capability.",
      status: 400,
      retryable: false,
      requestId: null,
      code: null,
      errorType: null,
      retryAfter: null,
      partialContent: null,
      capability: "structured_output",
    });
    const serialized = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(serialized).not.toContain("key_sensitive");
    expect(serialized).not.toContain("workspace_private");
    expect(serialized).not.toContain("openrouter.ai");
    expect(serialized).not.toContain("sk-or-");
  });

  it("normalizes HTTP-200 choice errors with partial billed usage", async () => {
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      vi.fn().mockResolvedValue(
        response({
          id: "gen_error",
          model: "openai/gpt-5.6-terra",
          provider: "openai",
          choices: [
            {
              finish_reason: "error",
              error: {
                message: "Upstream provider temporarily unavailable.",
                code: 503,
                metadata: { error_type: "provider_error" },
              },
              message: { content: "partial" },
            },
          ],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 2,
            total_tokens: 11,
            cost: 0.0003,
          },
        }),
      ),
    );

    await expect(runtime.converse({
      systemPrompt: "test",
      userPrompt: "test",
      maxTokens: 16,
      temperature: 0,
    })).rejects.toMatchObject({
      status: 503,
      retryable: true,
      errorType: "provider_error",
      unknownUsageAttempts: 0,
      partialContent: "partial",
      tokenUsage: expect.objectContaining({
        totalTokens: 11,
        provider: "openrouter",
        cost: 0.0003,
      }),
    });
  });

  it("preserves billed usage and request metadata when no choice is returned", async () => {
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      vi.fn().mockResolvedValue(
        response({
          id: "gen_no_choice",
          model: "openai/gpt-5.6-terra",
          provider: "openai",
          choices: [],
          usage: {
            prompt_tokens: 9,
            completion_tokens: 0,
            total_tokens: 9,
            cost: 0.0002,
          },
        }),
      ),
    );

    await expect(runtime.converse({
      systemPrompt: "test",
      userPrompt: "test",
      maxTokens: 16,
      temperature: 0,
    })).rejects.toMatchObject({
      code: "no_completion_choices",
      requestId: "req_header_1",
      retryable: true,
      unknownUsageAttempts: 0,
      tokenUsage: expect.objectContaining({
        requestId: "req_header_1",
        modelId: "openai/gpt-5.6-terra",
        provider: "openrouter",
        routedProvider: "openai",
        totalTokens: 9,
        cost: 0.0002,
      }),
    });
  });

  it("treats refusals as terminal rather than format failures", async () => {
    const runtime = new OpenRouterChatCompletionsRuntime(
      config(),
      undefined,
      vi.fn().mockResolvedValue(
        response({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "", refusal: "Cannot comply." },
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6,
            cost: 0.0001,
          },
        }),
      ),
    );

    await expect(runtime.converse({
      systemPrompt: "test",
      userPrompt: "test",
      maxTokens: 16,
      temperature: 0,
    })).rejects.toMatchObject({
      code: "response_blocked",
      retryable: false,
      unknownUsageAttempts: 0,
    });
  });
});

describe("RetryableSameModelTextRuntime", () => {
  const input = {
    systemPrompt: "test",
    userPrompt: "test",
    maxTokens: 16,
    temperature: 0,
    maxProviderAttempts: 2,
  };

  it("retries an unbilled 429 on the same model and preserves both attempts", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({
            error: {
              message: "rate limited",
              code: 429,
              metadata: { error_type: "rate_limit_exceeded" },
            },
          }),
          {
            status: 429,
            headers: {
              "x-request-id": "req_rate_limited",
              "retry-after": "0",
            },
          },
        ))
        .mockResolvedValueOnce(response({
          model: "openai/gpt-5.6-terra",
          provider: "openai",
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 1,
            total_tokens: 8,
            cost: 0.0002,
          },
        }));
      const runtimeConfig = config({
        baseUrl: "https://same-model-retry.example/api/v1",
      });
      const runtime = new RetryableSameModelTextRuntime(
        new OpenRouterChatCompletionsRuntime(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const pending = runtime.converse(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        text: "ok",
        modelId: "openai/gpt-5.6-terra",
        tokenUsage: {
          providerAttemptCount: 2,
          unknownUsageAttempts: 1,
          failedAttempts: [expect.objectContaining({
            modelId: "openai/gpt-5.6-terra",
            requestId: "req_rate_limited",
            httpStatus: 429,
          })],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not exceed a one-attempt caller budget", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({ error: { message: "rate limited" } }, 429),
    );
    const runtimeConfig = config({
      baseUrl: "https://same-model-no-retry.example/api/v1",
    });
    const runtime = new RetryableSameModelTextRuntime(
      new OpenRouterChatCompletionsRuntime(
        runtimeConfig,
        undefined,
        fetchMock,
      ),
      runtimeConfig,
    );

    await expect(runtime.converse({
      ...input,
      maxProviderAttempts: 1,
    })).rejects.toMatchObject({ status: 429, providerAttemptCount: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries a zero-cost completion-choice provider error on the same model", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response({
          model: "openai/gpt-5.4-mini",
          provider: "azure",
          choices: [{
            finish_reason: "error",
            error: { message: "provider error" },
            message: { content: "" },
          }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 8,
            total_tokens: 128,
            cost: 0,
          },
        }))
        .mockResolvedValueOnce(response({
          model: "openai/gpt-5.4-mini",
          provider: "azure",
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 4,
            total_tokens: 124,
            cost: 0.001,
          },
        }));
      const runtimeConfig = config({
        baseUrl: "https://same-model-zero-cost-choice.example/api/v1",
        modelId: "openai/gpt-5.4-mini",
      });
      const runtime = new RetryableSameModelTextRuntime(
        new OpenRouterChatCompletionsRuntime(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const pending = runtime.converse(input);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        text: "ok",
        tokenUsage: {
          providerAttemptCount: 2,
          unknownUsageAttempts: 0,
          failedAttempts: [expect.objectContaining({
            code: "choice_error",
            retryable: true,
          })],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a completion-choice provider error with billable usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      choices: [{
        finish_reason: "error",
        error: { message: "provider error" },
        message: { content: "" },
      }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 8,
        total_tokens: 128,
        cost: 0.001,
      },
    }));
    const runtimeConfig = config({
      baseUrl: "https://same-model-billable-choice.example/api/v1",
    });
    const runtime = new RetryableSameModelTextRuntime(
      new OpenRouterChatCompletionsRuntime(
        runtimeConfig,
        undefined,
        fetchMock,
      ),
      runtimeConfig,
    );

    await expect(runtime.converse(input)).rejects.toMatchObject({
      code: "choice_error",
      providerAttemptCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses a third admitted slot on the same model after two transient 429s", async () => {
    vi.useFakeTimers();
    try {
      const limited = () => new Response(
        JSON.stringify({ error: { message: "rate limited", code: 429 } }),
        { status: 200, headers: { "retry-after": "0" } },
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(limited())
        .mockResolvedValueOnce(limited())
        .mockResolvedValueOnce(response({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      const runtimeConfig = config({
        baseUrl: "https://same-model-third-attempt.example/api/v1",
      });
      const runtime = new RetryableSameModelTextRuntime(
        new OpenRouterChatCompletionsRuntime(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const pending = runtime.converse({
        ...input,
        maxProviderAttempts: 3,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_500);
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result.tokenUsage).toMatchObject({
        providerAttemptCount: 3,
        unknownUsageAttempts: 2,
        failedAttempts: [
          expect.objectContaining({ httpStatus: 429 }),
          expect.objectContaining({ httpStatus: 429 }),
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors Retry-After before the bounded same-model retry", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ error: { message: "rate limited", code: 429 } }),
          {
            status: 429,
            headers: {
              "x-request-id": "req_wait",
              "retry-after": "2",
            },
          },
        ))
        .mockResolvedValueOnce(response({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      const runtimeConfig = config({
        baseUrl: "https://retry-after.example/api/v1",
      });
      const runtime = new RetryableSameModelTextRuntime(
        new OpenRouterChatCompletionsRuntime(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const pending = runtime.converse(input);
      await vi.advanceTimersByTimeAsync(0);
      // Retry-After is a lower bound. The shared adaptive interval also
      // staggers concurrent retries after a burst-level 429.
      await vi.advanceTimersByTimeAsync(2_499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RetryableFallbackTextRuntime", () => {
  const input: Parameters<ConverseTextRuntime["converse"]>[0] = {
    systemPrompt: "test",
    userPrompt: "test",
    maxTokens: 16,
    temperature: 0,
  };
  const success = {
    text: "ok",
    structuredData: null,
    tokenUsage: null,
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-5",
  };

  it("changes model family only for retryable infrastructure failures", async () => {
    const primary = {
      converse: vi
        .fn()
        .mockRejectedValue(
          new OpenRouterRequestError("unavailable", 503, true),
        ),
    };
    const fallback = { converse: vi.fn().mockResolvedValue(success) };
    const result = await new RetryableFallbackTextRuntime(
      primary,
      fallback,
      "openai/gpt-5.6-terra",
      "anthropic/claude-sonnet-5",
    ).converse(input);
    expect(result).toMatchObject({
      ...success,
      tokenUsage: {
        failedAttempts: [
          expect.objectContaining({
            modelId: "openai/gpt-5.6-terra",
            httpStatus: 503,
          }),
        ],
        unknownUsageAttempts: 2,
      },
    });
    expect(fallback.converse).toHaveBeenCalledOnce();
  });

  it("preserves both model failures and their request metadata", async () => {
    const primary = {
      converse: vi.fn().mockRejectedValue(
        new OpenRouterRequestError("primary unavailable", 503, true, "req_primary"),
      ),
    };
    const fallback = {
      converse: vi.fn().mockRejectedValue(
        new OpenRouterRequestError("fallback unavailable", 429, true, "req_fallback"),
      ),
    };

    await expect(
      new RetryableFallbackTextRuntime(
        primary,
        fallback,
        "openai/gpt-5.6-terra",
        "anthropic/claude-sonnet-5",
      ).converse(input),
    ).rejects.toMatchObject({
      requestId: "req_fallback",
      unknownUsageAttempts: 2,
      failedAttempts: [
        expect.objectContaining({
          modelId: "openai/gpt-5.6-terra",
          requestId: "req_primary",
        }),
        expect.objectContaining({
          modelId: "anthropic/claude-sonnet-5",
          requestId: "req_fallback",
        }),
      ],
    });
  });

  it("does not add a cross-model fallback after the same model uses the attempt budget", async () => {
    const primary = {
      converse: vi.fn().mockRejectedValue(
        new OpenRouterRequestError("still rate limited", 429, true, "req_second", {
          providerAttemptCount: 2,
          unknownUsageAttempts: 2,
          failedAttempts: [{
            provider: "openrouter",
            modelId: "openai/gpt-5.6-terra",
            requestId: "req_first",
            status: "provider_error",
            httpStatus: 429,
            retryable: true,
          }],
        }),
      ),
    };
    const fallback = { converse: vi.fn().mockResolvedValue(success) };

    await expect(
      new RetryableFallbackTextRuntime(primary, fallback).converse({
        ...input,
        maxProviderAttempts: 2,
      }),
    ).rejects.toMatchObject({ providerAttemptCount: 2, status: 429 });
    expect(fallback.converse).not.toHaveBeenCalled();
  });

  it("does not fall back for capability/auth errors or caller cancellation", async () => {
    const nonRetryablePrimary = {
      converse: vi
        .fn()
        .mockRejectedValue(
          new OpenRouterRequestError("unsupported parameter", 400, false),
        ),
    };
    const fallback = { converse: vi.fn().mockResolvedValue(success) };
    await expect(
      new RetryableFallbackTextRuntime(
        nonRetryablePrimary,
        fallback,
      ).converse(input),
    ).rejects.toThrow("unsupported parameter");
    expect(fallback.converse).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    const retryablePrimary = {
      converse: vi
        .fn()
        .mockRejectedValue(new OpenRouterRequestError("aborted", null, true)),
    };
    await expect(
      new RetryableFallbackTextRuntime(retryablePrimary, fallback).converse({
        ...input,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(fallback.converse).not.toHaveBeenCalled();
  });

  it("does not exceed the remaining provider-attempt budget", async () => {
    const primary = {
      converse: vi.fn().mockRejectedValue(
        new OpenRouterRequestError("unavailable", 503, true),
      ),
    };
    const fallback = { converse: vi.fn().mockResolvedValue(success) };

    await expect(
      new RetryableFallbackTextRuntime(primary, fallback).converse({
        ...input,
        maxProviderAttempts: 1,
      }),
    ).rejects.toThrow("unavailable");
    expect(fallback.converse).not.toHaveBeenCalled();
  });
});

describe("RetryableSameModelConverseTransport", () => {
  const input = {
    modelId: "ignored-by-transport",
    messages: [
      { role: "user" as const, content: [{ text: "Inspect it." }] },
    ],
  };

  it("honors Retry-After, retries the main model, and preserves attempt usage", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(
          JSON.stringify({ error: { message: "rate limited", code: 429 } }),
          {
            status: 429,
            headers: {
              "x-request-id": "req_agent_limited",
              "retry-after": "4",
            },
          },
        ))
        .mockResolvedValueOnce(response({
          model: "openai/gpt-5.6-terra",
          provider: "openai",
          choices: [{ finish_reason: "stop", message: { content: "Done." } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 2,
            total_tokens: 14,
            cost: 0.0003,
          },
        }));
      const runtimeConfig = config({
        baseUrl: "https://same-model-agent-retry.example/api/v1",
      });
      const transport = new RetryableSameModelConverseTransport(
        new OpenRouterConverseTransport(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const pending = transport.converse(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_999);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map((call) =>
        JSON.parse(String(call[1].body)).model
      )).toEqual([
        "openai/gpt-5.6-terra",
        "openai/gpt-5.6-terra",
      ]);
      expect(result).toMatchObject({
        modelId: "openai/gpt-5.6-terra",
        usage: {
          providerAttemptCount: 2,
          unknownUsageAttempts: 1,
          failedAttempts: [expect.objectContaining({
            modelId: "openai/gpt-5.6-terra",
            requestId: "req_agent_limited",
            httpStatus: 429,
          })],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a rate-limited tool turn in place with bounded headerless exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      const rateLimited = (requestId: string) => new Response(
        JSON.stringify({
          error: {
            message: "rate limited",
            code: 429,
            metadata: { error_type: "rate_limit_exceeded" },
          },
        }),
        {
          status: 429,
          headers: { "x-request-id": requestId },
        },
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(rateLimited("req_agent_limited_1"))
        .mockResolvedValueOnce(rateLimited("req_agent_limited_2"))
        .mockResolvedValueOnce(rateLimited("req_agent_limited_3"))
        .mockResolvedValueOnce(rateLimited("req_agent_limited_4"))
        .mockResolvedValueOnce(response({
          model: "openai/gpt-5.6-terra",
          provider: "openai",
          choices: [{ finish_reason: "stop", message: { content: "Done." } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 2,
            total_tokens: 14,
            cost: 0.0003,
          },
        }));
      const runtimeConfig = config({
        baseUrl: "https://headerless-agent-retry.example/api/v1",
      });
      const transport = new RetryableSameModelConverseTransport(
        new OpenRouterConverseTransport(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const pending = transport.converse(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      for (const [delay, expectedCalls] of [
        [5_000, 2],
        [10_000, 3],
        [20_000, 4],
        [40_000, 5],
      ] as const) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(fetchMock).toHaveBeenCalledTimes(expectedCalls - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
      }

      const result = await pending;
      const requestBodies = fetchMock.mock.calls.map((call) =>
        JSON.parse(String(call[1].body)) as Record<string, unknown>
      );
      expect(requestBodies.map((body) => body.model)).toEqual(
        Array.from({ length: 5 }, () => "openai/gpt-5.6-terra"),
      );
      expect(requestBodies.map((body) => body.messages)).toEqual(
        Array.from({ length: 5 }, () => requestBodies[0]!.messages),
      );
      expect(result).toMatchObject({
        modelId: "openai/gpt-5.6-terra",
        usage: {
          providerAttemptCount: 5,
          unknownUsageAttempts: 4,
          failedAttempts: [
            expect.objectContaining({
              requestId: "req_agent_limited_1",
              attemptDisposition: "empty_unbilled",
            }),
            expect.objectContaining({
              requestId: "req_agent_limited_2",
              attemptDisposition: "empty_unbilled",
            }),
            expect.objectContaining({
              requestId: "req_agent_limited_3",
              attemptDisposition: "empty_unbilled",
            }),
            expect.objectContaining({
              requestId: "req_agent_limited_4",
              attemptDisposition: "empty_unbilled",
            }),
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed after five headerless rate-limit attempts with exact accounting", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(
          JSON.stringify({ error: { message: "rate limited", code: 429 } }),
          { status: 429 },
        ))
      );
      const runtimeConfig = config({
        baseUrl: "https://bounded-headerless-agent-retry.example/api/v1",
      });
      const transport = new RetryableSameModelConverseTransport(
        new OpenRouterConverseTransport(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const assertion = expect(transport.converse(input)).rejects.toMatchObject({
        status: 429,
        providerAttemptCount: 5,
        unknownUsageAttempts: 5,
        failedAttempts: Array.from({ length: 5 }, () =>
          expect.objectContaining({
            httpStatus: 429,
            attemptDisposition: "empty_unbilled",
          })
        ),
        tokenUsage: {
          providerAttemptCount: 5,
          unknownUsageAttempts: 5,
        },
      });
      await vi.advanceTimersByTimeAsync(75_000);
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries learned headerless pacing across tool turns until the idle TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const limited = () => new Response(
        JSON.stringify({ error: { message: "rate limited", code: 429 } }),
        { status: 429 },
      );
      const success = () => response({
        model: "openai/gpt-5.6-terra",
        provider: "openai",
        choices: [{ finish_reason: "stop", message: { content: "Done." } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 2,
          total_tokens: 14,
          cost: 0.0003,
        },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(limited())
        .mockResolvedValueOnce(limited())
        .mockResolvedValueOnce(success())
        .mockResolvedValueOnce(success())
        .mockResolvedValueOnce(success());
      const runtimeConfig = config({
        baseUrl: "https://learned-agent-pacing.example/api/v1",
      });
      const transport = new RetryableSameModelConverseTransport(
        new OpenRouterConverseTransport(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const recoveringTurn = transport.converse(input);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await recoveringTurn;
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const nextTurn = transport.converse(input);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      await nextTurn;
      expect(fetchMock).toHaveBeenCalledTimes(4);

      await vi.advanceTimersByTimeAsync(60_001);
      const afterIdle = transport.converse(input);
      await vi.advanceTimersByTimeAsync(0);
      await afterIdle;
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after one retry and aggregates both failures on the error", async () => {
    vi.useFakeTimers();
    try {
      const unavailable = (requestId: string) => new Response(
        JSON.stringify({ error: { message: "unavailable", code: 503 } }),
        {
          status: 503,
          headers: { "x-request-id": requestId, "retry-after": "0" },
        },
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unavailable("req_agent_first"))
        .mockResolvedValueOnce(unavailable("req_agent_second"));
      const runtimeConfig = config({
        baseUrl: "https://bounded-agent-retry.example/api/v1",
      });
      const transport = new RetryableSameModelConverseTransport(
        new OpenRouterConverseTransport(
          runtimeConfig,
          undefined,
          fetchMock,
        ),
        runtimeConfig,
      );

      const assertion = expect(transport.converse(input)).rejects.toMatchObject({
        status: 503,
        providerAttemptCount: 2,
        unknownUsageAttempts: 2,
        failedAttempts: [
          expect.objectContaining({ requestId: "req_agent_first" }),
          expect.objectContaining({ requestId: "req_agent_second" }),
        ],
        tokenUsage: {
          providerAttemptCount: 2,
          unknownUsageAttempts: 2,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_500);
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenRouterConverseTransport", () => {
  it.each(["openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "anthropic/claude-sonnet-5"])(
    "preserves forced-submission reasoning only for supported models through the retry wrapper: %s",
    async (modelId) => {
      const fetchMock = vi.fn().mockResolvedValue(response({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "submit-1", function: { name: "submit_result", arguments: "{}" } }],
          },
        }],
      }));
      const transport = new RetryableSameModelConverseTransport(
        new OpenRouterConverseTransport(config(), modelId, fetchMock),
        config(), modelId,
      );
      const agent = new BedrockConverseAgent(transport, { modelId });
      await agent.run({
        messages: [{ role: "user", content: [{ text: "Submit it." }] }],
        tools: [defineBedrockConverseTool({
          name: "submit_result",
          description: "Submit the result.",
          inputSchema: z.object({}),
          jsonSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: () => ({ status: "accepted" }),
          isTerminalResult: () => true,
        })],
        effort: "high",
        forceTool: () => "submit_result",
      });
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
      expect(body.tool_choice).toEqual({ type: "function", function: { name: "submit_result" } });
      expect(body.reasoning).toEqual(modelId.startsWith("openai/") ? { effort: "high" } : undefined);
    },
  );

  it("adapts Anthropic agent tools while retaining full OpenAI tool constraints", async () => {
    for (const { modelId, expectedSchema } of [
      {
        modelId: "anthropic/claude-sonnet-5",
        expectedSchema: constraintCompatibleJsonSchema,
      },
      {
        modelId: "openai/gpt-5.6-terra",
        expectedSchema: constraintRichJsonSchema,
      },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(
        response({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Done." },
            },
          ],
        }),
      );
      const transport = new OpenRouterConverseTransport(
        config(),
        modelId,
        fetchMock,
      );
      await transport.converse({
        modelId: "ignored-by-transport",
        messages: [
          { role: "user", content: [{ text: "Inspect it." }] },
        ],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: "inspect_result",
                description: "Inspect a structured result.",
                inputSchema: { json: constraintRichJsonSchema as never },
                strict: true,
              },
            },
          ],
        },
      });

      const body = JSON.parse(
        String(fetchMock.mock.calls[0]![1].body),
      ) as StructuredRequestBody;
      expect(body.tools?.[0]?.function.parameters).toEqual(expectedSchema);
    }
  });

  it("maps a Bedrock specific-tool choice to OpenRouter named function choice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{
            id: "submit-1",
            function: { name: "submit_result", arguments: "{}" },
          }],
        },
      }],
    }));
    const transport = new OpenRouterConverseTransport(
      config(),
      undefined,
      fetchMock,
    );

    await transport.converse({
      modelId: "ignored-by-transport",
      messages: [{ role: "user", content: [{ text: "Submit it." }] }],
      toolConfig: {
        tools: [{
          toolSpec: {
            name: "submit_result",
            description: "Submit the result.",
            inputSchema: { json: { type: "object" } },
            strict: true,
          },
        }],
        toolChoice: { tool: { name: "submit_result" } },
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_result" },
    });
  });

  it("replays opaque reasoning details unchanged across tool-loop turns", async () => {
    const reasoningDetails = [
      {
        type: "reasoning.encrypted",
        id: "reasoning_1",
        data: "opaque-provider-payload",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "Checking.",
                reasoning_details: reasoningDetails,
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "read_file",
                      arguments: "{\"path\":\"src/index.ts\"}",
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            cost: 0.001,
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Done." },
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 3,
            total_tokens: 23,
            cost: 0.0015,
          },
        }),
      );
    const transport = new OpenRouterConverseTransport(
      config(),
      undefined,
      fetchMock,
    );
    const first = await transport.converse({
      modelId: "ignored",
      messages: [
        { role: "user", content: [{ text: "Inspect it." }] },
      ],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "read_file",
              description: "Read a file.",
              inputSchema: { json: { type: "object" } },
              strict: true,
            },
          },
        ],
      },
    });

    await transport.converse({
      modelId: "ignored",
      messages: [
        { role: "user", content: [{ text: "Inspect it." }] },
        first.message!,
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "call_1",
                content: [{ text: "file contents" }],
              },
            },
          ],
        },
      ],
    });

    const secondBody = JSON.parse(
      String(fetchMock.mock.calls[1]![1].body),
    );
    expect(secondBody.messages[1].reasoning_details).toEqual(
      reasoningDetails,
    );
  });

  it("maps the provider-neutral tool loop and preserves extended usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: "gen_tool_loop",
        model: "openai/gpt-5.6-terra",
        provider: "openai",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "I will inspect it.",
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "read_file",
                    arguments: "{\"path\":\"src/index.ts\"}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 10,
          total_tokens: 60,
          cost: 0.002,
          completion_tokens_details: { reasoning_tokens: 6 },
        },
      }),
    );
    const transport = new OpenRouterConverseTransport(
      config(),
      undefined,
      fetchMock,
    );
    const result = await transport.converse({
      modelId: "ignored-by-transport",
      system: [
        { text: "Use tools safely." },
        { cachePoint: { type: "default" } },
      ],
      messages: [
        {
          role: "user",
          content: [{ text: "Inspect the entrypoint." }],
        },
      ],
      inferenceConfig: { maxTokens: 256, temperature: 1 },
      additionalModelRequestFields: {
        output_config: { effort: "high" },
      },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "read_file",
              description: "Read a safe repository file.",
              inputSchema: {
                json: {
                  type: "object",
                  required: ["path"],
                  properties: { path: { type: "string" } },
                },
              },
              strict: true,
            },
          },
        ],
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "read_file", strict: true },
    });
    expect(body.messages[0].content).toBe("Use tools safely.");
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(result).toMatchObject({
      stopReason: "tool_use",
      requestId: "req_header_1",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      costUsd: 0.002,
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        reasoningTokens: 6,
        provider: "openrouter",
        cost: 0.002,
      },
      message: {
        role: "assistant",
        content: [
          { text: "I will inspect it." },
          {
            toolUse: {
              toolUseId: "call_1",
              name: "read_file",
              input: { path: "src/index.ts" },
            },
          },
        ],
      },
    });
  });
});
