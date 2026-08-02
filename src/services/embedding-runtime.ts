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
};

export type OpenRouterEmbeddingFailureClassification =
  | "authentication"
  | "billing"
  | "invalid_response"
  | "rate_limit"
  | "request_rejected"
  | "timeout"
  | "transport"
  | "unavailable";

const openRouterEmbeddingFailureClassifications = new Set<
  OpenRouterEmbeddingFailureClassification
>([
  "authentication",
  "billing",
  "invalid_response",
  "rate_limit",
  "request_rejected",
  "timeout",
  "transport",
  "unavailable",
]);

type OpenRouterEmbeddingFailureState = Readonly<{
  status: number | null;
  classification: OpenRouterEmbeddingFailureClassification;
}>;

// Prototype checks are not an authenticity boundary: Object.create() and
// Proxy can both produce values that satisfy instanceof. Keep the canonical
// state private so caught transport values can only retain state that this
// module assigned during construction.
const openRouterEmbeddingFailureStates = new WeakMap<
  OpenRouterEmbeddingRequestError,
  OpenRouterEmbeddingFailureState
>();

function normalizedOpenRouterEmbeddingStatus(status: unknown) {
  return typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ? status
    : null;
}

function normalizedOpenRouterEmbeddingClassification(
  classification: unknown,
): OpenRouterEmbeddingFailureClassification {
  return typeof classification === "string" &&
      openRouterEmbeddingFailureClassifications.has(
        classification as OpenRouterEmbeddingFailureClassification,
      )
    ? classification as OpenRouterEmbeddingFailureClassification
    : "transport";
}

function openRouterEmbeddingFailureIsRetryable(
  status: number | null,
  classification: OpenRouterEmbeddingFailureClassification,
) {
  return classification === "rate_limit" ||
    classification === "timeout" ||
    classification === "transport" ||
    classification === "unavailable" ||
    (classification === "request_rejected" && status === 409);
}

function openRouterEmbeddingFailureMessage(
  status: number | null,
  classification: OpenRouterEmbeddingFailureClassification,
) {
  switch (classification) {
    case "authentication":
      return "OpenRouter authentication or access was rejected for this embedding request.";
    case "billing":
      return "OpenRouter account credits are insufficient for this embedding request.";
    case "invalid_response":
      return "OpenRouter returned an invalid embedding response.";
    case "rate_limit":
      return "OpenRouter rate-limited this embedding request.";
    case "timeout":
      return status === 408
        ? "OpenRouter timed out while processing this embedding request."
        : "OpenRouter timed out before returning an embedding response.";
    case "unavailable":
      return "OpenRouter or the selected embedding provider is temporarily unavailable.";
    case "request_rejected":
      if (status === 400 || status === 404 || status === 409 || status === 422) {
        return "OpenRouter rejected this embedding request's parameters or state.";
      }
      return status === null
        ? "OpenRouter could not complete this embedding request."
        : `OpenRouter could not complete this embedding request (HTTP ${status}).`;
    case "transport":
      return "OpenRouter embedding transport failed before a response was received.";
  }
}

/**
 * Carries only allowlisted provider diagnostics. Raw response messages, URLs,
 * key identifiers, and workspace metadata must never cross this boundary.
 */
export class OpenRouterEmbeddingRequestError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly classification: OpenRouterEmbeddingFailureClassification;

  constructor(
    status: number | null,
    classification: OpenRouterEmbeddingFailureClassification,
  ) {
    const safeStatus = normalizedOpenRouterEmbeddingStatus(status);
    const safeClassification = normalizedOpenRouterEmbeddingClassification(classification);
    super(openRouterEmbeddingFailureMessage(safeStatus, safeClassification));
    this.name = "OpenRouterEmbeddingRequestError";
    this.status = safeStatus;
    this.retryable = openRouterEmbeddingFailureIsRetryable(
      safeStatus,
      safeClassification,
    );
    this.classification = safeClassification;
    openRouterEmbeddingFailureStates.set(this, {
      status: safeStatus,
      classification: safeClassification,
    });
    // Keep the diagnostic and classification closed after construction so a
    // caught provider error cannot be decorated later with raw response data.
    Object.freeze(this);
  }
}

function closedOpenRouterEmbeddingRequestError(error: unknown) {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return null;
  }
  const state = openRouterEmbeddingFailureStates.get(
    error as OpenRouterEmbeddingRequestError,
  );
  return state
    ? new OpenRouterEmbeddingRequestError(state.status, state.classification)
    : null;
}

/** Reconstructs the closed diagnostic without trusting Error.message. */
export function openRouterEmbeddingRequestErrorMessage(
  error: OpenRouterEmbeddingRequestError,
) {
  const state = openRouterEmbeddingFailureStates.get(error);
  return openRouterEmbeddingFailureMessage(
    state?.status ?? null,
    state?.classification ?? "transport",
  );
}

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
  let retryAfter: string | null = null;
  try {
    retryAfter = response?.headers.get("retry-after") ?? null;
  } catch {
    // Header implementations are part of the provider transport boundary.
    // Never let a custom/native header exception carry raw metadata outward.
  }
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1_000));
  }
  return Math.min(2_000, 150 * (2 ** attempt));
}

function retryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function openRouterEmbeddingHttpError(status: number) {
  if (status === 401 || status === 403) {
    return new OpenRouterEmbeddingRequestError(status, "authentication");
  }
  if (status === 402) {
    return new OpenRouterEmbeddingRequestError(status, "billing");
  }
  if (status === 408) {
    return new OpenRouterEmbeddingRequestError(status, "timeout");
  }
  if (status === 429) {
    return new OpenRouterEmbeddingRequestError(status, "rate_limit");
  }
  if (status >= 500) {
    return new OpenRouterEmbeddingRequestError(status, "unavailable");
  }
  return new OpenRouterEmbeddingRequestError(status, "request_rejected");
}

function invalidOpenRouterEmbeddingResponse(status: number) {
  return status >= 400
    ? openRouterEmbeddingHttpError(status)
    : new OpenRouterEmbeddingRequestError(status, "invalid_response");
}

function safeResponseStatus(response: Response) {
  try {
    return normalizedOpenRouterEmbeddingStatus(response.status);
  } catch {
    return null;
  }
}

function openRouterEmbeddingTransportError(timedOut: boolean) {
  return new OpenRouterEmbeddingRequestError(
    null,
    timedOut ? "timeout" : "transport",
  );
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
    let responseBodyRead = false;
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
      responseBodyRead = true;
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
        throw invalidOpenRouterEmbeddingResponse(response.status);
      }
      if (!response.ok) {
        // The provider payload is intentionally ignored. OpenRouter error
        // messages can contain key-management URLs, key IDs, or workspace IDs.
        const error = openRouterEmbeddingHttpError(response.status);
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
      const closedProviderFailure = closedOpenRouterEmbeddingRequestError(error);
      if (closedProviderFailure) throw closedProviderFailure;
      const responseStatus = response && responseBodyRead
        ? safeResponseStatus(response)
        : null;
      const safeError = response && responseBodyRead
        ? responseStatus === null
          ? new OpenRouterEmbeddingRequestError(null, "invalid_response")
          : invalidOpenRouterEmbeddingResponse(responseStatus)
        : openRouterEmbeddingTransportError(controller.signal.aborted);
      lastError = safeError;
      if (!safeError.retryable || attempt === config.maxAttempts - 1) throw safeError;
      await delay(retryDelayMs(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw closedOpenRouterEmbeddingRequestError(lastError) ??
    openRouterEmbeddingTransportError(false);
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
