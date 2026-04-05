import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AwsBedrockConverseRuntime,
  BedrockStructuredLlmClient,
  type ConverseTextRuntime,
} from "@/src/lib/bedrock-structured-llm-client";

function makeClient(responses: Array<{ text?: string; structuredData?: unknown } | Error>) {
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
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
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

describe("BedrockStructuredLlmClient", () => {
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

  it("surfaces provider failures when every transport fails", async () => {
    const { client } = makeClient([
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
    ).rejects.toMatchObject({
      status: "provider_error",
      transportMode: "text_repair_fallback",
    });
  });
});

describe("AwsBedrockConverseRuntime", () => {
  it("sends outputConfig.textFormat for native json schema mode", async () => {
    const sendSpy = vi
      .spyOn(BedrockRuntimeClient.prototype, "send")
      .mockResolvedValue({
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
      } as never);

    const runtime = new AwsBedrockConverseRuntime({
      region: "us-east-1",
      modelId: "us.anthropic.claude-sonnet-4-6",
    });

    await runtime.converse({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      maxTokens: 64,
      temperature: 0,
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
    ).toEqual(jsonSchema);

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
    expect(response.structuredData).toEqual({ ok: true });

    sendSpy.mockRestore();
  });
});
