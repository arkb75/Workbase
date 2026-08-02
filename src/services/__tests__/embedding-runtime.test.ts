import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddingIndexEvaluationErrorMessage } from "@/src/evals/embedding-index-error";
import {
  OpenRouterEmbeddingRequestError,
  requestOpenRouterEmbedding,
} from "@/src/services/embedding-runtime";

const identity = {
  id: "openrouter-small-512",
  key: "openrouter-small-512",
  provider: "openrouter" as const,
  modelId: "openai/text-embedding-3-small",
  dimensions: 512,
};

const priorEnvironment = {
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: process.env.WORKBASE_OPENROUTER_BASE_URL,
  maxAttempts: process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS,
};

afterEach(() => {
  if (priorEnvironment.apiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = priorEnvironment.apiKey;
  if (priorEnvironment.baseUrl === undefined) {
    delete process.env.WORKBASE_OPENROUTER_BASE_URL;
  } else {
    process.env.WORKBASE_OPENROUTER_BASE_URL = priorEnvironment.baseUrl;
  }
  if (priorEnvironment.maxAttempts === undefined) {
    delete process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS;
  } else {
    process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS =
      priorEnvironment.maxAttempts;
  }
});

describe("OpenRouter embedding transport", () => {
  it("requires strict ZDR and requested dimensions while preserving usage and cost", async () => {
    process.env.OPENROUTER_API_KEY = "  private-test-key  ";
    process.env.WORKBASE_OPENROUTER_BASE_URL = "https://openrouter.example/api/v1/";
    const fetchImpl = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: Array.from({ length: 512 }, (_, index) => index ? 0 : 1) }],
        usage: { prompt_tokens: 7, total_tokens: 7, cost: 0.0000014 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await requestOpenRouterEmbedding({
      identity,
      inputText: "grounded project retrieval",
      fetchImpl,
    });

    expect(result.vector).toHaveLength(512);
    expect(result.usage).toEqual({
      inputTokens: 7,
      totalTokens: 7,
      costUsd: 0.0000014,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.example/api/v1/embeddings");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer private-test-key",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: identity.modelId,
      dimensions: 512,
      provider: {
        zdr: true,
        require_parameters: true,
      },
    });
  });

  it("rejects a response from the wrong vector space", async () => {
    process.env.OPENROUTER_API_KEY = "private-test-key";
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 2, 3] }],
      }), { status: 200 })
    );

    await expect(requestOpenRouterEmbedding({
      identity,
      inputText: "wrong dimensions",
      fetchImpl,
    })).rejects.toThrow("512-dimensional");
  });

  it("retries a retryable non-JSON provider response once", async () => {
    process.env.OPENROUTER_API_KEY = "private-test-key";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("<html>temporarily unavailable</html>", {
        status: 503,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 512 }, (_, index) => index ? 0 : 1) }],
      }), { status: 200 }));

    await expect(requestOpenRouterEmbedding({
      identity,
      inputText: "retry provider outage",
      fetchImpl,
    })).resolves.toMatchObject({ vector: expect.any(Array) });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retains only safe billing classification when provider diagnostics contain key metadata", async () => {
    process.env.OPENROUTER_API_KEY = "private-test-key";
    process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS = "1";
    const unsafeProviderMessage =
      "Insufficient credits. Manage key sk-or-v1-sensitive at https://openrouter.ai/settings/keys/key_sensitive?workspace=ws_private";
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        error: {
          message: unsafeProviderMessage,
          code: "workspace_private",
        },
      }), {
        status: 402,
        headers: {
          "x-request-id": "sk-or-v1-sensitive",
          "retry-after": "https://openrouter.ai/settings/credits",
        },
      })
    );

    let failure: unknown;
    try {
      await requestOpenRouterEmbedding({
        identity,
        inputText: "secret-safe billing failure",
        fetchImpl,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenRouterEmbeddingRequestError);
    expect(failure).toMatchObject({
      message:
        "OpenRouter account credits are insufficient for this embedding request.",
      status: 402,
      retryable: false,
      classification: "billing",
    });
    const evaluatorDiagnostic = embeddingIndexEvaluationErrorMessage(failure);
    const serialized = `${evaluatorDiagnostic} ${JSON.stringify(failure)}`;
    expect(serialized).not.toContain("key_sensitive");
    expect(serialized).not.toContain("workspace_private");
    expect(serialized).not.toContain("openrouter.ai");
    expect(serialized).not.toContain("sk-or-");
  });

  it("fails closed when an unexpected evaluator error contains provider metadata", () => {
    const diagnostic = embeddingIndexEvaluationErrorMessage(new Error(
      "Inspect key_sensitive at https://openrouter.ai/settings/keys/key_sensitive?workspace=ws_private",
    ));

    expect(diagnostic).toBe(
      "Embedding index evaluation failed without exposing provider diagnostics.",
    );
    expect(diagnostic).not.toMatch(/key_sensitive|workspace_private|openrouter\.ai/);
  });
});
