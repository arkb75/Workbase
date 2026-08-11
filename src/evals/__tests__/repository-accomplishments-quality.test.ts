import { describe, expect, it } from "vitest";
import {
  buildRepositoryAccomplishmentsReport,
  buildRepositoryAccomplishmentsScenarioCatalog,
  parseRepositoryAccomplishmentsProfile,
  resolveExactRepositoryAccomplishmentsTarget,
} from "@/src/evals/repository-accomplishments-quality";
import { parseProjectChatApplicationCliOptions } from "@/src/evals/project-chat-application-cli";
import { evaluateProjectChatAnswerQuality } from "@/src/evals/project-chat-answer-quality";
import type {
  ProjectChatApplicationMetrics,
  ProjectChatApplicationScenarioResult,
} from "@/src/evals/project-chat-application-runner";

const sha = "a".repeat(40);

function profile(overrides: Record<string, unknown> = {}) {
  return parseRepositoryAccomplishmentsProfile({
    workItemTitle: "CircleFund",
    repository: "arkb75/CircleFund",
    requiredCapabilityPatterns: [
      "funding|contribution",
      "circle|member",
    ],
    ...overrides,
  });
}

const metrics: ProjectChatApplicationMetrics = {
  latencyMs: 1_250,
  modelCalls: 2,
  totalTokens: 2_500,
  estimatedCostUsd: 0.0125,
  usageComplete: true,
  modelAttribution: {
    providers: ["openrouter"],
    configuredModelIds: ["openai/gpt-5.6-terra"],
    actualModelIds: ["openai/gpt-5.6-terra"],
    routedProviders: ["openai"],
    requestIds: ["request-1"],
    failedModelIds: [],
    providerAttempts: 2,
    failedProviderAttempts: 0,
    fallbackUsed: false,
    authoritativeAttributionComplete: true,
    profiles: {},
  },
  repositoryTreeLookups: 0,
  repositorySearches: 0,
  repositoryFileReads: 0,
  repositoryVisibleBytes: 0,
};

function scenarioResult(
  staleCitationOrdinals: number[] = [],
): ProjectChatApplicationScenarioResult {
  const scenario = buildRepositoryAccomplishmentsScenarioCatalog(
    profile({ includeFreshnessFollowUp: false }),
  )[0]!;
  return {
    scenario,
    passed: true,
    checks: [
      { name: "answer develops its major points", passed: true, actual: 4, expected: 4 },
      {
        name: "answer grounds its major points with claim-local citations",
        passed: true,
        actual: 4,
        expected: 4,
      },
    ],
    observation: {
      scenarioId: scenario.id,
      runId: "run-1",
      threadId: "thread-1",
      workItemId: "work-item-circle",
      outcome: "answered",
      answer: [
        "### 1. Funding workflow",
        "Built a funding and contribution workflow that lets members coordinate durable pooled decisions. [citation:1]",
        "### 2. Circle membership",
        "Implemented circle and member lifecycle controls that preserve access boundaries. [citation:2]",
        "### 3. Ledger",
        "Designed a typed ledger that reconciles contribution state and keeps funding history auditable. [citation:3]",
        "### 4. Recovery",
        "Added recovery paths that allow circle operations to resume without duplicating a member action. [citation:4]",
      ].join("\n\n"),
      citationCount: 4,
      citationKinds: ["project_fact", "project_fact", "highlight", "highlight"],
      citationOrdinals: [1, 2, 3, 4],
      tools: [],
      repositoryCitationFreshness: {
        targetHeads: [{
          sourceId: "source-circle",
          repository: "arkb75/CircleFund",
          commitSha: sha,
        }],
        repositoryDerivedCitationCount: 4,
        currentRepositoryDerivedCitationCount:
          4 - staleCitationOrdinals.length,
        staleCitationOrdinals,
      },
      historyMessageCount: 0,
      historyCharacterCount: 0,
      historyCitationManifestCount: 0,
      rollingSummaryCharacterCount: 0,
      rollingSummaryPreservedOpeningDecision: false,
      rollingSummaryPreservedCitationManifest: false,
      historyPreservedCurrentRuntimeContext: false,
      candidate: null,
      artifact: null,
      coverageGaps: [],
      metrics,
      error: null,
    },
  };
}

describe("repository accomplishments quality harness", () => {
  it("maps short and long threshold flags into the same explicit profile fields", () => {
    const short = parseProjectChatApplicationCliOptions([
      "--provider", "openrouter",
      "--work-item-exact", "CircleFund",
      "--repository-exact=arkb75/CircleFund",
      "--required-capability-regex", "circle|membership|invite",
      "--required-capability-regex=contribution|lending|fund",
      "--min-primary-items", "3",
      "--max-primary-items=5",
      "--min-developed-items", "3",
      "--min-cited-items=3",
    ]);
    const long = parseProjectChatApplicationCliOptions([
      "--minimum-primary-items=3",
      "--maximum-primary-items", "5",
      "--minimum-developed-items=3",
      "--minimum-cited-items", "3",
    ]);

    expect(short).toMatchObject({
      provider: "openrouter",
      exactWorkItemTitle: "CircleFund",
      exactRepository: "arkb75/CircleFund",
      requiredCapabilityPatterns: [
        "circle|membership|invite",
        "contribution|lending|fund",
      ],
      minimumPrimaryItems: 3,
      maximumPrimaryItems: 5,
      minimumDevelopedItems: 3,
      minimumCitedItems: 3,
    });
    expect(long).toMatchObject({
      minimumPrimaryItems: 3,
      maximumPrimaryItems: 5,
      minimumDevelopedItems: 3,
      minimumCitedItems: 3,
    });

    const explicitProfile = parseRepositoryAccomplishmentsProfile({
      workItemTitle: short.exactWorkItemTitle,
      repository: short.exactRepository,
      requiredCapabilityPatterns: short.requiredCapabilityPatterns,
      minimumPrimaryItems: short.minimumPrimaryItems,
      maximumPrimaryItems: short.maximumPrimaryItems,
      minimumDevelopedItems: short.minimumDevelopedItems,
      minimumCitedItems: short.minimumCitedItems,
    });
    expect(explicitProfile).toMatchObject({
      minimumPrimaryItems: 3,
      maximumPrimaryItems: 5,
      minimumDevelopedItems: 3,
      minimumCitedItems: 3,
    });
    expect(buildRepositoryAccomplishmentsScenarioCatalog(explicitProfile)[0]
      ?.answerContract).toMatchObject({
        minPrimaryItems: 3,
        maxPrimaryItems: 5,
        minDevelopedItems: 3,
        minCitedItems: 3,
      });
  });

  it("rejects unknown, missing-value, and conflicting application-eval options", () => {
    expect(() => parseProjectChatApplicationCliOptions([
      "--min-prmary-items", "3",
    ])).toThrow("Unknown application evaluation option: --min-prmary-items");
    expect(() => parseProjectChatApplicationCliOptions([
      "--min-primary-items",
    ])).toThrow("--min-primary-items requires a value");
    expect(() => parseProjectChatApplicationCliOptions([
      "--minimum-primary-items", "4",
      "--min-primary-items", "3",
    ])).toThrow("conflicts with an already supplied value");
    expect(() => parseProjectChatApplicationCliOptions([
      "CircleFund",
    ])).toThrow("Unexpected positional argument");
  });

  it("normalizes a reusable profile and validates every capability regex", () => {
    expect(profile()).toMatchObject({
      includeFreshnessFollowUp: true,
      minimumPrimaryItems: 4,
      maximumPrimaryItems: 6,
      minimumDevelopedItems: 4,
      minimumCitedItems: 4,
    });
    expect(() => profile({ requiredCapabilityPatterns: ["["] })).toThrow(
      "not a valid regular expression",
    );
    expect(() => profile({ includeFreshnessFollowUp: "false" })).toThrow(
      "must be a boolean",
    );
    expect(() => profile({ minimumPrimayItems: 3 })).toThrow(
      "Unknown repository accomplishments profile field: minimumPrimayItems",
    );
  });

  it("keeps the mechanism-to-value rubric repository agnostic", () => {
    const circleProfile = profile({
      includeFreshnessFollowUp: false,
      minimumPrimaryItems: 3,
      maximumPrimaryItems: 5,
      minimumDevelopedItems: 3,
      minimumCitedItems: 3,
    });
    const contract = buildRepositoryAccomplishmentsScenarioCatalog(
      circleProfile,
    )[0]!.answerContract!;
    const answer = `### 1. Coordinated contribution rounds
Built a circle contribution workflow by recording each member payment atomically and enforcing the active turn, which prevents duplicate disbursements and keeps a shared fund auditable. [citation:1]

### 2. Safe membership onboarding
Created invite-based membership using expiring tokens and server-side authorization checks, which lets a circle admit intended members without exposing private lending activity. [citation:2]

### 3. Recoverable lending operations
Designed fund recovery through idempotent lending commands and a durable operation ledger, which allows interrupted circle activity to resume without applying a contribution twice. [citation:3]`;
    const checks = evaluateProjectChatAnswerQuality({ answer, contract });

    expect(checks.find((check) =>
      check.name === "answer connects implementation mechanisms to their value"
    )).toMatchObject({ passed: true, actual: 3, expected: 3 });
    expect(checks.filter((check) => !check.passed)).toEqual([]);
  });

  it("selects one exact title/repository/current-head tuple with no fallback", () => {
    const exactProfile = profile();
    const candidates = [{
      id: "work-item-circle",
      title: "CircleFund",
      sources: [{
        id: "source-circle",
        type: "github_repo",
        metadata: {
          repository: { fullName: "arkb75/CircleFund" },
          revision: { commitSha: sha },
        },
        evidenceItemCount: 77,
      }],
    }, {
      id: "work-item-wrong-case",
      title: "circlefund",
      sources: [{
        id: "source-wrong-case",
        type: "github_repo",
        metadata: {
          repository: { fullName: "arkb75/CircleFund" },
          revision: { commitSha: sha },
        },
      }],
    }];

    expect(resolveExactRepositoryAccomplishmentsTarget({
      profile: exactProfile,
      candidates,
    })).toEqual({
      workItemId: "work-item-circle",
      workItemTitle: "CircleFund",
      sourceId: "source-circle",
      repository: "arkb75/CircleFund",
      commitSha: sha,
      evidenceItemCount: 77,
    });
    expect(() => resolveExactRepositoryAccomplishmentsTarget({
      profile: profile({ workItemTitle: "circlefund" }),
      candidates: candidates.slice(0, 1),
    })).toThrow("No fallback was attempted");
    expect(() => resolveExactRepositoryAccomplishmentsTarget({
      profile: profile({ repository: "arkb75/circlefund" }),
      candidates: candidates.slice(0, 1),
    })).toThrow("No fallback was attempted");
  });

  it("builds only the literal accomplishments prompt and optional exact follow-up", () => {
    const scenarios = buildRepositoryAccomplishmentsScenarioCatalog(profile());
    expect(scenarios.map((scenario) => scenario.question)).toEqual([
      "Summarize my strongest accomplishments",
      "make sure your understanding is up to date",
    ]);
    expect(scenarios[0]?.answerContract).toMatchObject({
      minReaderThemes: 0,
      minPrimaryItems: 4,
      maxPrimaryItems: 6,
      minDevelopedItems: 4,
      requiredPatterns: ["funding|contribution", "circle|member"],
    });
    expect(buildRepositoryAccomplishmentsScenarioCatalog(
      profile({ includeFreshnessFollowUp: false }),
    )).toHaveLength(1);
  });

  it("emits comparison-ready attribution, performance, capability, and current-head results", () => {
    const exactProfile = profile({ includeFreshnessFollowUp: false });
    const result = scenarioResult();
    const report = buildRepositoryAccomplishmentsReport({
      provider: "openrouter",
      gitCommit: "c".repeat(40),
      profile: exactProfile,
      target: {
        workItemId: "work-item-circle",
        workItemTitle: "CircleFund",
        sourceId: "source-circle",
        repository: "arkb75/CircleFund",
        commitSha: sha,
        evidenceItemCount: 77,
      },
      suite: {
        passed: true,
        results: [result],
        aggregate: metrics,
      },
      keepEvaluationData: false,
    });

    expect(report).toMatchObject({
      schemaVersion: "workbase-repository-accomplishments-report-v1",
      passed: true,
      provider: "openrouter",
      target: { repository: "arkb75/CircleFund", commitSha: sha },
      retention: { workItemRetained: true, evaluationDataRetained: false },
      performance: {
        latencyMs: 1_250,
        totalTokens: 2_500,
        estimatedCostUsd: 0.0125,
      },
      attribution: {
        actualModelIds: ["openai/gpt-5.6-terra"],
        authoritativeAttributionComplete: true,
      },
      scenarios: [{
        passed: true,
        quality: {
          primaryItemCount: 4,
          requiredCapabilityRecall: 1,
          repositoryCitationFreshness: {
            repositoryDerivedCitationCount: 4,
            currentRepositoryDerivedCitationCount: 4,
          },
        },
      }],
    });
    expect(report.comparisonKey).toMatch(
      /^arkb75\/circlefund@[a-f0-9]{40}:[a-f0-9]{16}$/u,
    );

    const staleReport = buildRepositoryAccomplishmentsReport({
      provider: "openrouter",
      gitCommit: "c".repeat(40),
      profile: exactProfile,
      target: report.target,
      suite: {
        passed: true,
        results: [scenarioResult([3])],
        aggregate: metrics,
      },
      keepEvaluationData: false,
    });
    expect(staleReport.passed).toBe(false);
    expect(staleReport.scenarios[0]?.quality.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "every repository-derived citation was current",
          passed: false,
        }),
      ]),
    );
  });
});
