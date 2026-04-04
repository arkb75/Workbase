import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BedrockStructuredLlmClient,
  type ConverseTextRuntime,
} from "@/src/lib/bedrock-structured-llm-client";

function makeClient(responses: Array<{ text: string } | Error>) {
  let callIndex = 0;
  const runtime: ConverseTextRuntime = {
    async converse() {
      const response = responses[callIndex++];

      if (response instanceof Error) {
        throw response;
      }

      return {
        text: response.text,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
      };
    },
  };

  return new BedrockStructuredLlmClient(runtime, {
    provider: "bedrock",
    region: "us-east-1",
    modelId: "us.anthropic.claude-sonnet-4-6",
  });
}

describe("BedrockStructuredLlmClient", () => {
  const schema = z.object({
    ok: z.boolean(),
  });

  it("parses valid structured JSON on the first attempt", async () => {
    const client = makeClient([{ text: "{\"ok\":true}" }]);
    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      maxTokens: 128,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.parsedOutput).toEqual({ ok: true });
  });

  it("retries once with repair when the first output is malformed", async () => {
    const client = makeClient([
      { text: "not valid json" },
      { text: "{\"ok\":true}" },
    ]);
    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      maxTokens: 128,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.rawOutput).toContain("Initial output:");
    expect(result.rawOutput).toContain("Repair output:");
  });

  it("extracts wrapped JSON from repair-style prose", async () => {
    const client = makeClient([
      {
        text: [
          "Here is the repaired JSON.",
          "",
          "{\"ok\":true}",
        ].join("\n"),
      },
    ]);
    const result = await client.generateStructured({
      systemPrompt: "Return JSON.",
      userPrompt: "Return {\"ok\":true}.",
      schema,
      maxTokens: 128,
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.parsedOutput).toEqual({ ok: true });
  });

  it("fails safely after one repair attempt", async () => {
    const client = makeClient([
      { text: "not valid json" },
      { text: "still not valid" },
    ]);

    await expect(
      client.generateStructured({
        systemPrompt: "Return JSON.",
        userPrompt: "Return {\"ok\":true}.",
        schema,
        maxTokens: 128,
      }),
    ).rejects.toMatchObject({
      status: "parse_error",
    });
  });

  it("surfaces provider failures without returning fallback output", async () => {
    const client = makeClient([new Error("bedrock unavailable")]);

    await expect(
      client.generateStructured({
        systemPrompt: "Return JSON.",
        userPrompt: "Return {\"ok\":true}.",
        schema,
        maxTokens: 128,
      }),
    ).rejects.toMatchObject({
      status: "provider_error",
    });
  });
});
