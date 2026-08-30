import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toBedrockCompatibleJsonSchema } from "@/src/lib/llm-json-schemas";
import {
  AwsBedrockConverseRuntime,
  BedrockStructuredLlmClient,
  createStructuredGenerationBudget,
  estimateStructuredGenerationInputTokens,
  type ConverseTextRuntime,
} from "@/src/lib/bedrock-structured-llm-client";
import { OpenRouterRequestError } from "@/src/lib/openrouter-client";

function makeClient(responses: Array<{
  text?: string;
  structuredData?: unknown;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  stopReason?: string | null;
  requestId?: string | null;
} | Error>) {
  const calls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
  let callIndex = 0;
  const runtime: ConverseTextRuntime = {
    async converse(input) {
      calls.push(input);
      const response = responses[callIndex++];

      if (response instanceof Error) {
        throw response;
      }

      return {
        text: response.text ?? "",
        structuredData: response.structuredData ?? null,
        tokenUsage: "tokenUsage" in response
          ? response.tokenUsage ?? null
          : {
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
            },
        stopReason: response.stopReason ?? null,
        requestId: response.requestId ?? null,
      };
    },
  };

  return {
    calls,
    client: new BedrockStructuredLlmClient(runtime, {
      provider: "bedrock",
      region: "us-east-1",
      modelId: "us.anthropic.claude-sonnet-4-6",
    }),
  };
}

const schema = z.object({
  ok: z.boolean(),
});

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: {
      type: "boolean",
    },
  },
};

const arrayBoundedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "string",
      },
    },
  },
};

const numericBoundedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "index"],
  properties: {
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    index: {
      type: "integer",
      minimum: 0,
    },
  },
};

const stringAndArrayBoundedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "items"],
  properties: {
    label: {
      type: "string",
      minLength: 2,
      maxLength: 100,
    },
    items: {
      type: "array",
      minItems: 2,
      items: {
        type: "string",
        minLength: 1,
      },
    },
  },
};

describe("BedrockStructuredLlmClient", () => {
  it("propagates caller cancellation without trying alternate transports", async () => {
    const calls: unknown[] = [];
    const runtime: ConverseTextRuntime = {
      async converse(input) {
        calls.push(input);
        throw new DOMException("Cancelled", "AbortError");
      },
    };
    const client = new BedrockStructuredLlmClient(runtime, {
      provider: "openrouter",
      region: null,
      modelId: "openai/gpt-5.6-terra",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a content-policy block as a schema-format failure", async () => {
    const { client, calls } = makeClient([
      { text: "", stopReason: "content_filtered" },
      { structuredData: { ok: true } },
    ]);

    await expect(client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
    })).rejects.toMatchObject({
      providerCode: "response_blocked",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("parses valid native structured data on the first attempt", async () => {
    const { client, calls } = makeClient([{ structuredData: { ok: true } }]);
    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      exampleOutput: { ok: true },
      requiredFieldPaths: ["ok"],
      maxTokens: 128,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.transportMode).toBe("bedrock_json_schema");
    expect(calls[0]?.structuredOutput?.mode).toBe("bedrock_json_schema");
    expect(calls[0]?.enablePromptCaching).toBe(true);
  });

  it("propagates an explicit prompt-caching opt-out through native, text, and repair calls", async () => {
    const { client, calls } = makeClient([
      { text: "not valid native json" },
      { text: "not valid text json" },
      { text: '{"ok":true}' },
    ]);

    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      enablePromptCaching: false,
      transportPreference: ["bedrock_json_schema", "text_repair_fallback"],
    });

    expect(result.data).toEqual({ ok: true });
    expect(calls.map((call) => call.structuredOutput?.mode ?? "text")).toEqual([
      "bedrock_json_schema",
      "text",
      "text",
    ]);
    expect(calls.map((call) => call.enablePromptCaching)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("retains the provider request ID in durable structured usage evidence", async () => {
    const { client } = makeClient([{
      structuredData: { ok: true },
      requestId: "bedrock-request-1",
    }]);

    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
    });

    expect(result.tokenUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      requestId: "bedrock-request-1",
    });
  });

  it("falls back to strict tool use when native json schema output is invalid", async () => {
    const { client, calls } = makeClient([
      { text: "not valid json" },
      { structuredData: { ok: true } },
    ]);
    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      exampleOutput: { ok: true },
      requiredFieldPaths: ["ok"],
      maxTokens: 128,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.transportMode).toBe("strict_tool_use");
    expect(calls.map((call) => call.structuredOutput?.mode)).toEqual([
      "bedrock_json_schema",
      "strict_tool_use",
    ]);
    expect(result.tokenUsage).toEqual({
      attempts: [
        { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ],
      unknownUsageAttempts: 0,
    });
  });

  it("retains every request ID across structured transport fallback", async () => {
    const { client } = makeClient([
      {
        text: "not valid json",
        requestId: "bedrock-request-1",
      },
      {
        structuredData: { ok: true },
        requestId: "bedrock-request-2",
      },
    ]);

    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
    });

    expect(result.tokenUsage).toEqual({
      attempts: [
        {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          requestId: "bedrock-request-1",
        },
        {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          requestId: "bedrock-request-2",
        },
      ],
      unknownUsageAttempts: 0,
    });
  });

  it("retains known usage and marks an unobserved provider attempt before fallback success", async () => {
    const capabilityError = new Error(
      "JSON schema response format is not supported by this model.",
    );
    capabilityError.name = "ValidationException";
    const { client } = makeClient([
      capabilityError,
      { structuredData: { ok: true } },
    ]);
    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["bedrock_json_schema", "strict_tool_use"],
    });

    expect(result.tokenUsage).toEqual({
      attempts: [{ inputTokens: 10, outputTokens: 20, totalTokens: 30 }],
      unknownUsageAttempts: 1,
    });
  });

  it("uses a sanitized OpenRouter capability category for structured fallback", async () => {
    const capabilityError = new OpenRouterRequestError(
      "OpenRouter rejected this request's parameters or state.",
      400,
      false,
      null,
      { capability: "structured_output" },
    );
    const { client, calls } = makeClient([
      capabilityError,
      { structuredData: { ok: true } },
    ]);

    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["bedrock_json_schema", "strict_tool_use"],
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.transportMode).toBe("strict_tool_use");
    expect(calls.map((call) => call.structuredOutput?.mode)).toEqual([
      "bedrock_json_schema",
      "strict_tool_use",
    ]);
  });

  it("uses schema-aware repair only after native structured modes fail", async () => {
    const { client, calls } = makeClient([
      { text: "not valid json" },
      { text: "still not valid" },
      { text: "{\"ok\":\"wrong\"}" },
      { text: "{\"ok\":true}" },
    ]);
    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      exampleOutput: { ok: true },
      requiredFieldPaths: ["ok"],
      repairMappings: ["Map title to ok only if the original output already contains a boolean."],
      maxTokens: 128,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.transportMode).toBe("text_repair_fallback");
    expect(calls).toHaveLength(4);
    expect(calls[3]?.userPrompt).toContain("<target_json_schema>");
    expect(calls[3]?.userPrompt).toContain("<field_mappings>");
    expect(calls[3]?.userPrompt).toContain("<example_output>");
  });

  it("preserves the configured repair runtime when no same-profile policy is requested", async () => {
    const primaryCalls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
    const repairCalls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
    const primaryRuntime: ConverseTextRuntime = {
      async converse(input) {
        primaryCalls.push(input);
        return {
          text: "not valid json",
          structuredData: null,
          tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      },
    };
    const repairRuntime: ConverseTextRuntime = {
      async converse(input) {
        repairCalls.push(input);
        return {
          text: '{"ok":true}',
          structuredData: null,
          tokenUsage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
        };
      },
    };
    const client = new BedrockStructuredLlmClient(
      primaryRuntime,
      {
        provider: "openrouter",
        region: null,
        modelId: "openai/gpt-5.6-luna",
      },
      repairRuntime,
    );

    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["json_schema", "text_repair_fallback"],
      repairStrategy: "repair_last_failure",
    });

    expect(result.data).toEqual({ ok: true });
    expect(primaryCalls).toHaveLength(1);
    expect(repairCalls).toHaveLength(1);
    expect(primaryCalls[0]?.structuredOutput?.mode).toBe("json_schema");
    expect(repairCalls[0]?.structuredOutput).toBeUndefined();
  });

  it("fails safely after schema-aware repair also fails", async () => {
    const { client } = makeClient([
      { text: "not valid json" },
      { text: "still not valid" },
      { text: "{\"ok\":\"wrong\"}" },
      { text: "{\"ok\":\"still wrong\"}" },
    ]);

    await expect(
      client.generateStructured({
        systemPrompt: "Return JSON.",
        userPrompt: "Return {\"ok\":true}.",
        schema,
        schemaName: "workbase_test_schema",
        schemaDescription: "Test schema.",
        jsonSchema,
        exampleOutput: { ok: true },
        requiredFieldPaths: ["ok"],
        maxTokens: 128,
      }),
    ).rejects.toMatchObject({
      status: "validation_error",
      transportMode: "text_repair_fallback",
    });
  });

  it("terminates provider infrastructure failures without transport retry amplification", async () => {
    const { client, calls } = makeClient([
      new Error("json schema unavailable"),
      new Error("tool use unavailable"),
      new Error("text mode unavailable"),
    ]);

    await expect(
      client.generateStructured({
        systemPrompt: "Return JSON.",
        userPrompt: "Return {\"ok\":true}.",
        schema,
        schemaName: "workbase_test_schema",
        schemaDescription: "Test schema.",
        jsonSchema,
        exampleOutput: { ok: true },
        requiredFieldPaths: ["ok"],
        maxTokens: 128,
      }),
    ).rejects.toThrow("json schema unavailable");
    expect(calls).toHaveLength(1);
  });

  it("propagates an explicit provider-attempt limit without a shared budget", async () => {
    const { client, calls } = makeClient([{ structuredData: { ok: true } }]);

    await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["json_schema"],
      maxProviderAttempts: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxProviderAttempts).toBe(1);
  });

  it("enforces the shared model-call budget across structured transports", async () => {
    const { client, calls } = makeClient([
      { text: "not valid json" },
      { structuredData: { ok: true } },
    ]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 1,
      maxOutputTokens: 128,
      maxTotalTokens: 10_000,
    });

    await expect(client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 512,
      budget,
    })).rejects.toMatchObject({
      operationUsage: {
        providerAttemptCount: 1,
        unknownUsageAttempts: 0,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxProviderAttempts).toBe(1);
    expect(budget.usage).toMatchObject({ modelCalls: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it("waits for temporary token reservations and admits the next call after settlement", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const calls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
    const runtime: ConverseTextRuntime = {
      async converse(input) {
        calls.push(input);
        await providerGate;
        return {
          text: "",
          structuredData: { ok: true },
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        };
      },
    };
    const client = new BedrockStructuredLlmClient(runtime, {
      provider: "bedrock",
      region: "us-east-1",
      modelId: "test-model",
    });
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 512,
      maxTotalTokens: 3_000,
    });
    const request = () => client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 512,
      minimumOutputTokens: 512,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    const first = request();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    let secondSettled = false;
    const second = request().finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(secondSettled).toBe(false);
    releaseProvider();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ data: { ok: true } }),
      expect.objectContaining({ data: { ok: true } }),
    ]);
    expect(calls).toHaveLength(2);
    expect(budget.usage.totalTokens).toBe(60);
    expect(budget.usage.totalTokens).toBeLessThanOrEqual(
      budget.limits.maxTotalTokens,
    );
  });

  it("does not reserve an unused fallback attempt for concurrent Bedrock calls", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const calls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
    const runtime: ConverseTextRuntime = {
      async converse(input) {
        calls.push(input);
        await providerGate;
        return {
          text: "",
          structuredData: { ok: true },
          tokenUsage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
        };
      },
    };
    const client = new BedrockStructuredLlmClient(runtime, {
      provider: "bedrock",
      region: "us-east-1",
      modelId: "test-model",
    });
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 4,
      maxRepairPasses: 0,
      maxOutputTokens: 512,
      maxTotalTokens: 8_000,
    });
    const request = () => client.generateStructured({
      systemPrompt: "Synthesize evidence-backed repository knowledge.",
      userPrompt: "repository evidence ".repeat(100),
      schema,
      schemaName: "repository_architecture_synthesis",
      schemaDescription: "A supported repository synthesis.",
      jsonSchema,
      maxTokens: 512,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    const attempts = [request(), request()];
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => call.maxProviderAttempts)).toEqual([1, 1]);
    releaseProvider();
    await expect(Promise.all(attempts)).resolves.toHaveLength(2);
    expect(budget.usage).toMatchObject({ modelCalls: 2, totalTokens: 200 });
  });

  it("waits instead of shrinking a third Bedrock call against temporary reservations", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const calls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
    const runtime: ConverseTextRuntime = {
      async converse(input) {
        const index = calls.push(input) - 1;
        if (index === 0) await firstGate;
        if (index === 1) await secondGate;
        return {
          text: "",
          structuredData: { ok: true },
          tokenUsage: {
            inputTokens: 400,
            outputTokens: 100,
            cacheReadInputTokens: 400,
            totalTokens: 900,
          },
        };
      },
    };
    const client = new BedrockStructuredLlmClient(runtime, {
      provider: "bedrock",
      region: "us-east-1",
      modelId: "test-model",
    });
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 3,
      maxRepairPasses: 0,
      maxOutputTokens: 512,
      maxTotalTokens: 6_000,
    });
    const request = () => client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      schema,
      schemaName: "repository_architecture_synthesis",
      schemaDescription: "A supported repository synthesis.",
      jsonSchema,
      maxTokens: 512,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    const attempts = [request(), request(), request()];
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => call.maxTokens)).toEqual([512, 512]);
    releaseFirst();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.maxTokens).toBe(512);
    releaseSecond();

    await expect(Promise.all(attempts)).resolves.toHaveLength(3);
    expect(budget.usage.totalTokens).toBe(2_700);
  });

  it("reserves cache accounting only for cache-enabled Bedrock calls", async () => {
    const run = async (
      provider: "bedrock" | "openrouter",
      enablePromptCaching?: boolean,
    ) => {
      const runtime: ConverseTextRuntime = {
        async converse() {
          return {
            text: "",
            structuredData: { ok: true },
            tokenUsage: null,
          };
        },
      };
      const client = new BedrockStructuredLlmClient(runtime, {
        provider,
        region: provider === "bedrock" ? "us-east-1" : null,
        modelId: "test-model",
      });
      const budget = createStructuredGenerationBudget({
        maxModelCalls: 2,
        maxRepairPasses: 0,
        maxOutputTokens: 512,
        maxTotalTokens: 10_000,
      });
      await client.generateStructured({
        systemPrompt: "Return JSON.",
        userPrompt: "Return ok.",
        schema,
        schemaName: "workbase_test_schema",
        schemaDescription: "Test schema.",
        jsonSchema,
        maxTokens: 512,
        transportPreference: ["bedrock_json_schema"],
        enablePromptCaching,
        budget,
      });
      return budget.usage;
    };

    const bedrockUsage = await run("bedrock");
    const uncachedBedrockUsage = await run("bedrock", false);
    const openRouterUsage = await run("openrouter");
    expect(bedrockUsage.inputTokens).toBe(openRouterUsage.inputTokens * 2);
    expect(uncachedBedrockUsage.inputTokens).toBe(openRouterUsage.inputTokens);
    expect(bedrockUsage.outputTokens).toBe(openRouterUsage.outputTokens);
    expect(uncachedBedrockUsage.outputTokens).toBe(openRouterUsage.outputTokens);
  });

  it("uses charged cache tokens to safely bound a waiting Bedrock call", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const calls: Array<Parameters<ConverseTextRuntime["converse"]>[0]> = [];
    const runtime: ConverseTextRuntime = {
      async converse(input) {
        calls.push(input);
        await providerGate;
        return {
          text: "",
          structuredData: { ok: true },
          tokenUsage: {
            inputTokens: 400,
            outputTokens: 100,
            cacheReadInputTokens: 400,
            totalTokens: 900,
          },
        };
      },
    };
    const client = new BedrockStructuredLlmClient(runtime, {
      provider: "bedrock",
      region: "us-east-1",
      modelId: "test-model",
    });
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 512,
      maxTotalTokens: 2_800,
    });
    const request = () => client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 512,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    const first = request();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = request();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    releaseProvider();

    await expect(first).resolves.toMatchObject({ data: { ok: true } });
    await expect(second).resolves.toMatchObject({ data: { ok: true } });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.maxTokens).toBeGreaterThan(0);
    expect(calls[1]!.maxTokens).toBeLessThan(512);
    expect(budget.usage.totalTokens).toBe(1_800);
    expect(budget.usage.totalTokens).toBeLessThanOrEqual(
      budget.limits.maxTotalTokens,
    );
  });

  it("admits only one concurrent repair against one shared repair pass", async () => {
    let releaseGeneration!: () => void;
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let generationCalls = 0;
    let repairCalls = 0;
    const runtime: ConverseTextRuntime = {
      async converse(input) {
        if (input.structuredOutput) {
          generationCalls += 1;
          await generationGate;
          return {
            text: "not-json",
            structuredData: null,
            tokenUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          };
        }
        repairCalls += 1;
        return {
          text: '{"ok":true}',
          structuredData: null,
          tokenUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        };
      },
    };
    const client = new BedrockStructuredLlmClient(runtime, {
      provider: "bedrock",
      region: "us-east-1",
      modelId: "test-model",
    });
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 5,
      maxRepairPasses: 1,
      maxOutputTokens: 128,
      maxTotalTokens: 10_000,
    });
    const request = () => client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return ok.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["bedrock_json_schema", "text_repair_fallback"],
      repairStrategy: "repair_last_failure",
      budget,
    });

    const attempts = [request(), request()];
    await vi.waitFor(() => expect(generationCalls).toBe(2));
    releaseGeneration();
    const settled = await Promise.allSettled(attempts);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "repair_budget_exhausted" }),
      }),
    ]);
    expect(repairCalls).toBe(1);
    expect(budget.usage).toMatchObject({ modelCalls: 3, repairPasses: 1 });
    expect(budget.usage.modelCalls).toBeLessThanOrEqual(
      budget.limits.maxModelCalls,
    );
  });

  it("enforces output, repair, and cumulative token ceilings before another call", async () => {
    const { client, calls } = makeClient([{ text: "not valid json" }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 4,
      maxRepairPasses: 0,
      maxOutputTokens: 64,
      maxTotalTokens: 10_000,
    });

    await expect(client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      transportPreference: ["bedrock_json_schema", "text_repair_fallback"],
      repairStrategy: "repair_last_failure",
      maxTokens: 512,
      budget,
    })).rejects.toMatchObject({ code: "repair_budget_exhausted" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(64);
    budget.usage.totalTokens = budget.limits.maxTotalTokens;
    await expect(client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 512,
      budget,
    })).rejects.toMatchObject({
      code: "token_budget_exhausted",
      operationUsage: {
        providerAttemptCount: 0,
        unknownUsageAttempts: 0,
        tokenUsage: null,
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("separates a charged operation from the shared budget when a response crosses the ceiling", async () => {
    const { client, calls } = makeClient([{
      structuredData: { ok: true },
      tokenUsage: {
        inputTokens: 9_000,
        outputTokens: 2_000,
        totalTokens: 11_000,
      },
    }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 128,
      maxTotalTokens: 10_000,
    });

    await expect(client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["bedrock_json_schema"],
      budget,
    })).rejects.toMatchObject({
      code: "token_budget_exhausted",
      usage: {
        modelCalls: 1,
        totalTokens: 11_000,
      },
      operationUsage: {
        providerAttemptCount: 1,
        unknownUsageAttempts: 0,
        tokenUsage: {
          inputTokens: 9_000,
          outputTokens: 2_000,
          totalTokens: 11_000,
        },
      },
    });

    expect(calls).toHaveLength(1);
  });

  it("charges a conservative request reserve when provider token usage is unavailable", async () => {
    const { client } = makeClient([{
      structuredData: { ok: true },
      tokenUsage: null,
    }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 2,
      maxRepairPasses: 0,
      maxOutputTokens: 2_000,
      maxTotalTokens: 10_000,
    });

    const result = await client.generateStructured({
      systemPrompt: "Return supported JSON.",
      userPrompt: "Summarize this bounded repository notebook.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 2_000,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    expect(result.data).toEqual({ ok: true });
    expect(budget.usage).toMatchObject({
      modelCalls: 1,
      unknownUsageCalls: 1,
      outputTokens: 2_000,
    });
    expect(budget.usage.inputTokens).toBeGreaterThan(0);
    expect(budget.usage.totalTokens).toBe(
      budget.usage.inputTokens + budget.usage.outputTokens,
    );
  });

  it("admits a bounded repository-sized prompt without treating every byte as a token", async () => {
    const { client, calls } = makeClient([{ structuredData: { ok: true } }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });

    await client.generateStructured({
      systemPrompt: "Extract evidence-backed repository facts.",
      userPrompt: "x".repeat(18_000),
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 4_000,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(4_000);
  });

  it("parses a native structured response larger than the former starved output ceiling", async () => {
    const longSchema = z.object({ items: z.array(z.string()) });
    const longJsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: { type: "array", items: { type: "string" } },
      },
    };
    const items = Array.from({ length: 180 }, (_, index) =>
      `Evidence-backed repository observation ${index.toString().padStart(3, "0")}.`
    );
    const rawOutput = JSON.stringify({ items });
    expect(rawOutput.length).toBeGreaterThan(5_200);
    const { client, calls } = makeClient([{ text: rawOutput }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 20_000,
    });

    const result = await client.generateStructured({
      systemPrompt: "Extract evidence-backed repository facts.",
      userPrompt: "x".repeat(15_805),
      schema: longSchema,
      schemaName: "repository_semantic_observation_batch",
      schemaDescription: "A bounded repository observation batch.",
      jsonSchema: longJsonSchema,
      maxTokens: 4_000,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    expect(result.data.items).toHaveLength(items.length);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(4_000);
  });

  it("preserves a 4K output ceiling for an uncached live-sized semantic micro-batch under a 16K budget", async () => {
    const { client, calls } = makeClient([{
      structuredData: { ok: true },
      tokenUsage: {
        inputTokens: 8_900,
        outputTokens: 3_400,
        totalTokens: 12_300,
      },
    }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 16_000,
    });
    const liveSizedSchema = {
      ...jsonSchema,
      description: "s".repeat(3_000),
    };

    await client.generateStructured({
      systemPrompt: "Extract evidence-backed repository facts.",
      userPrompt: "x".repeat(24_500),
      schema,
      schemaName: "repository_semantic_observation_batch",
      schemaDescription: "A bounded repository observation batch.",
      jsonSchema: liveSizedSchema,
      maxTokens: 4_000,
      transportPreference: ["bedrock_json_schema"],
      enablePromptCaching: false,
      budget,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(4_000);
    expect(budget.usage.totalTokens).toBe(12_300);
  });

  it("does not dispatch structured semantics below their minimum completion allowance", async () => {
    const systemPrompt = "Extract one evidence-backed semantic observation.";
    const userPrompt = "export const persist = () => true;";
    const maxTokens = 3_000;
    const structuredOutput = {
      mode: "bedrock_json_schema" as const,
      schemaName: "repository_semantic_observations",
      schemaDescription: "One bounded repository semantic observation.",
      jsonSchema,
    };
    const inputReserve = estimateStructuredGenerationInputTokens({
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature: 0,
      effort: "low",
      enablePromptCaching: false,
      structuredOutput,
    });
    const makeRequest = (
      client: BedrockStructuredLlmClient,
      budget: ReturnType<typeof createStructuredGenerationBudget>,
    ) => client.generateStructured({
      systemPrompt,
      userPrompt,
      schema,
      schemaName: structuredOutput.schemaName,
      schemaDescription: structuredOutput.schemaDescription,
      jsonSchema,
      maxTokens,
      minimumOutputTokens: maxTokens,
      effort: "low",
      enablePromptCaching: false,
      transportPreference: ["bedrock_json_schema"],
      budget,
    });

    const starved = makeClient([{ structuredData: { ok: true } }]);
    const starvedBudget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: maxTokens,
      maxTotalTokens: inputReserve + maxTokens - 1,
    });
    await expect(makeRequest(starved.client, starvedBudget)).rejects.toMatchObject({
      code: "token_budget_exhausted",
    });
    expect(starved.calls).toHaveLength(0);
    expect(starvedBudget.usage).toMatchObject({ modelCalls: 0, totalTokens: 0 });

    const exact = makeClient([{ structuredData: { ok: true } }]);
    const exactBudget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: maxTokens,
      maxTotalTokens: inputReserve + maxTokens,
    });
    await expect(makeRequest(exact.client, exactBudget)).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(exact.calls).toHaveLength(1);
    expect(exact.calls[0]?.maxTokens).toBe(maxTokens);
  });

  it("rejects a cache-enabled Bedrock request before dispatch when its full charge envelope cannot fit", async () => {
    const { client, calls } = makeClient([{
      structuredData: { ok: true },
      tokenUsage: {
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 2_500,
      },
    }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 1_000,
      maxTotalTokens: 2_000,
    });

    await expect(client.generateStructured({
      systemPrompt: "Extract evidence-backed repository facts.",
      userPrompt: "repository evidence ".repeat(100),
      schema,
      schemaName: "repository_semantic_observation_batch",
      schemaDescription: "A bounded repository observation batch.",
      jsonSchema,
      maxTokens: 1_000,
      transportPreference: ["bedrock_json_schema"],
      budget,
    })).rejects.toMatchObject({ code: "token_budget_exhausted" });

    expect(calls).toHaveLength(0);
    expect(budget.usage).toMatchObject({ modelCalls: 0, totalTokens: 0 });
  });

  it("records max_tokens when a native structured response ends before valid JSON", async () => {
    const { client } = makeClient([{
      text: "{\"ok\":",
      stopReason: "max_tokens",
    }]);

    await expect(client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["bedrock_json_schema"],
    })).rejects.toMatchObject({
      status: "parse_error",
      attempts: [{
        mode: "bedrock_json_schema",
        phase: "generation",
        status: "parse_error",
        stopReason: "max_tokens",
        errorMessage: expect.stringContaining("output-token ceiling"),
      }],
    });
  });

  it("repairs a max-token partial once without replaying the full strict-tool transport", async () => {
    const { client, calls } = makeClient([
      {
        text: "{\"ok\":",
        stopReason: "max_tokens",
        tokenUsage: { inputTokens: 100, outputTokens: 128, totalTokens: 228 },
      },
      {
        text: "{\"ok\":true}",
        tokenUsage: { inputTokens: 80, outputTokens: 8, totalTokens: 88 },
      },
    ]);

    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: [
        "bedrock_json_schema",
        "strict_tool_use",
        "text_repair_fallback",
      ],
      repairStrategy: "repair_last_failure",
    });

    expect(result.data).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.structuredOutput?.mode).toBe("bedrock_json_schema");
    expect(calls[1]?.structuredOutput).toBeUndefined();
    expect(calls[1]?.systemPrompt).toContain("repair structured model outputs");
    expect(result.attempts).toEqual([
      expect.objectContaining({
        mode: "bedrock_json_schema",
        phase: "generation",
        stopReason: "max_tokens",
      }),
      expect.objectContaining({
        mode: "text_repair_fallback",
        phase: "repair",
        status: "success",
      }),
    ]);
  });

  it("repairs malformed native semantic JSON with one bounded model call", async () => {
    const { client, calls } = makeClient([
      {
        text: '{"files":{"file-1":{"summary":"incomplete"}',
        stopReason: "end_turn",
        tokenUsage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 },
      },
      {
        text: '{"ok":true}',
        tokenUsage: { inputTokens: 80, outputTokens: 8, totalTokens: 88 },
      },
    ]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 128,
      maxTotalTokens: 20_000,
    });

    const result = await client.generateStructured({
      systemPrompt: "Extract evidence-backed repository facts.",
      userPrompt: "Return the supplied facts as JSON.",
      schema,
      schemaName: "repository_semantic_observation_batch",
      schemaDescription: "A bounded repository observation batch.",
      jsonSchema,
      maxTokens: 128,
      transportPreference: ["bedrock_json_schema", "text_repair_fallback"],
      repairStrategy: "repair_last_failure",
      budget,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.transportMode).toBe("text_repair_fallback");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.maxProviderAttempts).toBe(1);
    expect(calls[1]?.systemPrompt).toContain("repair structured model outputs");
    expect(budget.usage).toMatchObject({ modelCalls: 2, repairPasses: 1, totalTokens: 228 });
  });

  it("uses shared semantic-pool headroom for repair after a live-sized native response", async () => {
    const { client, calls } = makeClient([
      {
        text: `{"ok":${" malformed-semantic-output".repeat(150)}`,
        stopReason: "end_turn",
        tokenUsage: { inputTokens: 6_439, outputTokens: 923, totalTokens: 8_469 },
      },
      {
        text: '{"ok":true}',
        tokenUsage: { inputTokens: 1_500, outputTokens: 100, totalTokens: 1_600 },
      },
    ]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 2,
      maxRepairPasses: 1,
      maxOutputTokens: 3_000,
      maxTotalTokens: 20_000,
    });
    const liveSizedSchema = {
      ...jsonSchema,
      description: "semantic-field ".repeat(180),
    };

    const result = await client.generateStructured({
      systemPrompt: "Extract a bounded semantic file batch.",
      userPrompt: "export const implementedOperation = true;\n".repeat(400),
      schema,
      schemaName: "repository_semantic_observation_batch",
      schemaDescription: "A bounded repository observation batch.",
      jsonSchema: liveSizedSchema,
      exampleOutput: { ok: true },
      requiredFieldPaths: ["ok"],
      maxTokens: 3_000,
      transportPreference: ["bedrock_json_schema", "text_repair_fallback"],
      repairStrategy: "repair_last_failure",
      budget,
    });

    expect(result.data).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.maxTokens).toBe(3_000);
    expect(calls[1]?.maxTokens).toBeGreaterThan(0);
    expect(budget.usage).toMatchObject({
      modelCalls: 2,
      repairPasses: 1,
      totalTokens: 10_069,
    });
  });

  it("rejects an adversarial one-character token stream before it can overspend the budget", async () => {
    const { client, calls } = makeClient([{ structuredData: { ok: true } }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 9_000,
    });

    await expect(client.generateStructured({
      systemPrompt: "Extract evidence-backed repository facts.",
      userPrompt: "a ".repeat(9_000),
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 4_000,
      transportPreference: ["bedrock_json_schema"],
      budget,
    })).rejects.toMatchObject({ code: "token_budget_exhausted" });

    expect(calls).toHaveLength(0);
  });

  it("still rejects a repository-sized prompt when conservative admission headroom is unavailable", async () => {
    const { client, calls } = makeClient([{ structuredData: { ok: true } }]);
    const budget = createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 6_000,
    });

    await expect(client.generateStructured({
      systemPrompt: "Extract evidence-backed repository facts.",
      userPrompt: "x".repeat(18_000),
      schema,
      schemaName: "workbase_test_schema",
      schemaDescription: "Test schema.",
      jsonSchema,
      maxTokens: 4_000,
      transportPreference: ["bedrock_json_schema"],
      budget,
    })).rejects.toMatchObject({ code: "token_budget_exhausted" });

    expect(calls).toHaveLength(0);
  });
});

describe("toBedrockCompatibleJsonSchema", () => {
  it("removes unsupported array maxItems constraints while preserving the rest", () => {
    expect(toBedrockCompatibleJsonSchema(arrayBoundedSchema)).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "string",
          },
        },
      },
    });
  });

  it("removes unsupported numeric bounds while preserving numeric types", () => {
    expect(toBedrockCompatibleJsonSchema(numericBoundedSchema)).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["score", "index"],
      properties: {
        score: {
          type: "number",
        },
        index: {
          type: "integer",
        },
      },
    });
  });

  it("removes unsupported string bounds and array minimums above one", () => {
    expect(toBedrockCompatibleJsonSchema(stringAndArrayBoundedSchema)).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["label", "items"],
      properties: {
        label: {
          type: "string",
        },
        items: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    });
  });
});

describe("AwsBedrockConverseRuntime", () => {
  it("sends outputConfig.textFormat for native json schema mode", async () => {
    const sendSpy = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockResolvedValue({
        $metadata: {
          requestId: "bedrock-runtime-request-1",
        },
        output: {
          message: {
            content: [
              {
                text: "{\"ok\":true}",
              },
            ],
          },
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
        stopReason: "end_turn",
      } as never);

    const runtime = new AwsBedrockConverseRuntime({
      region: "us-east-1",
      modelId: "us.anthropic.claude-sonnet-4-6",
    });

    const response = await runtime.converse({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      maxTokens: 64,
      temperature: 0,
      effort: "high",
      enablePromptCaching: true,
      structuredOutput: {
        mode: "bedrock_json_schema",
        schemaName: "workbase_test_schema",
        schemaDescription: "Test schema.",
        jsonSchema,
      },
    });

    const command = sendSpy.mock.calls[0]?.[0] as { input: Record<string, unknown> };

    expect(command.input.outputConfig).toMatchObject({
      textFormat: {
        type: "json_schema",
      },
    });
    expect(command.input.inferenceConfig).toEqual({
      maxTokens: 64,
      temperature: 1,
    });
    expect(command.input.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(command.input.system).toEqual([
      { text: "Return JSON." },
      { cachePoint: { type: "default" } },
    ]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.requestId).toBe("bedrock-runtime-request-1");
    expect(
      JSON.parse(
        (
          command.input.outputConfig as {
            textFormat: {
              structure: {
                jsonSchema: {
                  schema: string;
                };
              };
            };
          }
        ).textFormat.structure.jsonSchema.schema,
      ),
    ).toEqual(toBedrockCompatibleJsonSchema(jsonSchema));

    sendSpy.mockRestore();
  });

  it("sends strict tool configuration for strict tool mode", async () => {
    const sendSpy = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockResolvedValue({
        output: {
          message: {
            content: [
              {
                toolUse: {
                  input: {
                    ok: true,
                  },
                },
              },
            ],
          },
        },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      } as never);

    const runtime = new AwsBedrockConverseRuntime({
      region: "us-east-1",
      modelId: "us.anthropic.claude-sonnet-4-6",
    });

    const response = await runtime.converse({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      maxTokens: 64,
      temperature: 0,
      effort: "high",
      structuredOutput: {
        mode: "strict_tool_use",
        schemaName: "workbase_test_schema",
        schemaDescription: "Test schema.",
        jsonSchema,
      },
    });

    const command = sendSpy.mock.calls[0]?.[0] as { input: Record<string, unknown> };

    expect(command.input.toolConfig).toMatchObject({
      toolChoice: {
        tool: {
          name: "workbase_test_schema",
        },
      },
    });
    expect(command.input.inferenceConfig).toEqual({
      maxTokens: 64,
      temperature: 0,
    });
    expect(command.input.additionalModelRequestFields).toBeUndefined();
    expect(
      (
        command.input.toolConfig as {
          tools: Array<{
            toolSpec: {
              inputSchema: {
                json: unknown;
              };
            };
          }>;
        }
      ).tools[0]?.toolSpec.inputSchema.json,
    ).toEqual(toBedrockCompatibleJsonSchema(jsonSchema));
    expect(response.structuredData).toEqual({ ok: true });

    sendSpy.mockRestore();
  });
});
