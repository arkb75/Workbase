export const WORKBASE_EMBEDDING_DIMENSIONS = 512;
export const OPENROUTER_EMBEDDING_API_KEY_REQUIRED_MESSAGE =
  "OPENROUTER_API_KEY is required when an OpenRouter embedding index is enabled.";

export type EmbeddingProvider = "bedrock" | "openrouter" | "mock";

export type EmbeddingIndexIdentity = {
  id: string;
  key: string;
  provider: EmbeddingProvider;
  modelId: string;
  dimensions: number;
};

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
) {
  return Math.min(positiveInteger(value, fallback), maximum);
}

export function resolveBedrockEmbeddingRuntimeConfig() {
  return {
    region: process.env.WORKBASE_BEDROCK_REGION ?? "us-east-1",
    profile: process.env.WORKBASE_AWS_PROFILE || undefined,
  };
}

export function resolveOpenRouterEmbeddingRuntimeConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(OPENROUTER_EMBEDDING_API_KEY_REQUIRED_MESSAGE);
  }

  return {
    apiKey,
    baseUrl: (process.env.WORKBASE_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    timeoutMs: boundedPositiveInteger(
      process.env.WORKBASE_OPENROUTER_EMBEDDING_TIMEOUT_MS,
      60_000,
      120_000,
    ),
    maxAttempts: boundedPositiveInteger(
      process.env.WORKBASE_OPENROUTER_EMBEDDING_MAX_ATTEMPTS,
      2,
      2,
    ),
    appUrl: process.env.WORKBASE_OPENROUTER_APP_URL || undefined,
    appName: process.env.WORKBASE_OPENROUTER_APP_NAME ?? "Workbase",
  };
}

export function resolveConfiguredEmbeddingCandidate(input?: {
  provider?: string;
  modelId?: string;
  key?: string;
}): Omit<EmbeddingIndexIdentity, "id"> {
  const provider = input?.provider ??
    process.env.WORKBASE_EMBEDDING_PROVIDER ??
    "bedrock";
  if (provider !== "bedrock" && provider !== "openrouter" && provider !== "mock") {
    throw new Error(
      `Unsupported WORKBASE_EMBEDDING_PROVIDER "${provider}". Expected bedrock, openrouter, or mock.`,
    );
  }

  const modelId = input?.modelId ??
    (provider === "openrouter"
      ? process.env.WORKBASE_OPENROUTER_EMBEDDING_MODEL_ID ??
        "openai/text-embedding-3-small"
      : provider === "mock"
        ? "mock-workbase-embed-v1"
        : process.env.WORKBASE_BEDROCK_EMBEDDING_MODEL_ID ??
          "amazon.titan-embed-text-v2:0");
  const key = input?.key ??
    `${provider}-${modelId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-${WORKBASE_EMBEDDING_DIMENSIONS}`;

  return {
    key,
    provider,
    modelId,
    dimensions: WORKBASE_EMBEDDING_DIMENSIONS,
  };
}

export function resolveConfiguredEmbeddingChallenger() {
  return resolveConfiguredEmbeddingCandidate({
    provider: "openrouter",
    modelId:
      process.env.WORKBASE_OPENROUTER_EMBEDDING_CHALLENGER_MODEL_ID ??
      "openai/text-embedding-3-large",
  });
}

export function assertEmbeddingIndexIdentity(
  identity: EmbeddingIndexIdentity,
): EmbeddingIndexIdentity {
  if (!identity.id || !identity.key || !identity.modelId) {
    throw new Error("Embedding index identity is incomplete.");
  }
  if (
    identity.provider !== "bedrock" &&
    identity.provider !== "openrouter" &&
    identity.provider !== "mock"
  ) {
    throw new Error(`Unsupported embedding provider "${identity.provider}".`);
  }
  if (identity.dimensions !== WORKBASE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding index "${identity.key}" has ${identity.dimensions} dimensions; Workbase requires ${WORKBASE_EMBEDDING_DIMENSIONS}.`,
    );
  }
  return identity;
}
