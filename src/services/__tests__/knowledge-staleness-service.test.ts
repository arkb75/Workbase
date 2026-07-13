import { describe, expect, it } from "vitest";
import {
  currentImmutableProvenanceHeads,
  currentObservations,
} from "@/src/services/knowledge-staleness-service";
import { REPOSITORY_KNOWLEDGE_ANALYZER_VERSION } from "@/src/services/repository-knowledge-sync-service";

describe("knowledge staleness observations", () => {
  it("keeps per-finding capability ownership isolated in multipurpose files", () => {
    const observations = currentObservations({
      id: "refresh-1",
      snapshots: [{
        sourceId: "source-1",
        commitSha: "a".repeat(40),
        files: [{
          path: "src/services/multi-purpose.ts",
          semanticRefreshRunId: "refresh-1",
          semanticAnalyzerVersion: REPOSITORY_KNOWLEDGE_ANALYZER_VERSION,
          semanticStatus: "succeeded",
          semanticAnalysis: {
            path: "src/services/multi-purpose.ts",
            summary: "Multipurpose implementation.",
            subsystemKeys: ["ai_runtime", "domain_data"],
            responsibilities: [],
            symbols: [],
            dependencies: [],
            architectureSignals: [],
            userFacingCapabilities: [],
            unresolvedQuestions: [],
            chunksAnalyzed: 1,
            tokenUsage: [],
            facts: [
              {
                path: "src/services/multi-purpose.ts",
                statement: "Invokes Bedrock Converse with structured tools.",
                category: "behavior",
                confidence: "high",
                sensitivityFlag: false,
                lineStart: 1,
                lineEnd: 3,
                productImportance: 4,
                implementationBreadth: 3,
                technicalDifficulty: 4,
                subsystemKeys: ["ai_runtime"],
              },
              {
                path: "src/services/multi-purpose.ts",
                statement: "Persists normalized project records.",
                category: "data_flow",
                confidence: "high",
                sensitivityFlag: false,
                lineStart: 5,
                lineEnd: 8,
                productImportance: 3,
                implementationBreadth: 2,
                technicalDifficulty: 3,
                subsystemKeys: ["domain_data"],
              },
            ],
          },
        }],
      }],
    } as never);

    expect(observations).toEqual([
      expect.objectContaining({ statement: "Invokes Bedrock Converse with structured tools.", subsystemKeys: ["ai_runtime"] }),
      expect.objectContaining({ statement: "Persists normalized project records.", subsystemKeys: ["domain_data"] }),
    ]);
  });

  it("only accepts current-head immutable file excerpts as validation provenance", () => {
    const heads = currentImmutableProvenanceHeads([
      {
        evidenceItem: {
          sourceId: "source-1",
          type: "github_file_excerpt",
          lifecycleStatus: "active",
          metadata: {
            commitSha: "current-sha",
            blobSha: "blob-1",
            path: "src/service.ts",
            startLine: 10,
            endLine: 20,
            excerptHash: "excerpt-hash",
          },
        },
      },
      {
        evidenceItem: {
          sourceId: "source-2",
          type: "github_file_excerpt",
          lifecycleStatus: "active",
          metadata: {
            commitSha: "old-sha",
            blobSha: "blob-2",
            path: "src/old.ts",
            startLine: 1,
            endLine: 3,
            excerptHash: "old-hash",
          },
        },
      },
      {
        evidenceItem: {
          sourceId: "source-3",
          type: "github_commit",
          lifecycleStatus: "active",
          metadata: { commitSha: "current-3" },
        },
      },
    ], new Map([
      ["source-1", "current-sha"],
      ["source-2", "current-sha-2"],
      ["source-3", "current-3"],
    ]));

    expect(Object.fromEntries(heads)).toEqual({ "source-1": "current-sha" });
  });
});
