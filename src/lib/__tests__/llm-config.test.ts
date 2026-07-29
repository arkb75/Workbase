import {
  DEFAULT_OPENROUTER_FALLBACK_MODEL_ID,
  DEFAULT_OPENROUTER_MODEL_ID,
  resolveOpenRouterConfig,
  resolveWorkbaseLlmProvider,
} from "@/src/lib/llm-config";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("OpenRouter model configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults every role to the primary model with quality-profile fallback", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const primary = resolveOpenRouterConfig("primary_answer");
    const drafting = resolveOpenRouterConfig("drafting");
    expect(primary).toMatchObject({
      modelId: DEFAULT_OPENROUTER_MODEL_ID,
      fallbackModelId: DEFAULT_OPENROUTER_FALLBACK_MODEL_ID,
      zeroDataRetention: true,
      requireParameters: true,
      sendTemperature: false,
    });
    expect(drafting).toMatchObject({
      modelId: DEFAULT_OPENROUTER_MODEL_ID,
      fallbackModelId: undefined,
    });
  });

  it("applies explicit per-role model overrides", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv(
      "WORKBASE_OPENROUTER_MODEL_CODE_EXTRACTION",
      "openai/gpt-5.4-mini",
    );
    expect(resolveOpenRouterConfig("code_extraction").modelId).toBe(
      "openai/gpt-5.4-mini",
    );
  });

  it("fails closed when OpenRouter credentials are absent", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => resolveOpenRouterConfig()).toThrow("OPENROUTER_API_KEY");
  });

  it("rejects unknown provider names instead of silently using Bedrock", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("WORKBASE_LLM_PROVIDER", "typo-provider");
    expect(() => resolveWorkbaseLlmProvider()).toThrow(
      "Unsupported WORKBASE_LLM_PROVIDER",
    );
  });
});
