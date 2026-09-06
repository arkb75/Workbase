import {
  DEFAULT_OPENROUTER_FALLBACK_MODEL_ID,
  DEFAULT_OPENROUTER_MODEL_ID,
  resolveOpenRouterConfig,
  resolveWorkbaseLlmProvider,
} from "@/src/lib/llm-config";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("OpenRouter model configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps cross-family fallback out of specialized repository profiles", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const primary = resolveOpenRouterConfig("primary_answer");
    const synthesis = resolveOpenRouterConfig("deep_synthesis");
    const verification = resolveOpenRouterConfig("verification");
    const drafting = resolveOpenRouterConfig("drafting");
    expect(primary).toMatchObject({
      modelId: DEFAULT_OPENROUTER_MODEL_ID,
      fallbackModelId: DEFAULT_OPENROUTER_FALLBACK_MODEL_ID,
      zeroDataRetention: true,
      requireParameters: true,
      sendTemperature: false,
    });
    expect(verification.fallbackModelId).toBeUndefined();
    expect(synthesis.fallbackModelId).toBeUndefined();
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

  it("does not serialize healthy requests unless a deployment opts in", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("WORKBASE_OPENROUTER_MIN_REQUEST_INTERVAL_MS", "");
    expect(resolveOpenRouterConfig("routing").minRequestIntervalMs).toBe(0);

    vi.stubEnv("WORKBASE_OPENROUTER_MIN_REQUEST_INTERVAL_MS", "750");
    expect(resolveOpenRouterConfig("routing").minRequestIntervalMs).toBe(750);
  });

  it("scopes endpoint preferences to a profile without changing models or privacy", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("WORKBASE_OPENROUTER_PROVIDER_ORDER", "azure");
    vi.stubEnv("WORKBASE_OPENROUTER_PROVIDER_ORDER_VERIFICATION", " azure/eu, azure ");
    const verification = resolveOpenRouterConfig("verification");
    expect(verification).toMatchObject({
      providerOrder: ["azure/eu", "azure"],
      zeroDataRetention: true,
      requireParameters: true,
    });
    expect(verification.fallbackModelId).toBeUndefined();
    expect(resolveOpenRouterConfig("primary_answer").providerOrder).toEqual(["azure"]);
    vi.stubEnv("WORKBASE_OPENROUTER_PROVIDER_ORDER_VERIFICATION", " ");
    expect(resolveOpenRouterConfig("verification").providerOrder).toEqual(["azure"]);
    vi.stubEnv("WORKBASE_OPENROUTER_PROVIDER_ORDER", "");
    expect(resolveOpenRouterConfig("verification").providerOrder).toEqual([]);
  });

  it("uses the shared OpenRouter application URL for attribution headers", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv(
      "WORKBASE_OPENROUTER_APP_URL",
      "https://workbase.example/openrouter",
    );
    vi.stubEnv("WORKBASE_PUBLIC_URL", "https://workbase.example");
    expect(resolveOpenRouterConfig("primary_answer").siteUrl).toBe(
      "https://workbase.example/openrouter",
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
