import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkItem: vi.fn(),
  findPolicyFacts: vi.fn(),
  queryRaw: vi.fn(),
  ensureHighlightEmbeddings: vi.fn(),
  ensureProjectKnowledgeEmbeddings: vi.fn(),
  findNearestProjectKnowledge: vi.fn(),
  syncWorkItemDescriptionEvidence: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    workItem: { findFirstOrThrow: mocks.findWorkItem },
    projectFact: { findMany: mocks.findPolicyFacts },
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@/src/services/highlight-embedding-service", () => ({
  buildHighlightEmbeddingText: vi.fn(() => "embedding input"),
  ensureHighlightEmbeddings: mocks.ensureHighlightEmbeddings,
}));

vi.mock("@/src/services/knowledge-embedding-service", () => ({
  ensureProjectKnowledgeEmbeddings: mocks.ensureProjectKnowledgeEmbeddings,
  findNearestProjectKnowledge: mocks.findNearestProjectKnowledge,
}));

vi.mock("@/src/lib/evidence-persistence", () => ({
  syncWorkItemDescriptionEvidenceForWorkItem: mocks.syncWorkItemDescriptionEvidence,
}));

import { projectKnowledgeRetrievalService } from "@/src/services/project-knowledge-retrieval-service";
import {
  buildMemoryCatalog,
  rankAccomplishmentHits,
} from "@/src/services/project-chat-agent-service";

const commitSha = "a".repeat(40);
const now = new Date("2026-07-12T20:00:00.000Z");

function approvedHighlight() {
  return {
    id: "highlight-1",
    workItemId: "work-item-1",
    text: "Designed the grounded project-chat system",
    summary: "The system combines reviewed memory, citations, and repository research.",
    searchText: "grounded project chat citations repository research",
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    visibility: "resume_safe",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: "Reviewed against repository evidence.",
    metadata: {
      subsystemKey: "project_chat_grounding",
      scores: {
        productImportance: 5,
        implementationBreadth: 4,
        technicalDifficulty: 5,
        distinctiveness: 4,
      },
    },
    lifecycleStatus: "active",
    publicSafetyStatus: "verified",
    validatedThroughSha: commitSha,
    createdAt: now,
    updatedAt: now,
    tags: [],
    evidence: [{
      evidenceItemId: "evidence-1",
      evidenceItem: {
        id: "evidence-1",
        sourceId: "source-1",
        included: true,
        type: "github_file_excerpt",
        title: "src/services/project-chat-agent-service.ts",
        content: "The chat service builds a citation-backed memory catalog.",
        searchText: "chat citation memory",
        metadata: {
          repository: "arkb75/Workbase",
          commitSha,
          blobSha: "b".repeat(40),
          path: "src/services/project-chat-agent-service.ts",
          startLine: 130,
          endLine: 210,
          excerptHash: "c".repeat(64),
          url: `https://github.com/arkb75/Workbase/blob/${commitSha}/src/services/project-chat-agent-service.ts#L130-L210`,
        },
        source: { id: "source-1", label: "Workbase", type: "github_repo" },
      },
    }],
  };
}

describe("project knowledge retrieval mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([]);
    mocks.ensureHighlightEmbeddings.mockResolvedValue(undefined);
    mocks.ensureProjectKnowledgeEmbeddings.mockResolvedValue(undefined);
    mocks.findNearestProjectKnowledge.mockResolvedValue({
      highlights: new Map(),
      projectFacts: new Map(),
      evidence: new Map(),
      artifacts: new Map(),
    });
    mocks.findPolicyFacts.mockResolvedValue([]);
    mocks.syncWorkItemDescriptionEvidence.mockResolvedValue(undefined);
  });

  it("preserves Highlight ranking/freshness and re-grounds current artifact context", async () => {
    const highlight = approvedHighlight();
    mocks.findWorkItem.mockResolvedValue({
      id: "work-item-1",
      highlights: [highlight],
      projectFacts: [],
      evidenceItems: [
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `evidence-commit-${index}`,
          sourceId: "source-repository",
          included: true,
          type: "github_commit",
          title: `High-scoring repository commit ${index}`,
          content: `Implemented repository capability ${index} with current code evidence.`,
          searchText: `strongest accomplishments current repository capability ${index}`,
          metadata: {},
          createdAt: now,
          updatedAt: now,
          tags: [],
          source: {
            id: "source-repository",
            label: "Workbase repository",
            type: "github_repo",
            metadata: {},
          },
        })),
        {
        id: "evidence-work-item-description",
        sourceId: "source-description",
        included: true,
        type: "manual_note_excerpt",
        title: "Work Item description",
        content: "Built Workbase as a full-stack career content platform.",
        searchText: "built workbase full stack career content platform",
        metadata: { kind: "work_item_description" },
        createdAt: now,
        updatedAt: now,
        tags: [],
        source: {
          id: "source-description",
          label: "Work Item description",
          type: "manual_note",
          metadata: { kind: "work_item_description" },
        },
        },
      ],
      artifacts: [
        {
          id: "artifact-grounded",
          userId: "user-1",
          workItemId: "work-item-1",
          type: "project_summary",
          targetAngle: "general",
          tone: "direct",
          requestBrief: "Summarize the project",
          content: "A prior summary of the grounded chat system.",
          searchText: "prior summary grounded chat",
          lifecycleStatus: "active",
          createdAt: now,
          updatedAt: now,
          highlightProvenance: [{
            highlightId: highlight.id,
            highlightSnapshot: {
              text: highlight.text,
              summary: highlight.summary,
            },
            highlight,
          }],
          evidenceProvenance: [],
        },
        {
          id: "artifact-ungrounded",
          userId: "user-1",
          workItemId: "work-item-1",
          type: "project_summary",
          targetAngle: "general",
          tone: "direct",
          requestBrief: "Old summary",
          content: "An artifact with no recorded provenance.",
          searchText: "old summary",
          lifecycleStatus: "active",
          createdAt: now,
          updatedAt: now,
          highlightProvenance: [],
          evidenceProvenance: [],
        },
      ],
    });

    const result = await projectKnowledgeRetrievalService.retrieve({
      userId: "user-1",
      workItemId: "work-item-1",
      query: "Summarize my strongest accomplishments and make sure your information is up to date",
      purpose: "private_chat",
    });

    expect(mocks.findWorkItem).toHaveBeenNthCalledWith(1, {
      where: { id: "work-item-1", userId: "user-1" },
      select: { id: true },
    });
    expect(mocks.syncWorkItemDescriptionEvidence).toHaveBeenCalledWith("work-item-1");
    expect(mocks.ensureHighlightEmbeddings).not.toHaveBeenCalled();
    expect(mocks.ensureProjectKnowledgeEmbeddings).not.toHaveBeenCalled();
    expect(mocks.findNearestProjectKnowledge).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();

    const hit = result.hits.find((entry) => entry.id === highlight.id);
    expect(hit).toMatchObject({
      kind: "highlight",
      subsystemKey: "project_chat_grounding",
      validatedThroughSha: commitSha,
      accomplishmentRanking: {
        productImportance: 5,
        implementationBreadth: 4,
        technicalDifficulty: 5,
        ownershipAuthority: 5,
        distinctiveness: 4,
        freshness: 5,
      },
    });
    expect(hit?.citations[0]).toMatchObject({
      kind: "highlight",
      highlightId: highlight.id,
      provenance: [{
        evidenceItemId: "evidence-1",
        repository: "arkb75/Workbase",
        commitSha,
        path: "src/services/project-chat-agent-service.ts",
        startLine: 130,
        endLine: 210,
        contentHash: "c".repeat(64),
      }],
    });
    expect(rankAccomplishmentHits(result.hits, 5).map((entry) => entry.id)).toContain(highlight.id);

    expect(result.selectedArtifactIds).toEqual(["artifact-grounded"]);
    const artifactHit = result.hits.find((entry) => entry.id === "artifact-grounded");
    expect(artifactHit?.citations).toEqual([
      expect.objectContaining({ kind: "highlight", highlightId: highlight.id }),
    ]);
    expect(artifactHit?.citations.some((citation) => citation.kind === "artifact")).toBe(false);
    const catalog = buildMemoryCatalog({
      hits: result.hits,
      query: "Summarize my strongest accomplishments and make sure your information is up to date",
    });
    const artifactEntry = catalog.entries.find((entry) => entry.kind === "artifact");
    expect(artifactEntry?.citationIndexes).toHaveLength(1);
    expect(catalog.citations[artifactEntry!.citationIndexes[0]! - 1]).toMatchObject({
      kind: "highlight",
      highlightId: highlight.id,
    });
    expect(catalog.citations.some((citation) => citation.kind === "artifact")).toBe(false);

    expect(result.hits.find((entry) => entry.id === "evidence-work-item-description")).toMatchObject({
      kind: "evidence",
      authority: "included_evidence",
      ownershipAuthority: 3,
    });
  });

  it("hydrates the combined semantic shortlist instead of a recency-truncated subset", async () => {
    const rankedIds = Array.from({ length: 60 }, (_, index) => `highlight-${index + 1}`);
    mocks.findNearestProjectKnowledge.mockResolvedValue({
      highlights: new Map(rankedIds.map((id, index) => [id, 1 - index / 100])),
      projectFacts: new Map(),
      evidence: new Map(),
      artifacts: new Map(),
    });
    mocks.findWorkItem.mockResolvedValue({
      id: "work-item-1",
      highlights: [],
      projectFacts: [],
      evidenceItems: [],
      artifacts: [],
    });

    await projectKnowledgeRetrievalService.retrieve({
      userId: "user-1",
      workItemId: "work-item-1",
      query: "Where is retry backoff implemented?",
      purpose: "private_chat",
    });

    const hydratedQuery = mocks.findWorkItem.mock.calls[1]![0];
    expect(hydratedQuery.include.highlights.where.id.in).toEqual(rankedIds.slice(0, 48));
    expect(hydratedQuery.include.highlights.take).toBe(48);
  });
});
