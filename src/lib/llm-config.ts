export const textModelProfiles = [
  "primary_answer",
  "deep_synthesis",
  "verification",
  "drafting",
  "code_extraction",
  "routing",
  "json_repair",
] as const;

export type TextModelProfile = (typeof textModelProfiles)[number];
export type WorkbaseLlmProvider = "bedrock" | "openrouter" | "mock";

export const DEFAULT_OPENROUTER_MODEL_ID = "openai/gpt-5.6-terra";
export const DEFAULT_OPENROUTER_FALLBACK_MODEL_ID = "anthropic/claude-sonnet-5";

const profileEnvironmentSuffix: Record<TextModelProfile, string> = {
  primary_answer: "PRIMARY_ANSWER",
  deep_synthesis: "DEEP_SYNTHESIS",
  verification: "VERIFICATION",
  drafting: "DRAFTING",
  code_extraction: "CODE_EXTRACTION",
  routing: "ROUTING",
  json_repair: "JSON_REPAIR",
};

function positiveRequestTimeout(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(600_000, Math.max(30_000, Math.floor(parsed)))
    : fallback;
}

function commaSeparatedValues(value: string | undefined) {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveWorkbaseLlmProvider(): WorkbaseLlmProvider {
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
    return "mock";
  }

  const configured = process.env.WORKBASE_LLM_PROVIDER?.trim().toLowerCase();
  if (!configured) {
    throw new Error(
      "WORKBASE_LLM_PROVIDER is required outside tests. Set it to openrouter, bedrock, or mock.",
    );
  }
  if (configured === "mock" || configured === "bedrock" || configured === "openrouter") {
    return configured;
  }

  throw new Error(
    `Unsupported WORKBASE_LLM_PROVIDER "${process.env.WORKBASE_LLM_PROVIDER}". Expected openrouter, bedrock, or mock.`,
  );
}

export function resolveBedrockConfig() {
  const modelId = process.env.WORKBASE_BEDROCK_MODEL_ID;

  if (!modelId) {
    throw new Error(
      "WORKBASE_BEDROCK_MODEL_ID is required when WORKBASE_LLM_PROVIDER=bedrock.",
    );
  }

  return {
    provider: "bedrock" as const,
    region: process.env.WORKBASE_BEDROCK_REGION ?? "us-east-1",
    modelId,
    profile: process.env.WORKBASE_AWS_PROFILE || undefined,
  };
}

export interface OpenRouterTextConfig {
  provider: "openrouter";
  baseUrl: string;
  apiKey: string;
  modelId: string;
  fallbackModelId?: string;
  profile: TextModelProfile;
  requestTimeoutMs: number;
  providerOrder?: string[];
  siteUrl?: string;
  appName: string;
  zeroDataRetention: true;
  requireParameters: true;
  sendTemperature: boolean;
}

export function resolveOpenRouterConfig(
  profile: TextModelProfile = "primary_answer",
): OpenRouterTextConfig {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required when WORKBASE_LLM_PROVIDER=openrouter.",
    );
  }

  const primaryModelId =
    process.env.WORKBASE_OPENROUTER_MODEL_ID?.trim() ||
    DEFAULT_OPENROUTER_MODEL_ID;
  const profileModelId =
    process.env[`WORKBASE_OPENROUTER_MODEL_${profileEnvironmentSuffix[profile]}`]?.trim() ||
    primaryModelId;
  const configuredFallback =
    process.env.WORKBASE_OPENROUTER_FALLBACK_MODEL_ID?.trim() ||
    DEFAULT_OPENROUTER_FALLBACK_MODEL_ID;

  return {
    provider: "openrouter",
    baseUrl: (
      process.env.WORKBASE_OPENROUTER_BASE_URL?.trim() ||
      "https://openrouter.ai/api/v1"
    ).replace(/\/+$/, ""),
    apiKey,
    modelId: profileModelId,
    // Cross-family fallback is deliberately restricted to the primary-quality
    // profiles. Specialized profiles fail closed on model-specific errors and
    // rely on OpenRouter's same-model provider failover first.
    fallbackModelId:
      profile === "primary_answer" ||
      profile === "deep_synthesis" ||
      profile === "verification"
        ? configuredFallback === profileModelId
          ? undefined
          : configuredFallback
        : undefined,
    profile,
    requestTimeoutMs: positiveRequestTimeout(
      process.env.WORKBASE_OPENROUTER_REQUEST_TIMEOUT_MS,
      240_000,
    ),
    providerOrder: commaSeparatedValues(
      process.env.WORKBASE_OPENROUTER_PROVIDER_ORDER,
    ),
    siteUrl:
      process.env.WORKBASE_OPENROUTER_APP_URL?.trim() ||
      process.env.WORKBASE_PUBLIC_URL?.trim() ||
      undefined,
    appName: process.env.WORKBASE_OPENROUTER_APP_NAME?.trim() || "Workbase",
    // Privacy is a runtime invariant rather than a switchable environment
    // preference. Deployments cannot accidentally relax it.
    zeroDataRetention: true,
    requireParameters: true,
    // The currently approved reasoning-model matrix does not advertise
    // temperature support. With require_parameters enabled, sending it would
    // remove every eligible endpoint. This escape hatch is only for a
    // capability-reviewed model override.
    sendTemperature:
      process.env.WORKBASE_OPENROUTER_SEND_TEMPERATURE === "true",
  };
}

export type ActiveTextModelConfig =
  | ReturnType<typeof resolveBedrockConfig>
  | OpenRouterTextConfig
  | {
      provider: "mock";
      modelId: "mock";
      profile: TextModelProfile;
    };

export function resolveTextModelConfig(
  profile: TextModelProfile = "primary_answer",
): ActiveTextModelConfig {
  const provider = resolveWorkbaseLlmProvider();
  if (provider === "mock") {
    return { provider: "mock", modelId: "mock", profile };
  }
  if (provider === "openrouter") {
    return resolveOpenRouterConfig(profile);
  }
  return resolveBedrockConfig();
}

export function resolveActiveTextModelIdentity(
  profile: TextModelProfile = "primary_answer",
) {
  const config = resolveTextModelConfig(profile);
  return {
    provider: config.provider,
    modelId: config.modelId,
    profile,
  };
}

export function resolveBedrockEmbeddingConfig() {
  return {
    provider: "bedrock" as const,
    region: process.env.WORKBASE_BEDROCK_REGION ?? "us-east-1",
    modelId:
      process.env.WORKBASE_BEDROCK_EMBEDDING_MODEL_ID ??
      "amazon.titan-embed-text-v2:0",
    profile: process.env.WORKBASE_AWS_PROFILE || undefined,
    dimensions: 512,
    normalize: true,
  };
}
