import { createHash } from "node:crypto";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  assertEmbeddingIndexIdentity,
  type EmbeddingIndexIdentity,
  resolveBedrockEmbeddingRuntimeConfig,
  resolveOpenRouterEmbeddingRuntimeConfig,
  WORKBASE_EMBEDDING_DIMENSIONS,
} from "@/src/lib/embedding-config";
import { normalizeWhitespace } from "@/src/lib/utils";

export type EmbeddingUsage = {
  inputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};

export type GeneratedEmbedding = EmbeddingIndexIdentity & {
  inputHash: string;
  inputText: string;
  vector: number[];
  usage: EmbeddingUsage;
};

type OpenRouterEmbeddingResponse = {
  data?: Array<{ embedding?: unknown; index?: number }>;
  usage?: {
    prompt_tokens?: unknown;
    input_tokens?: unknown;
    total_tokens?: unknown;
    cost?: unknown;
  };
  error?: { message?: unknown; code?: unknown };
};

let cachedBedrockClient: BedrockRuntimeClient | null = null;
let cachedBedrockClientKey = "";

export function hashEmbeddingInput(inputText: string) {
  return createHash("sha256").update(inputText).digest("hex");
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude ? vector.map((value) => value / magnitude) : vector;
}

function deterministicEmbedding(inputText: string) {
  const vector = Array.from({ length: WORKBASE_EMBEDDING_DIMENSIONS }, () => 0);
  const tokens = normalizeWhitespace(inputText.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);

  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash.readUInt16BE(0) % WORKBASE_EMBEDDING_DIMENSIONS;
    const sign = hash[2] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  return normalizeVector(vector);
}

export function assertEmbeddingVector(vector: unknown): asserts vector is number[] {
  if (
    !Array.isArray(vector) ||
    vector.length !== WORKBASE_EMBEDDING_DIMENSIONS ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(
      `Embedding response did not include a valid ${WORKBASE_EMBEDDING_DIMENSIONS}-dimensional vector.`,
    );
  }
}

export function vectorToSqlLiteral(vector: number[]) {
  assertEmbeddingVector(vector);
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

function nullableFiniteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function retryDelayMs(response: Response | undefined, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1_000));
  }
  return Math.min(2_000, 150 * (2 ** attempt));
}

function retryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestOpenRouterEmbedding(input: {
  identity: EmbeddingIndexIdentity;
  inputText: string;
  fetchImpl?: typeof fetch;
}) {
  const identity = assertEmbeddingIndexIdentity(input.identity);
  const config = resolveOpenRouterEmbeddingRuntimeConfig();
  const fetchImpl = input.fetchImpl ?? fetch;
  let lastError: unknown;

  // At most one transport retry. Higher-level embedding writes already fence
  // and retry when the write set changes, so a larger provider loop would
  // multiply latency and request spend.
  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    let response: Response | undefined;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": config.appName,
      };
      if (config.appUrl) headers["HTTP-Referer"] = config.appUrl;
      response = await fetchImpl(`${config.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: identity.modelId,
          input: input.inputText,
          dimensions: identity.dimensions,
          encoding_format: "float",
          provider: {
            zdr: true,
            require_parameters: true,
          },
        }),
        signal: controller.signal,
      });
      const rawBody = await response.text();
      let parsed: OpenRouterEmbeddingResponse;
      try {
        parsed = JSON.parse(rawBody) as OpenRouterEmbeddingResponse;
      } catch {
        if (
          !response.ok &&
          retryableStatus(response.status) &&
          attempt < config.maxAttempts - 1
        ) {
          await delay(retryDelayMs(response, attempt));
          continue;
        }
        throw new Error(`OpenRouter embeddings returned non-JSON HTTP ${response.status}.`);
      }
      if (!response.ok) {
        const providerMessage =
          typeof parsed.error?.message === "string"
            ? parsed.error.message
            : `HTTP ${response.status}`;
        const error = new Error(`OpenRouter embeddings request failed: ${providerMessage}.`);
        if (!retryableStatus(response.status) || attempt === config.maxAttempts - 1) {
          throw error;
        }
        lastError = error;
        await delay(retryDelayMs(response, attempt));
        continue;
      }

      const vector = parsed.data?.[0]?.embedding;
      assertEmbeddingVector(vector);
      const inputTokens = nullableFiniteNumber(
        parsed.usage?.input_tokens ?? parsed.usage?.prompt_tokens,
      );
      return {
        vector: normalizeVector(vector),
        usage: {
          inputTokens,
          totalTokens: nullableFiniteNumber(parsed.usage?.total_tokens),
          costUsd: nullableFiniteNumber(parsed.usage?.cost),
        } satisfies EmbeddingUsage,
      };
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "AbortError");
      if (!retryable || attempt === config.maxAttempts - 1) throw error;
      await delay(retryDelayMs(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("OpenRouter embeddings request failed.");
}

function getBedrockClient() {
  const config = resolveBedrockEmbeddingRuntimeConfig();
  const key = `${config.region}:${config.profile ?? ""}`;
  if (!cachedBedrockClient || cachedBedrockClientKey !== key) {
    cachedBedrockClient = new BedrockRuntimeClient({
      region: config.region,
      credentials: config.profile ? fromIni({ profile: config.profile }) : undefined,
    });
    cachedBedrockClientKey = key;
  }
  return cachedBedrockClient;
}

async function requestBedrockEmbedding(input: {
  identity: EmbeddingIndexIdentity;
  inputText: string;
}) {
  const response = await getBedrockClient().send(
    new InvokeModelCommand({
      modelId: input.identity.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: input.inputText,
        dimensions: input.identity.dimensions,
        normalize: true,
      }),
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
    embedding?: unknown;
    inputTextTokenCount?: unknown;
  };
  assertEmbeddingVector(parsed.embedding);
  const inputTokens = nullableFiniteNumber(parsed.inputTextTokenCount);
  return {
    vector: parsed.embedding,
    usage: {
      inputTokens,
      totalTokens: inputTokens,
      costUsd: null,
    } satisfies EmbeddingUsage,
  };
}

export async function generateEmbeddingForIndex(input: {
  identity: EmbeddingIndexIdentity;
  inputText: string;
  fetchImpl?: typeof fetch;
}): Promise<GeneratedEmbedding> {
  const identity = assertEmbeddingIndexIdentity(input.identity);
  // Real index identities always use their real provider, including in test
  // processes. Tests that need deterministic vectors inject a provider=mock
  // identity so environment flags can never corrupt a real vector space.
  const generated = identity.provider === "mock"
    ? {
        vector: deterministicEmbedding(input.inputText),
        usage: { inputTokens: null, totalTokens: null, costUsd: null },
      }
    : identity.provider === "openrouter"
      ? await requestOpenRouterEmbedding(input)
      : await requestBedrockEmbedding(input);

  return {
    ...identity,
    inputHash: hashEmbeddingInput(input.inputText),
    inputText: input.inputText,
    vector: generated.vector,
    usage: generated.usage,
  };
}
