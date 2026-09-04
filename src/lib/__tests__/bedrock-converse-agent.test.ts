import type {
  ConverseCommandInput,
  Message,
  StopReason,
  TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BedrockConverseAgent,
  BedrockConverseAgentError,
  BedrockConverseLimitError,
  BedrockConverseModelCapabilityError,
  BedrockConverseProviderError,
  bedrockConverseAgentSemanticTokenCount,
  defineBedrockConverseTool,
  estimateBedrockConverseInputTokens,
  sanitizeBedrockConverseEventValue,
  type BedrockConverseTransport,
  type BedrockConverseTransportResponse,
} from "@/src/lib/bedrock-converse-agent";
import { OpenRouterRequestError } from "@/src/lib/openrouter-client";

type FakeResponse =
  | BedrockConverseTransportResponse
  | Error
  | ((input: ConverseCommandInput) => BedrockConverseTransportResponse);

class FakeTransport implements BedrockConverseTransport {
  readonly calls: ConverseCommandInput[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: FakeResponse[]) {}

  async converse(input: ConverseCommandInput) {
    this.calls.push(structuredClone(input));
    const response = this.responses[this.responseIndex++];

    if (!response) {
      throw new Error("No fake response configured.");
    }

    if (response instanceof Error) {
      throw response;
    }

    return typeof response === "function" ? response(input) : response;
  }
}

function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function assistantResponse(params: {
  stopReason: StopReason | string;
  content: NonNullable<Message["content"]>;
  usage?: TokenUsage;
  requestId?: string;
}): BedrockConverseTransportResponse {
  return {
    message: {
      role: "assistant",
      content: params.content,
    },
    stopReason: params.stopReason,
    usage: params.usage ?? usage(3, 2),
    requestId: params.requestId ?? "request-1",
  };
}

function userMessage(text = "Help me with this project."): Message {
  return {
    role: "user",
    content: [{ text }],
  };
}

function toolRequest(params: {
  id?: string;
  name?: string;
  input?: unknown;
}): NonNullable<Message["content"]>[number] {
  return {
    toolUse: {
      toolUseId: params.id,
      name: params.name,
      input: params.input as never,
    },
  };
}

const lookupJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string" },
    apiKey: { type: "string" },
  },
};

function makeAgent(responses: FakeResponse[]) {
  const transport = new FakeTransport(responses);

  return {
    transport,
    agent: new BedrockConverseAgent(transport, {
      modelId: "us.anthropic.claude-sonnet-4-6",
    }),
  };
}

describe("BedrockConverseAgent", () => {
  it("returns a final text response and normalized token accounting", async () => {
    const { agent, transport } = makeAgent([
      assistantResponse({
        stopReason: "end_turn",
        content: [{ text: "The project uses verified highlights." }],
        usage: {
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
          cacheReadInputTokens: 2,
          cacheWriteInputTokens: 1,
        },
      }),
    ]);

    const result = await agent.run({
      systemPrompt: "Answer from project context.",
      messages: [userMessage()],
      maxTokens: 256,
      temperature: 0.2,
      effort: "medium",
      enablePromptCaching: true,
    });

    expect(result.text).toBe("The project uses verified highlights.");
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 1,
    });
    expect(transport.calls[0]).toMatchObject({
      modelId: "us.anthropic.claude-sonnet-4-6",
      system: [
        { text: "Answer from project context." },
        { cachePoint: { type: "default" } },
      ],
      inferenceConfig: { maxTokens: 256, temperature: 1 },
      additionalModelRequestFields: {
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      },
    });
    expect(transport.calls[0]?.toolConfig).toBeUndefined();
  });

  it("executes Zod-validated tools and sends tool results into the next turn", async () => {
    const execute = vi.fn(async (input: { query: string; apiKey?: string }) => ({
      answer: `Found ${input.query}`,
      password: "do-not-persist-this",
    }));
    const tool = defineBedrockConverseTool({
      name: "research_project",
      description: "Research imported project context.",
      inputSchema: z.object({
        query: z.string().min(1),
        apiKey: z.string().optional(),
      }),
      jsonSchema: lookupJsonSchema,
      execute,
    });
    const { agent, transport } = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [
          { text: "I will check." },
          toolRequest({
            id: "tool-1",
            name: "research_project",
            input: {
              query: "authentication",
              apiKey: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
            },
          }),
        ],
        usage: usage(10, 4),
      }),
      assistantResponse({
        stopReason: "end_turn",
        content: [{ text: "Authentication is handled by the auth service." }],
        usage: usage(15, 6),
        requestId: "request-2",
      }),
    ]);

    const result = await agent.run({
      messages: [userMessage("How does authentication work?")],
      tools: [tool],
    });

    expect(execute).toHaveBeenCalledWith(
      {
        query: "authentication",
        apiKey: "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      },
      expect.objectContaining({
        iteration: 1,
        toolCall: 1,
        toolUseId: "tool-1",
      }),
    );
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.toolConfig?.tools?.[0]).toMatchObject({
      toolSpec: {
        name: "research_project",
        inputSchema: { json: lookupJsonSchema },
      },
    });

    const secondCallMessages = transport.calls[1]?.messages ?? [];
    expect(secondCallMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(secondCallMessages[2]?.content?.[0]).toEqual({
      toolResult: {
        toolUseId: "tool-1",
        content: [
          {
            json: {
              answer: "Found authentication",
              password: "do-not-persist-this",
            },
          },
        ],
      },
    });
    expect(result.usage).toMatchObject({
      inputTokens: 25,
      outputTokens: 10,
      totalTokens: 35,
    });
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(1);

    const started = result.events.find((event) => event.type === "tool_call_started");
    const completed = result.events.find(
      (event) => event.type === "tool_call_completed",
    );
    expect(started).toMatchObject({
      input: {
        query: "authentication",
        apiKey: "[REDACTED]",
      },
    });
    expect(completed).toMatchObject({
      outcome: "success",
      output: {
        answer: "Found authentication",
        password: "[REDACTED]",
      },
    });
    expect(JSON.stringify(result.events)).not.toContain("do-not-persist-this");
    expect(JSON.stringify(result.events)).not.toContain("github_pat_");
  });

  it("returns invalid tool input to the model without executing the handler", async () => {
    const execute = vi.fn();
    const tool = defineBedrockConverseTool({
      name: "lookup",
      description: "Look up a count.",
      inputSchema: z.object({ count: z.number().int() }),
      jsonSchema: {
        type: "object",
        required: ["count"],
        properties: { count: { type: "integer" } },
      },
      execute,
    });
    const { agent, transport } = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [toolRequest({ id: "bad-1", name: "lookup", input: { count: "one" } })],
      }),
      assistantResponse({
        stopReason: "end_turn",
        content: [{ text: "I could not run that lookup." }],
      }),
    ]);

    const result = await agent.run({ messages: [userMessage()], tools: [tool] });

    expect(execute).not.toHaveBeenCalled();
    expect(transport.calls[1]?.messages?.[2]?.content?.[0]).toMatchObject({
      toolResult: {
        toolUseId: "bad-1",
        content: [
          {
            json: {
              error: {
                code: "invalid_tool_input",
                issues: expect.any(Array),
              },
            },
          },
        ],
      },
    });
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_call_completed",
        outcome: "invalid_input",
      }),
    );
  });

  it("returns unknown and failed tools as safe error results so the model can recover", async () => {
    const failingTool = defineBedrockConverseTool({
      name: "failing_tool",
      description: "Fails for test coverage.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute() {
        throw new Error("provider token ghp_this-must-never-appear-in-an-event");
      },
    });
    const { agent, transport } = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [
          toolRequest({ id: "unknown-1", name: "made_up", input: {} }),
          toolRequest({ id: "failed-1", name: "failing_tool", input: {} }),
        ],
      }),
      assistantResponse({
        stopReason: "end_turn",
        content: [{ text: "Recovered." }],
      }),
    ]);

    const result = await agent.run({
      messages: [userMessage()],
      tools: [failingTool],
    });

    const toolResultMessage = transport.calls[1]?.messages?.[2];
    expect(JSON.stringify(toolResultMessage)).toContain("unknown_tool");
    expect(JSON.stringify(toolResultMessage)).toContain("tool_execution_failed");
    expect(JSON.stringify(toolResultMessage)).not.toContain("this-must-never-appear");
    expect(result.events).toContainEqual(
      expect.objectContaining({ outcome: "unknown_tool" }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ outcome: "execution_error" }),
    );
  });

  it("preserves a safe typed tool error code without exposing its message", async () => {
    const typedTool = defineBedrockConverseTool({
      name: "repository_lookup",
      description: "Fails with a safe repository error code.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute() {
        throw Object.assign(new Error("token ghp_never-show-this"), {
          code: "session_expired",
        });
      },
    });
    const { agent, transport } = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [toolRequest({ id: "repo-1", name: "repository_lookup", input: {} })],
      }),
      assistantResponse({ stopReason: "end_turn", content: [{ text: "Recovered." }] }),
    ]);

    await agent.run({ messages: [userMessage()], tools: [typedTool] });

    const serialized = JSON.stringify(transport.calls[1]?.messages?.[2]);
    expect(serialized).toContain("session_expired");
    expect(serialized).not.toContain("never-show-this");
  });

  it("reserves a response's tool calls before execution and enforces the call limit", async () => {
    const execute = vi.fn();
    const tool = defineBedrockConverseTool({
      name: "lookup",
      description: "Lookup.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute,
    });
    const { agent } = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [
          toolRequest({ id: "one", name: "lookup", input: {} }),
          toolRequest({ id: "two", name: "lookup", input: {} }),
        ],
      }),
    ]);

    await expect(
      agent.run({
        messages: [userMessage()],
        tools: [tool],
        limits: { maxToolCalls: 1 },
      }),
    ).rejects.toMatchObject({
      code: "tool_call_limit_exceeded",
      limit: 1,
      actual: 2,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces iteration and aggregate token limits without discarding a completed answer", async () => {
    const tool = defineBedrockConverseTool({
      name: "lookup",
      description: "Lookup.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute: () => ({ ok: true }),
    });
    const iterationRun = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [toolRequest({ id: "one", name: "lookup", input: {} })],
      }),
    ]);

    await expect(
      iterationRun.agent.run({
        messages: [userMessage()],
        tools: [tool],
        limits: { maxIterations: 1 },
      }),
    ).rejects.toMatchObject({
      code: "iteration_limit_exceeded",
      limit: 1,
      actual: 2,
      toolCalls: 1,
      requestIds: ["request-1"],
      usage: { totalTokens: 5 },
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "model_call_completed",
          requestId: "request-1",
        }),
        expect.objectContaining({
          type: "tool_call_completed",
          toolName: "lookup",
        }),
      ]),
    });
    expect(iterationRun.transport.calls).toHaveLength(1);

    const tokenRun = makeAgent([
      assistantResponse({
        stopReason: "end_turn",
        content: [{ text: "Too expensive." }],
        usage: usage(8, 5),
      }),
    ]);

    await expect(
      tokenRun.agent.run({
        messages: [userMessage()],
        limits: { maxTotalTokens: 10 },
      }),
    ).resolves.toMatchObject({
      text: "Too expensive.",
      stopReason: "end_turn",
      usage: { totalTokens: 13 },
    });

    const unfinishedTokenRun = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [toolRequest({ id: "budget", name: "lookup", input: {} })],
        usage: usage(8, 5),
      }),
    ]);
    await expect(
      unfinishedTokenRun.agent.run({
        messages: [userMessage()],
        tools: [tool],
        limits: { maxTotalTokens: 10 },
      }),
    ).rejects.toMatchObject({
      code: "token_limit_exceeded",
      limit: 10,
      actual: 13,
      usage: { totalTokens: 13 },
    });
  });

  it("stops before sending an obviously oversized follow-up call", async () => {
    const tool = defineBedrockConverseTool({
      name: "large_lookup",
      description: "Return a deliberately large result.",
      inputSchema: z.object({}),
      jsonSchema: { type: "object", properties: {} },
      execute: () => ({ inventory: "x".repeat(30_000) }),
    });
    const { agent, transport } = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [toolRequest({ id: "large", name: "large_lookup", input: {} })],
        usage: usage(100, 20),
      }),
    ]);

    await expect(agent.run({
      messages: [userMessage()],
      tools: [tool],
      limits: { maxTotalTokens: 5_000 },
    })).rejects.toMatchObject({
      code: "token_limit_exceeded",
      limit: 5_000,
      iterations: 1,
      toolCalls: 1,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("separates newly processed semantic tokens from cached transcript replay", async () => {
    expect(bedrockConverseAgentSemanticTokenCount({
      totalTokens: 20_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 16_000,
    })).toBe(4_000);

    const { agent } = makeAgent([
      assistantResponse({
        stopReason: "end_turn",
        content: [{ text: "Finished after too much new semantic work." }],
        usage: {
          inputTokens: 18_000,
          outputTokens: 2_000,
          totalTokens: 20_000,
          cacheReadInputTokens: 5_000,
        },
      }),
    ]);

    await expect(agent.run({
      messages: [userMessage()],
      limits: {
        maxTotalTokens: 50_000,
        maxSemanticTokens: 10_000,
      },
    })).rejects.toMatchObject({
      code: "token_limit_exceeded",
      limit: 10_000,
      actual: 15_000,
    });
  });

  it("estimates model-visible JSON and tool schema size conservatively", () => {
    const small = estimateBedrockConverseInputTokens({
      systemPrompt: "Answer briefly.",
      messages: [userMessage("hello")],
    });
    const large = estimateBedrockConverseInputTokens({
      systemPrompt: "Answer briefly.",
      messages: [userMessage("x".repeat(3_000))],
    });
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(1_000);
  });

  it.each([
    ["max_tokens", "output_token_limit_reached"],
    ["content_filtered", "response_blocked"],
    ["guardrail_intervened", "response_blocked"],
    ["malformed_tool_use", "malformed_model_response"],
    ["malformed_model_output", "malformed_model_response"],
    ["model_context_window_exceeded", "token_limit_exceeded"],
  ])("maps stop reason %s to %s", async (stopReason, code) => {
    const { agent } = makeAgent([
      assistantResponse({
        stopReason,
        content: [{ text: "partial" }],
      }),
    ]);

    await expect(agent.run({ messages: [userMessage()] })).rejects.toMatchObject({
      code,
      stopReason,
    });
  });

  it("accepts stop_sequence as a completed response", async () => {
    const { agent } = makeAgent([
      assistantResponse({
        stopReason: "stop_sequence",
        content: [{ text: "Done before delimiter." }],
      }),
    ]);

    await expect(agent.run({ messages: [userMessage()] })).resolves.toMatchObject({
      text: "Done before delimiter.",
      stopReason: "stop_sequence",
    });
  });

  it("rejects malformed tool-use responses and reused tool IDs", async () => {
    const malformedRun = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [toolRequest({ id: undefined, name: "lookup", input: {} })],
      }),
    ]);

    await expect(
      malformedRun.agent.run({ messages: [userMessage()] }),
    ).rejects.toMatchObject({ code: "protocol_error" });

    const reusedRun = makeAgent([
      assistantResponse({
        stopReason: "tool_use",
        content: [toolRequest({ id: "already-used", name: "lookup", input: {} })],
      }),
    ]);
    const priorAssistantMessage: Message = {
      role: "assistant",
      content: [toolRequest({ id: "already-used", name: "lookup", input: {} })],
    };

    await expect(
      reusedRun.agent.run({
        messages: [userMessage(), priorAssistantMessage],
      }),
    ).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("classifies incomplete provider envelopes as retryable interruptions", async () => {
    const missingMessage = makeAgent([{
      stopReason: "end_turn",
      usage: usage(3, 2),
      requestId: "request-incomplete-message",
    } as unknown as BedrockConverseTransportResponse]);
    await expect(
      missingMessage.agent.run({ messages: [userMessage()] }),
    ).rejects.toMatchObject({
      code: "provider_error",
      providerCode: "incomplete_response",
      retryable: true,
    });

    const missingStopReason = makeAgent([{
      message: { role: "assistant", content: [{ text: "Partial" }] },
      usage: usage(3, 2),
      requestId: "request-incomplete-stop",
    } as unknown as BedrockConverseTransportResponse]);
    await expect(
      missingStopReason.agent.run({ messages: [userMessage()] }),
    ).rejects.toMatchObject({
      code: "provider_error",
      providerCode: "incomplete_response",
      retryable: true,
    });
  });

  it("surfaces model capability failures separately from provider failures", async () => {
    const capabilityError = new Error(
      "This model does not support tool use with the Converse API.",
    );
    capabilityError.name = "ValidationException";
    const capabilityRun = makeAgent([capabilityError]);

    await expect(
      capabilityRun.agent.run({ messages: [userMessage()] }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BedrockConverseModelCapabilityError &&
        error.code === "model_capability_error" &&
        error.message.includes("Configure a model that supports"),
    );

    const providerError = new Error("Access denied.");
    providerError.name = "AccessDeniedException";
    const providerRun = makeAgent([providerError]);

    await expect(
      providerRun.agent.run({ messages: [userMessage()] }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BedrockConverseProviderError &&
        error.code === "provider_error" &&
        error.message.includes("AccessDeniedException"),
    );

    const openRouterCapabilityError = new OpenRouterRequestError(
      "OpenRouter rejected this request's parameters or state.",
      400,
      false,
      null,
      { capability: "tool_use" },
    );
    const openRouterTransport = new FakeTransport([openRouterCapabilityError]);
    const openRouterAgent = new BedrockConverseAgent(openRouterTransport, {
      modelId: "openai/gpt-5.6-terra",
      providerLabel: "OpenRouter",
    });
    await expect(
      openRouterAgent.run({ messages: [userMessage()] }),
    ).rejects.toBeInstanceOf(BedrockConverseModelCapabilityError);
  });

  it("marks OpenRouter metering incomplete when a model call omits cost", async () => {
    const transport = new FakeTransport([
      {
        ...assistantResponse({
          stopReason: "end_turn",
          content: [{ text: "Done." }],
          usage: usage(7, 3),
        }),
        provider: "openrouter",
        modelId: "openai/gpt-5.6-terra",
        costUsd: null,
      },
    ]);
    const agent = new BedrockConverseAgent(transport, {
      modelId: "openai/gpt-5.6-terra",
      providerLabel: "OpenRouter",
    });

    await expect(
      agent.run({ messages: [userMessage()] }),
    ).resolves.toMatchObject({
      usage: { unknownUsageAttempts: 1 },
    });
  });

  it("does not double-count retry attempts already reported with unknown usage", async () => {
    const transport = new FakeTransport([
      {
        ...assistantResponse({
          stopReason: "end_turn",
          content: [{ text: "Done." }],
          usage: {
            attempts: [{
              inputTokens: 7,
              outputTokens: 3,
              totalTokens: 10,
              cost: 0.001,
              providerAttemptCount: 1,
            }],
            failedAttempts: [{
              provider: "openrouter",
              modelId: "openai/gpt-5.6-terra",
              requestId: "req_limited",
              httpStatus: 429,
            }],
            unknownUsageAttempts: 1,
            providerAttemptCount: 2,
          } as unknown as TokenUsage,
        }),
        provider: "openrouter",
        modelId: "openai/gpt-5.6-terra",
        costUsd: 0.001,
      },
    ]);
    const agent = new BedrockConverseAgent(transport, {
      modelId: "openai/gpt-5.6-terra",
      providerLabel: "OpenRouter",
    });

    await expect(
      agent.run({ messages: [userMessage()] }),
    ).resolves.toMatchObject({
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        providerAttemptCount: 2,
        unknownUsageAttempts: 1,
        failedAttempts: [expect.objectContaining({
          requestId: "req_limited",
        })],
      },
    });
  });

  it("emits failed provider attempts with bounded metering metadata", async () => {
    const failure = new OpenRouterRequestError(
      "providers unavailable",
      503,
      true,
      "req_fallback",
      {
        failedAttempts: [
          {
            provider: "openrouter",
            modelId: "openai/gpt-5.6-terra",
            requestId: "req_primary",
          },
          {
            provider: "openrouter",
            modelId: "anthropic/claude-sonnet-5",
            requestId: "req_fallback",
          },
        ],
        unknownUsageAttempts: 2,
        providerAttemptCount: 2,
      },
    );
    const transport = new FakeTransport([failure]);
    const agent = new BedrockConverseAgent(transport, {
      modelId: "openai/gpt-5.6-terra",
      providerLabel: "OpenRouter",
    });
    const events: unknown[] = [];

    await expect(agent.run({
      messages: [userMessage()],
      onEvent: (event) => {
        events.push(event);
      },
    })).rejects.toMatchObject({
      code: "provider_error",
      providerStatus: 503,
      retryable: true,
      usage: expect.objectContaining({
        providerAttemptCount: 2,
        unknownUsageAttempts: 2,
      }),
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "model_call_failed",
        requestIds: ["req_fallback", "req_primary"],
        usage: expect.objectContaining({
          providerAttemptCount: 2,
          unknownUsageAttempts: 2,
        }),
      }),
    ]));
  });

  it("validates configuration before invoking Bedrock", async () => {
    const { agent, transport } = makeAgent([]);
    const invalidTool = defineBedrockConverseTool({
      name: "invalid",
      description: "Invalid top-level schema.",
      inputSchema: z.string(),
      jsonSchema: { type: "string" },
      execute: () => null,
    });

    await expect(
      agent.run({ messages: [userMessage()], tools: [invalidTool] }),
    ).rejects.toBeInstanceOf(BedrockConverseAgentError);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("sanitizeBedrockConverseEventValue", () => {
  it("redacts credentials, bounds strings, and handles cycles", () => {
    const cyclic: Record<string, unknown> = {
      authorization: "Bearer should-not-remain",
      note: `Bearer secret-token ${"x".repeat(600)}`,
    };
    cyclic.self = cyclic;

    const sanitized = sanitizeBedrockConverseEventValue(cyclic);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[circular]");
    expect(serialized).toContain("[truncated");
    expect(serialized).not.toContain("should-not-remain");
    expect(serialized).not.toContain("secret-token");
  });

  it("preserves numeric usage telemetry while redacting token-shaped secrets", () => {
    const sanitized = sanitizeBedrockConverseEventValue({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadInputTokens: 2_000,
      cacheWriteInputTokens: 100,
      accessToken: "github_pat_should-not-remain-1234567890",
      token: "plain-secret",
      inputTokensFromHeader: 999,
    });

    expect(sanitized).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cacheReadInputTokens: 2_000,
      cacheWriteInputTokens: 100,
      accessToken: "[REDACTED]",
      token: "[REDACTED]",
      inputTokensFromHeader: "[REDACTED]",
    });
  });
});

describe("exported error types", () => {
  it("keeps bounded-run metadata on limit errors", () => {
    const error = new BedrockConverseLimitError(
      "limit",
      "tool_call_limit_exceeded",
      2,
      3,
      { iterations: 1, toolCalls: 2 },
    );

    expect(error).toMatchObject({
      name: "BedrockConverseLimitError",
      code: "tool_call_limit_exceeded",
      limit: 2,
      actual: 3,
      iterations: 1,
      toolCalls: 2,
    });
  });
});
