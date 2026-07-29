import { OpenRouterChatCompletionsRuntime } from "../src/lib/openrouter-client";
import {
  resolveOpenRouterConfig,
  textModelProfiles,
} from "../src/lib/llm-config";

const capabilitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["ok"] },
  },
};

function assertCapabilityResult(
  label: string,
  result: Awaited<ReturnType<OpenRouterChatCompletionsRuntime["converse"]>>,
) {
  const value =
    result.structuredData ??
    (() => {
      try {
        return JSON.parse(result.text) as unknown;
      } catch {
        return null;
      }
    })();
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "ok"
  ) {
    throw new Error(`${label} did not return the required structured result.`);
  }
  if (
    !result.tokenUsage ||
    typeof result.tokenUsage !== "object" ||
    Array.isArray(result.tokenUsage) ||
    typeof result.tokenUsage.totalTokens !== "number" ||
    typeof result.tokenUsage.cost !== "number"
  ) {
    throw new Error(
      `${label} did not return authoritative token usage and usage.cost.`,
    );
  }
}

async function main() {
  const profileConfigs = textModelProfiles.map((profile) => ({
    profile,
    config: resolveOpenRouterConfig(profile),
  }));
  const uniqueModelMap = new Map<string, {
    config: ReturnType<typeof resolveOpenRouterConfig>;
    profiles: string[];
  }>();
  for (const entry of profileConfigs) {
    const candidates = [
      { modelId: entry.config.modelId, label: entry.profile },
      ...(entry.config.fallbackModelId
        ? [{
            modelId: entry.config.fallbackModelId,
            label: `${entry.profile}:fallback`,
          }]
        : []),
    ];
    for (const candidate of candidates) {
      const current = uniqueModelMap.get(candidate.modelId);
      uniqueModelMap.set(candidate.modelId, {
        config: { ...entry.config, modelId: candidate.modelId },
        profiles: [...(current?.profiles ?? []), candidate.label],
      });
    }
  }
  const uniqueModels = Array.from(uniqueModelMap);
  const common = {
    systemPrompt:
      "You are the Workbase OpenRouter capability check. Follow the requested schema exactly.",
    userPrompt: "Return status ok.",
    maxTokens: 128,
    temperature: 0,
    effort: "low" as const,
    enablePromptCaching: false,
  };
  const modelResults: Array<{
    configuredModelId: string;
    profiles: string[];
    actualModelId: string | undefined;
    requestId: string | null | undefined;
    routedProvider: string | null;
    transports: string[];
  }> = [];
  for (const [modelId, model] of uniqueModels) {
    const result = await new OpenRouterChatCompletionsRuntime(
      model.config,
    ).converse({
      ...common,
      structuredOutput: {
        mode: "json_schema",
        schemaName: "workbase_openrouter_preflight",
        schemaDescription: "OpenRouter JSON-schema capability result.",
        jsonSchema: capabilitySchema,
      },
    });
    assertCapabilityResult(`${modelId} JSON-schema preflight`, result);
    const toolResult = await new OpenRouterChatCompletionsRuntime(
      model.config,
    ).converse({
      ...common,
      structuredOutput: {
        mode: "strict_tool_use",
        schemaName: "workbase_openrouter_preflight_tool",
        schemaDescription: "OpenRouter strict-tool capability result.",
        jsonSchema: capabilitySchema,
      },
    });
    assertCapabilityResult(`${modelId} strict-tool preflight`, toolResult);
    const usage = result.tokenUsage &&
      typeof result.tokenUsage === "object" &&
      !Array.isArray(result.tokenUsage)
      ? result.tokenUsage
      : null;
    modelResults.push({
      configuredModelId: modelId,
      profiles: model.profiles,
      actualModelId: result.modelId,
      requestId: result.requestId,
      routedProvider:
        usage && typeof usage.routedProvider === "string"
          ? usage.routedProvider
          : null,
      transports: ["json_schema", "strict_tool_use"],
    });
  }

  const profiles = Object.fromEntries(
    profileConfigs.map(({ profile, config }) => [
      profile,
      {
        modelId: config.modelId,
        fallbackModelId: config.fallbackModelId ?? null,
      },
    ]),
  );
  console.info(
    JSON.stringify(
      {
        status: "ok",
        provider: "openrouter",
        privacy: {
          zeroDataRetention: true,
          requireParameters: true,
        },
        validatedModels: modelResults,
        profiles,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    `OpenRouter preflight failed. ${
      error instanceof Error ? error.message : "Unknown error"
    }`,
  );
  process.exit(1);
});
