import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddingIndexEvaluationErrorMessage } from "@/src/evals/embedding-index-error";
import { OPENROUTER_EMBEDDING_API_KEY_REQUIRED_MESSAGE } from "@/src/lib/embedding-config";
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

  it.each([
    ["wrong vector space", [1, 2, 3]],
    ["missing vector", undefined],
  ])("classifies a valid-JSON 2xx response with %s", async (_label, embedding) => {
    process.env.OPENROUTER_API_KEY = "private-test-key";
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        data: [{ index: 0, embedding }],
      }), { status: 200 })
    );

    await expect(requestOpenRouterEmbedding({
      identity,
      inputText: "wrong dimensions",
      fetchImpl,
    })).rejects.toMatchObject({
      name: "OpenRouterEmbeddingRequestError",
      message: "OpenRouter returned an invalid embedding response.",
      status: 200,
      retryable: false,
      classification: "invalid_response",
    });
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

  it.each([
    [400, "request_rejected", false, "OpenRouter rejected this embedding request's parameters or state."],
    [401, "authentication", false, "OpenRouter authentication or access was rejected for this embedding request."],
    [402, "billing", false, "OpenRouter account credits are insufficient for this embedding request."],
    [408, "timeout", true, "OpenRouter timed out while processing this embedding request."],
    [409, "request_rejected", true, "OpenRouter rejected this embedding request's parameters or state."],
    [429, "rate_limit", true, "OpenRouter rate-limited this embedding request."],
    [503, "unavailable", true, "OpenRouter or the selected embedding provider is temporarily unavailable."],
  ])(
    "retains the closed HTTP %i classification",
    async (status, classification, retryable, message) => {
      process.env.OPENROUTER_API_KEY = "private-test-key";
      process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS = "1";
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({
          error: {
            message: "Authorization: Bearer provider-secret; request-id req_secret",
          },
        }), { status })
      );

      await expect(requestOpenRouterEmbedding({
        identity,
        inputText: "classified provider failure",
        fetchImpl,
      })).rejects.toMatchObject({
        name: "OpenRouterEmbeddingRequestError",
        message,
        status,
        retryable,
        classification,
      });
    },
  );

  it("fails closed when an unexpected evaluator error contains provider metadata", () => {
    const unsafeMessages = [
      "Provider request req_sensitive failed with request-id request_sensitive.",
      "Authorization: Bearer bearer_sensitive; x-request-id: req_sensitive.",
      "Headers: x-ratelimit-reset=123, cf-ray=ray_sensitive.",
      "Insufficient credits for account acct_sensitive; add funds. " + "x".repeat(5_000),
      "Manage key id kid_sensitive for this request.",
      "Workspace id ws_sensitive rejected the request.",
      "Inspect https://openrouter.ai/settings/keys/key_sensitive?workspace=ws_private.",
    ];

    for (const message of unsafeMessages) {
      const diagnostic = embeddingIndexEvaluationErrorMessage(new Error(message));
      expect(diagnostic).toBe(
        "Embedding index evaluation failed without exposing provider diagnostics.",
      );
      expect(diagnostic.length).toBeLessThanOrEqual(1_000);
      expect(diagnostic).not.toMatch(
        /sensitive|authorization|bearer|request-id|x-ratelimit|cf-ray|insufficient credits/i,
      );
    }
  });

  it.each([
    [
      "fetch rejection",
      async () => {
        throw new Error(
          "Provider request req_fetch leaked; Authorization: Bearer fetch-secret",
        );
      },
    ],
    [
      "body stream rejection",
      async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error(
            "Provider body req_body leaked; x-request-id: req_body",
          ));
        },
      }), { status: 200 }),
    ],
  ])("collapses an ordinary Error from the %s boundary", async (_label, fetchImpl) => {
    process.env.OPENROUTER_API_KEY = "private-test-key";
    process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS = "1";

    let failure: unknown;
    try {
      await requestOpenRouterEmbedding({
        identity,
        inputText: "transport failure",
        fetchImpl: fetchImpl as typeof fetch,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenRouterEmbeddingRequestError);
    expect(failure).toMatchObject({
      message: "OpenRouter embedding transport failed before a response was received.",
      status: null,
      retryable: true,
      classification: "transport",
    });
    const serialized = `${embeddingIndexEvaluationErrorMessage(failure)} ${JSON.stringify(failure)}`;
    expect(serialized).not.toMatch(
      /req_fetch|fetch-secret|req_body|authorization|bearer|x-request-id/i,
    );
  });

  it("cannot construct or mutate a typed failure with an arbitrary unbounded message", () => {
    const unsafeMessage =
      "Insufficient credits for account acct_sensitive; Authorization: Bearer secret; " +
      "x".repeat(5_000);
    const failure = Reflect.construct(
      OpenRouterEmbeddingRequestError,
      [429, unsafeMessage],
    ) as OpenRouterEmbeddingRequestError;

    expect(failure).toMatchObject({
      message: "OpenRouter embedding transport failed before a response was received.",
      status: 429,
      retryable: true,
      classification: "transport",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(() => {
      (failure as { message: string }).message = unsafeMessage;
    }).toThrow(TypeError);
    const diagnostic = embeddingIndexEvaluationErrorMessage(failure);
    expect(diagnostic.length).toBeLessThanOrEqual(1_000);
    expect(diagnostic).not.toMatch(/acct_sensitive|authorization|bearer|insufficient/i);
  });

  it.each([
    [
      "prototype-forged failure",
      () => {
        const failure = Object.create(OpenRouterEmbeddingRequestError.prototype);
        Object.defineProperties(failure, {
          name: { value: "OpenRouterEmbeddingRequestError", enumerable: true },
          message: {
            value: "Authorization: Bearer forged-secret; request-id req_forged",
            enumerable: true,
          },
          status: { value: 429, enumerable: true },
          retryable: { value: true, enumerable: true },
          classification: { value: "rate_limit", enumerable: true },
        });
        return Object.freeze(failure) as OpenRouterEmbeddingRequestError;
      },
    ],
    [
      "proxied genuine failure",
      () => new Proxy(
        new OpenRouterEmbeddingRequestError(429, "rate_limit"),
        {
          get(target, property, receiver) {
            if (property === "message") {
              return "Authorization: Bearer proxy-secret; request-id req_proxy";
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ),
    ],
  ])("reconstructs a %s rejected by the transport", async (_label, createFailure) => {
    process.env.OPENROUTER_API_KEY = "private-test-key";
    process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS = "1";
    const injectedFailure = createFailure();
    const fetchImpl = vi.fn(async () => {
      throw injectedFailure;
    });

    let failure: unknown;
    try {
      await requestOpenRouterEmbedding({
        identity,
        inputText: "untrusted typed transport failure",
        fetchImpl,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).not.toBe(injectedFailure);
    expect(failure).toBeInstanceOf(OpenRouterEmbeddingRequestError);
    expect(failure).toMatchObject({
      message: "OpenRouter embedding transport failed before a response was received.",
      status: null,
      retryable: true,
      classification: "transport",
    });
    const serialized = `${embeddingIndexEvaluationErrorMessage(failure)} ${JSON.stringify(failure)}`;
    expect(serialized).not.toMatch(
      /forged-secret|proxy-secret|req_forged|req_proxy|authorization|bearer/i,
    );
  });

  it("fails closed when an Error exposes a throwing diagnostic accessor", () => {
    const failure = new Error("placeholder");
    Object.defineProperty(failure, "message", {
      get() {
        throw new Error(
          "Authorization: Bearer accessor-secret; request-id req_accessor " +
          "x".repeat(5_000),
        );
      },
    });

    expect(embeddingIndexEvaluationErrorMessage(failure)).toBe(
      "Embedding index evaluation failed without exposing provider diagnostics.",
    );
  });

  it("preserves the explicit safe local missing-key diagnostic", async () => {
    delete process.env.OPENROUTER_API_KEY;
    let failure: unknown;
    try {
      await requestOpenRouterEmbedding({
        identity,
        inputText: "missing local configuration",
        fetchImpl: vi.fn(),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(embeddingIndexEvaluationErrorMessage(failure)).toBe(
      OPENROUTER_EMBEDDING_API_KEY_REQUIRED_MESSAGE,
    );
  });
});
