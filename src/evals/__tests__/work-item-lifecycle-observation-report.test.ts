import { describe, expect, it } from "vitest";
import {
  appendLifecycleObservationToReport,
  normalizeLifecycleGenerationRun,
  removeLifecycleObservationFromReport,
} from "@/tests/e2e/work-item-lifecycle-observation-report.mjs";

const SCHEMA_VERSION = "workbase-work-item-lifecycle-release-gate-v3";
const GIT_COMMIT = "a".repeat(40);

function observation(scenarioId: string, workItemId: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId,
    currentLineage: { workItemId },
  };
}

describe("live lifecycle observation report persistence", () => {
  it("normalizes a direct provider audit row from its durable token usage", () => {
    const normalized = normalizeLifecycleGenerationRun({
      id: "generation-provider",
      kind: "highlight_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      inputSummary: { phase: "highlight_generation" },
      resultRefs: {
        agentRunId: "agent-run",
        profile: "drafting",
        configuredModelId: "openai/gpt-5.6-luna",
        auditAttemptCount: 1,
        unknownUsageAttempts: 0,
        usageComplete: true,
      },
      tokenUsage: {
        cost: 0.0013694,
        modelId: "openai/gpt-5.6-luna",
        provider: "openrouter",
        requestId: "gen-provider-1",
        inputTokens: 1475,
        outputTokens: 834,
        totalTokens: 2309,
        providerAttemptCount: 1,
      },
      estimatedCostUsd: 0.0013694,
    }, { provider: "openrouter" });

    expect(normalized).toMatchObject({
      role: "provider_call",
      configuredProvider: "openrouter",
      requestIds: ["gen-provider-1"],
      tokenUsagePresent: true,
      estimatedCostUsd: 0.0013694,
      usageComplete: true,
      auditAttemptCount: 1,
      providerAttemptCount: 1,
      failedProviderAttempts: 0,
      unknownUsageAttempts: 0,
      auditEvidenceTruncated: false,
      authoritativeGenerationRunId: null,
      providerBatchGenerationRunIds: [],
    });
  });

  it("keeps a deterministic verification aggregate distinct from provider calls", () => {
    const normalized = normalizeLifecycleGenerationRun({
      id: "generation-aggregate",
      kind: "highlight_verification",
      status: "success",
      provider: "deterministic",
      modelId: "highlight-verification-aggregate-v1",
      inputSummary: {
        transportAttempts: [{ requestId: "gen-provider-1" }],
      },
      resultRefs: {
        aggregate: true,
        agentRunId: "agent-run",
        profile: "verification",
        configuredProvider: "openrouter",
        configuredModelId: "openai/gpt-5.6-luna",
        providerBatchGenerationRunIds: ["generation-provider-1", "generation-provider-2"],
        auditAttemptCount: 0,
        unknownUsageAttempts: 0,
        usageComplete: true,
      },
      tokenUsage: null,
      estimatedCostUsd: null,
    }, { provider: "openrouter" });

    expect(normalized).toMatchObject({
      role: "verification_aggregate",
      provider: "deterministic",
      configuredProvider: "openrouter",
      tokenUsage: null,
      tokenUsagePresent: false,
      estimatedCostUsd: null,
      auditAttemptCount: 0,
      providerAttemptCount: 0,
      failedProviderAttempts: 0,
      unknownUsageAttempts: 0,
      auditEvidenceTruncated: false,
      providerBatchGenerationRunIds: [
        "generation-provider-1",
        "generation-provider-2",
      ],
    });
  });

  it("does not infer complete audit evidence from an unpriced provider row", () => {
    const normalized = normalizeLifecycleGenerationRun({
      id: "generation-incomplete",
      kind: "highlight_generation",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      inputSummary: {},
      resultRefs: {
        profile: "drafting",
        configuredModelId: "openai/gpt-5.6-luna",
        auditAttemptCount: 1,
        unknownUsageAttempts: 0,
        usageComplete: false,
      },
      tokenUsage: {
        requestId: "gen-incomplete-1",
        providerAttemptCount: 1,
        unknownUsageAttempts: 1,
      },
      estimatedCostUsd: null,
    }, { provider: "openrouter" });

    expect(normalized).toMatchObject({
      role: "provider_call",
      providerAttemptCount: 1,
      unknownUsageAttempts: 1,
      estimatedCostUsd: null,
      usageComplete: false,
      auditEvidenceTruncated: null,
    });
  });

  it("does not hide failed or truncated evidence behind optimistic result refs", () => {
    const normalized = normalizeLifecycleGenerationRun({
      id: "generation-conflicting-audit",
      kind: "highlight_verification",
      status: "success",
      provider: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      inputSummary: {},
      resultRefs: {
        profile: "verification",
        configuredModelId: "openai/gpt-5.6-luna",
        auditAttemptCount: 2,
        failedProviderAttempts: 0,
        unknownUsageAttempts: 0,
        auditEvidenceTruncated: false,
        usageComplete: true,
      },
      tokenUsage: {
        attempts: [{
          cost: 0.001,
          requestId: "gen-success-1",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        }],
        failedAttempts: [{ requestId: "gen-failed-1" }],
        providerAttemptCount: 2,
        unknownUsageAttempts: 0,
        auditEvidenceTruncated: true,
      },
      estimatedCostUsd: 0.001,
    }, { provider: "openrouter" });

    expect(normalized).toMatchObject({
      failedProviderAttempts: 1,
      auditEvidenceTruncated: true,
    });
  });

  it("preserves prior observations when a Playwright worker restarts", () => {
    const first = appendLifecycleObservationToReport({
      priorReport: undefined,
      schemaVersion: SCHEMA_VERSION,
      gitCommit: GIT_COMMIT,
      baseUrl: "http://127.0.0.1:3100",
      observation: observation("manual_only_create", "work-item-1"),
    });

    // A restarted worker has no module-local observation array. Its only
    // durable state is the report parsed from disk.
    const afterRestart = appendLifecycleObservationToReport({
      priorReport: JSON.parse(JSON.stringify(first)),
      schemaVersion: SCHEMA_VERSION,
      gitCommit: GIT_COMMIT,
      baseUrl: "http://127.0.0.1:3100",
      observation: observation("empty_create_attach", "work-item-2"),
    });

    expect(afterRestart).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      gitCommit: GIT_COMMIT,
      live: true,
      baseUrl: "http://127.0.0.1:3100",
    });
    expect(afterRestart.observations).toEqual([
      observation("manual_only_create", "work-item-1"),
      observation("empty_create_attach", "work-item-2"),
    ]);
  });

  it("removes only the temporary completed lineage observation", () => {
    const priorReport = {
      schemaVersion: SCHEMA_VERSION,
      gitCommit: GIT_COMMIT,
      live: true,
      baseUrl: "http://127.0.0.1:3100",
      runLabel: "retained diagnostic",
      observations: [
        observation("manual_only_create", "work-item-1"),
        observation("empty_create_attach", "temporary-work-item"),
      ],
    };

    expect(removeLifecycleObservationFromReport({
      priorReport,
      workItemId: "temporary-work-item",
    })).toEqual({
      ...priorReport,
      observations: [observation("manual_only_create", "work-item-1")],
    });
  });

  it("refuses to mix observations from different application commits", () => {
    expect(() => appendLifecycleObservationToReport({
      priorReport: { gitCommit: GIT_COMMIT, observations: [] },
      schemaVersion: SCHEMA_VERSION,
      gitCommit: "b".repeat(40),
      baseUrl: "http://127.0.0.1:3100",
      observation: observation("empty_create_attach", "work-item-2"),
    })).toThrow(/commit changed/iu);
  });
});
