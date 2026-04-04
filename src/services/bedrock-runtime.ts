import { BedrockStructuredLlmClient } from "@/src/lib/bedrock-structured-llm-client";
import { resolveBedrockConfig } from "@/src/lib/llm-config";

let cachedClient: BedrockStructuredLlmClient | null = null;

export function getBedrockStructuredLlmClient() {
  if (!cachedClient) {
    cachedClient = BedrockStructuredLlmClient.fromConfig(resolveBedrockConfig());
  }

  return cachedClient;
}
