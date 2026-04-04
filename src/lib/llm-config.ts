export type WorkbaseLlmProvider = "bedrock" | "mock";

export function resolveWorkbaseLlmProvider(): WorkbaseLlmProvider {
  if (process.env.WORKBASE_LLM_PROVIDER === "mock") {
    return "mock";
  }

  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
    return "mock";
  }

  return "bedrock";
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
