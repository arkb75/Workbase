import { describe, expect, it } from "vitest";
import {
  selectGlobalRepositoryHighlights,
  type SynthesizedKnowledge,
  type SynthesisNotebookEntry,
} from "@/src/services/repository-knowledge-synthesis-service";

function notebook(path: string, blobSha = `blob:${path}`): SynthesisNotebookEntry {
  return {
    sourceId: "source-1",
    repository: "example/project",
    commitSha: "a".repeat(40),
    blobSha,
    path,
    lineStart: 1,
    lineEnd: 20,
    statement: `${path} supports the cited implementation.`,
    category: "architecture",
    confidence: "high",
    sensitivityFlag: false,
    productImportance: 4,
    implementationBreadth: 4,
    technicalDifficulty: 4,
    changeType: "unchanged",
    semanticStatus: "succeeded",
    evidenceMode: "semantic",
  };
}

function knowledge(input: {
  subsystemKey: string;
  path: string;
  text: string;
  summary?: string;
  blobSha?: string;
}): SynthesizedKnowledge {
  return {
    subsystemKey: input.subsystemKey,
    facts: [],
    highlights: [{
      text: input.text,
      summary: input.summary ?? input.text,
      confidence: "high",
      sensitivityFlag: false,
      visibility: "private",
      citationIndexes: [1],
      productImportance: 4,
      implementationBreadth: 4,
      technicalDifficulty: 4,
      distinctiveness: 4,
    }],
    unresolvedQuestions: [],
    coverageGaps: [],
    notebook: [notebook(input.path, input.blobSha)],
    tokenUsage: null,
    approvalEligible: true,
  };
}

describe("global repository Highlight selection", () => {
  it("does not let a weak first subsystem candidate crowd out a stronger second candidate", () => {
    const domain = knowledge({
      subsystemKey: "project_domain:orders",
      path: "src/orders/format-label.ts",
      text: "Order label formatting helper",
    });
    domain.highlights[0] = {
      ...domain.highlights[0]!,
      productImportance: 1,
      implementationBreadth: 1,
      technicalDifficulty: 1,
      distinctiveness: 1,
    };
    domain.notebook.push(notebook("src/orders/fulfillment-workflow.ts"));
    domain.highlights.push({
      text: "Transactional order fulfillment with inventory reservation",
      summary: "Reserves inventory and commits fulfillment state through the implemented workflow.",
      confidence: "high",
      sensitivityFlag: false,
      visibility: "private",
      citationIndexes: [2],
      productImportance: 5,
      implementationBreadth: 5,
      technicalDifficulty: 4,
      distinctiveness: 4,
    });
    const other = knowledge({
      subsystemKey: "project_domain:telemetry",
      path: "src/telemetry/counter.ts",
      text: "Request counter telemetry",
    });
    other.highlights[0] = {
      ...other.highlights[0]!,
      productImportance: 2,
      implementationBreadth: 1,
      technicalDifficulty: 1,
      distinctiveness: 1,
    };

    const selected = selectGlobalRepositoryHighlights([domain, other], 1);

    expect(selected[0]?.highlights.map((highlight) => highlight.text)).toEqual([
      "Transactional order fulfillment with inventory reservation",
    ]);
    expect(selected[1]?.highlights).toEqual([]);
  });

  it("deduplicates across domains while preserving a different implementation", () => {
    const selected = selectGlobalRepositoryHighlights([
      knowledge({
        subsystemKey: "project_domain:feed",
        path: "scripts/train-feed-model.ts",
        blobSha: "shared-training-blob",
        text: "Feed model training and artifact persistence",
        summary: "Trains the feed ranking model and persists the resulting model artifact.",
      }),
      knowledge({
        subsystemKey: "repository_area:intelligence",
        path: "scripts/train-feed-model.ts",
        blobSha: "shared-training-blob",
        text: "Persisted feed-ranking model training artifacts",
        summary: "The feed model training pipeline persists its ranking artifact for later loading.",
      }),
      knowledge({
        subsystemKey: "project_domain:messaging",
        path: "src/features/messaging/thread-service.ts",
        text: "Conversation delivery with durable participant authorization",
      }),
    ]);

    expect(selected.flatMap((area) => area.highlights)).toHaveLength(2);
    expect(selected[0]?.highlights).toHaveLength(1);
    expect(selected[1]?.highlights).toHaveLength(0);
    expect(selected[2]?.highlights).toHaveLength(1);
  });

  it("never promotes roadmap or README-only claims as shipped Highlights", () => {
    const mixedRoadmapClaim = knowledge({
      subsystemKey: "project_domain:history",
      path: "src/features/history/history-service.ts",
      text: "Cached user history and visualization workflow",
    });
    mixedRoadmapClaim.notebook = [
      {
        ...notebook("README.md", "readme-roadmap"),
        statement: "Future work includes caching, user history, and broader visualization.",
      },
      ...mixedRoadmapClaim.notebook,
    ];
    mixedRoadmapClaim.highlights[0]!.citationIndexes = [1, 2];
    const selected = selectGlobalRepositoryHighlights([
      knowledge({
        subsystemKey: "repository_area:product_surface",
        path: "README.md",
        text: "Loan review and repayment workflow",
        summary: "The roadmap describes future loan review and repayment models.",
      }),
      knowledge({
        subsystemKey: "project_domain:contributions",
        path: "src/features/contributions/contribution-service.ts",
        text: "Circle contribution recording and balance updates",
      }),
      mixedRoadmapClaim,
    ]);

    expect(selected[0]?.highlights).toEqual([]);
    expect(selected[1]?.highlights).toHaveLength(1);
    expect(selected[2]?.highlights).toEqual([]);
  });

  it("admits narrowly worded runnable examples while rejecting non-implementation artifacts", () => {
    const selected = selectGlobalRepositoryHighlights([
      knowledge({
        subsystemKey: "project_domain:quickstart",
        path: "examples/quickstart/server.ts",
        text: "Runnable quickstart server with signed webhook validation",
      }),
      knowledge({
        subsystemKey: "project_domain:export",
        path: "poc/export/index.js",
        text: "Proof-of-concept document export through a renderer client",
      }),
      knowledge({
        subsystemKey: "repository_area:configuration",
        path: "examples/config/request.json",
        text: "Example request configuration for batch processing",
      }),
      knowledge({
        subsystemKey: "project_domain:fixture",
        path: "fixtures/server.ts",
        text: "Fixture server for simulated message delivery",
      }),
      knowledge({
        subsystemKey: "repository_area:quality",
        path: "tests/server.test.ts",
        text: "Automated server delivery verification suite",
      }),
    ]);

    expect(selected.map((entry) => entry.highlights.length)).toEqual([1, 1, 0, 0, 0]);
  });
});
