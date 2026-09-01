import {
  BedrockConverseAgent,
  AwsBedrockConverseTransport,
  type BedrockConverseAgentLimits,
  type BedrockConverseTransport,
} from "@/src/lib/bedrock-converse-agent";
import {
  AwsBedrockConverseRuntime,
  BedrockStructuredLlmClient,
  type ConverseTextRuntime,
} from "@/src/lib/bedrock-structured-llm-client";
import {
  resolveBedrockConfig,
  resolveOpenRouterConfig,
  resolveWorkbaseLlmProvider,
  type OpenRouterTextConfig,
  type TextModelProfile,
} from "@/src/lib/llm-config";
import {
  OpenRouterChatCompletionsRuntime,
  OpenRouterConverseTransport,
  RetryableFallbackConverseTransport,
  RetryableFallbackTextRuntime,
  RetryableSameModelTextRuntime,
} from "@/src/lib/openrouter-client";

const cachedClients = new Map<TextModelProfile, BedrockStructuredLlmClient>();

function openRouterTextRuntime(config: OpenRouterTextConfig): ConverseTextRuntime {
  const primary = new RetryableSameModelTextRuntime(
    new OpenRouterChatCompletionsRuntime(config),
    config,
    config.modelId,
  );
  return config.fallbackModelId
    ? new RetryableFallbackTextRuntime(
        primary,
        new OpenRouterChatCompletionsRuntime(config, config.fallbackModelId),
        config.modelId,
        config.fallbackModelId,
      )
    : primary;
}

function openRouterConverseTransport(
  config: OpenRouterTextConfig,
): BedrockConverseTransport {
  const primary = new OpenRouterConverseTransport(config);
  return config.fallbackModelId
    ? new RetryableFallbackConverseTransport(
        primary,
        new OpenRouterConverseTransport(config, config.fallbackModelId),
        config.modelId,
        config.fallbackModelId,
      )
    : primary;
}

export function getStructuredLlmClient(
  profile: TextModelProfile = "deep_synthesis",
) {
  const existing = cachedClients.get(profile);
  if (existing) return existing;

  const provider = resolveWorkbaseLlmProvider();
  let client: BedrockStructuredLlmClient;
  if (provider === "openrouter") {
    const config = resolveOpenRouterConfig(profile);
    const repairConfig = resolveOpenRouterConfig("json_repair");
    client = new BedrockStructuredLlmClient(
      openRouterTextRuntime(config),
      {
        provider: config.provider,
        modelId: config.modelId,
        region: null,
        defaultTransportPreference: [
          "json_schema",
          "strict_tool_use",
          "text_repair_fallback",
        ],
      },
      profile === "json_repair"
        ? undefined
        : openRouterTextRuntime(repairConfig),
    );
  } else if (provider === "bedrock") {
    const config = resolveBedrockConfig();
    client = new BedrockStructuredLlmClient(
      new AwsBedrockConverseRuntime(config),
      {
        provider: config.provider,
        region: config.region,
        modelId: config.modelId,
        defaultTransportPreference: [
          "json_schema",
          "strict_tool_use",
          "text_repair_fallback",
        ],
      },
    );
  } else {
    throw new Error(
      "A structured model client is unavailable when WORKBASE_LLM_PROVIDER=mock.",
    );
  }

  cachedClients.set(profile, client);
  return client;
}

export function createTextConverseAgent(input: {
  profile?: TextModelProfile;
  defaultLimits?: Partial<BedrockConverseAgentLimits>;
}) {
  const profile = input.profile ?? "primary_answer";
  const provider = resolveWorkbaseLlmProvider();
  if (provider === "openrouter") {
    const config = resolveOpenRouterConfig(profile);
    return new BedrockConverseAgent(openRouterConverseTransport(config), {
      modelId: config.modelId,
      defaultLimits: input.defaultLimits,
      providerLabel: "OpenRouter",
      modelProfile: profile,
    });
  }
  if (provider === "bedrock") {
    const config = resolveBedrockConfig();
    return new BedrockConverseAgent(
      new AwsBedrockConverseTransport({
        region: config.region,
        profile: config.profile,
      }),
      {
        modelId: config.modelId,
        defaultLimits: input.defaultLimits,
        modelProfile: profile,
      },
    );
  }
  throw new Error(
    "A conversation model agent is unavailable when WORKBASE_LLM_PROVIDER=mock.",
  );
}
