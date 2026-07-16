import { describe, expect, it } from "vitest";
import {
  contentAddressedProvenance,
  currentImmutableProvenanceHeads,
  currentObservations,
  currentRepositoryFiles,
  isStrongCanonicalReplacement,
  refreshSupportsDestructiveStaleness,
  validateAssertion,
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

  it("advances old or stale immutable evidence through a new head when source, path, and blob are unchanged", () => {
    const currentFiles = currentRepositoryFiles([{
      id: "snapshot-new",
      sourceId: "source-1",
      commitSha: "head-new",
      files: [{ path: "src/service.ts", blobSha: "blob-unchanged" }],
    }]);
    const provenance = contentAddressedProvenance({
      evidence: [{
        evidenceItem: {
          id: "evidence-old",
          sourceId: "source-1",
          type: "github_file_excerpt",
          lifecycleStatus: "stale",
          metadata: {
            commitSha: "head-old",
            blobSha: "blob-unchanged",
            path: "src/service.ts",
            startLine: 10,
            endLine: 20,
            excerptHash: "excerpt-hash",
          },
        },
      }],
      currentFiles,
    });

    expect(provenance.allCurrent).toBe(true);
    expect(Object.fromEntries(provenance.heads)).toEqual({ "source-1": "head-new" });
    expect(provenance.matches[0]?.current).toMatchObject({
      snapshotId: "snapshot-new",
      blobSha: "blob-unchanged",
      path: "src/service.ts",
    });
  });

  it("does not content-address revalidate a changed or removed path", () => {
    const currentFiles = currentRepositoryFiles([{
      id: "snapshot-new",
      sourceId: "source-1",
      commitSha: "head-new",
      files: [
        { path: "src/changed.ts", blobSha: "blob-new" },
        { path: "src/renamed.ts", blobSha: "blob-old" },
      ],
    }]);
    const evidence = (path: string) => ({
      evidenceItem: {
        sourceId: "source-1",
        type: "github_file_excerpt",
        lifecycleStatus: "active",
        metadata: {
          commitSha: "head-old",
          blobSha: "blob-old",
          path,
          startLine: 1,
          endLine: 2,
          excerptHash: "excerpt-hash",
        },
      },
    });

    expect(contentAddressedProvenance({ evidence: [evidence("src/changed.ts")], currentFiles }).allCurrent).toBe(false);
    expect(contentAddressedProvenance({ evidence: [evidence("src/removed.ts")], currentFiles }).allCurrent).toBe(false);
    // Renames are intentionally not treated as unchanged path provenance.
    expect(contentAddressedProvenance({ evidence: [evidence("src/original.ts")], currentFiles }).allCurrent).toBe(false);
  });

  it("permits destructive transitions only after a verified complete refresh barrier", () => {
    const complete = {
      qualityStatus: "verified",
      coverage: [{
        coverageStatus: "complete",
        semanticCoverageStatus: "complete",
        capabilityCoverageStatus: "verified",
        coverageGaps: [],
      }],
      snapshots: [{ inventoryComplete: true, analysisComplete: true, coverageComplete: true }],
    };
    expect(refreshSupportsDestructiveStaleness(complete)).toBe(true);
    expect(refreshSupportsDestructiveStaleness({ ...complete, qualityStatus: "degraded" })).toBe(false);
    expect(refreshSupportsDestructiveStaleness({
      ...complete,
      coverage: [{ ...complete.coverage[0], coverageGaps: ["One semantic package failed."] }],
    })).toBe(false);
    expect(refreshSupportsDestructiveStaleness({
      ...complete,
      snapshots: [{ inventoryComplete: true, analysisComplete: true, coverageComplete: false }],
    })).toBe(false);
  });

  it("does not treat unrelated knowledge in the same subsystem as a canonical replacement", () => {
    expect(isStrongCanonicalReplacement({
      priorId: "fact-inventory",
      priorText: "The refresh inventories every safe repository path at an immutable commit.",
      priorSubsystemKey: "repository_knowledge_lifecycle",
      candidateText: "Parallel semantic workers inspect bounded capability packages and report coverage gaps.",
      candidateSubsystemKey: "repository_knowledge_lifecycle",
      candidateSupersedesId: null,
    })).toBe(false);

    expect(isStrongCanonicalReplacement({
      priorId: "fact-inventory",
      priorText: "The refresh inventories safe repository files at an immutable commit.",
      priorSubsystemKey: "repository_knowledge_lifecycle",
      candidateText: "The repository refresh inventories safe repository files at an immutable commit.",
      candidateSubsystemKey: "repository_knowledge_lifecycle",
      candidateSupersedesId: null,
    })).toBe(true);

    expect(isStrongCanonicalReplacement({
      priorId: "fact-inventory",
      priorText: "Old wording.",
      priorSubsystemKey: "repository_knowledge_lifecycle",
      candidateText: "Completely revised wording.",
      candidateSubsystemKey: "project_chat_grounding",
      candidateSupersedesId: "fact-inventory",
    })).toBe(true);
  });

  it("does not revalidate a modal implementation claim from stale documentation alone", async () => {
    const assertion = "Every generated Project Fact requires mandatory human approval before it can be used.";
    const documentationOnly = await validateAssertion({
      assertion,
      priorReferences: ["source-1:README.md"],
      currentReferences: new Set(["source-1:README.md"]),
      observations: [{
        statement: assertion,
        path: "README.md",
        subsystemKeys: ["knowledge_review_lifecycle"],
        commitSha: "a".repeat(40),
        sourceId: "source-1",
      }],
    });

    expect(documentationOnly).toMatchObject({
      verdict: "unknown",
      reason: expect.stringContaining("documentation alone cannot revalidate"),
    });

    const executableEvidence = await validateAssertion({
      assertion,
      priorReferences: ["source-1:README.md"],
      currentReferences: new Set(["source-1:README.md"]),
      observations: [{
        statement: assertion,
        path: "src/services/knowledge-review-service.ts",
        subsystemKeys: ["knowledge_review_lifecycle"],
        commitSha: "a".repeat(40),
        sourceId: "source-1",
      }],
    });

    expect(executableEvidence.verdict).toBe("supported");
  });

  it("does not revalidate an absolute claim from executable evidence that omits its qualifier", async () => {
    const result = await validateAssertion({
      assertion: "Artifacts are only generated from approved Highlights.",
      priorReferences: ["source-1:src/services/artifact-workflow-service.ts"],
      currentReferences: new Set(["source-1:src/services/artifact-workflow-service.ts"]),
      observations: [{
        statement: "The artifact workflow retrieves approved Highlights before generation.",
        path: "src/services/artifact-workflow-service.ts",
        subsystemKeys: ["artifact_generation"],
        commitSha: "a".repeat(40),
        sourceId: "source-1",
      }],
    });

    expect(result).toMatchObject({
      verdict: "unknown",
      reason: expect.stringContaining("modal implementation assertion"),
    });
  });

  it("allows retirement when every prior path is absent from a complete current manifest", async () => {
    const result = await validateAssertion({
      assertion: "The removed worker coordinates legacy imports.",
      priorReferences: ["source-1:src/legacy-worker.ts"],
      currentReferences: new Set(["source-1:src/current-worker.ts"]),
      observations: [],
    });

    expect(result).toMatchObject({
      verdict: "removed",
      reason: expect.stringContaining("absent from the complete current snapshot"),
    });
  });
});
