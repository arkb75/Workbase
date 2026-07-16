import { describe, expect, it } from "vitest";
import type {
  EvidenceItemSnapshot,
  HighlightSnapshot,
} from "@/src/domain/types";
import {
  buildPublicArtifactCitations,
  buildPublicArtifactVerificationSources,
  deriveArtifactEvidenceItemIds,
  selectArtifactSupportingEvidence,
} from "@/src/services/artifact-publication-policy";
import { mockArtifactGenerationService } from "@/src/services/mock-artifact-generation-service";
import { buildChatCitationRows } from "@/src/services/project-chat-store";
import { artifactGenerationLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import {
  artifactGenerationExampleOutput,
  artifactGenerationJsonSchema,
} from "@/src/lib/llm-json-schemas";
import {
  nestArtifactEvidenceUnderHighlights,
  readArtifactHighlightProvenance,
} from "@/src/lib/artifact-provenance";

function highlight(input: {
  id: string;
  text: string;
  evidenceItemIds: string[];
}): HighlightSnapshot {
  return {
    id: input.id,
    workItemId: "work-item-1",
    text: input.text,
    summary: `Verified summary for ${input.text}`,
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    visibility: "resume_safe",
    publicSafetyStatus: "verified",
    evidence: {
      summary: "Exact underlying evidence.",
      sourceRefs: input.evidenceItemIds.map((evidenceItemId) => ({
        evidenceItemId,
        sourceId: "github-source",
        sourceLabel: "Repository",
        sourceType: "github_repo",
        title: `Evidence ${evidenceItemId}`,
        excerpt: `Excerpt ${evidenceItemId}`,
      })),
    },
    tags: [],
  };
}

function evidence(input: {
  id: string;
  type?: EvidenceItemSnapshot["type"];
  content?: string;
  metadata?: EvidenceItemSnapshot["metadata"];
}): EvidenceItemSnapshot {
  return {
    id: input.id,
    workItemId: "work-item-1",
    sourceId: "github-source",
    externalId: input.id,
    type: input.type ?? "github_file_excerpt",
    title: `Evidence ${input.id}`,
    content: input.content ?? `Excerpt ${input.id}`,
    searchText: input.content ?? `Excerpt ${input.id}`,
    parentKind: "github_file",
    parentKey: "src/service.ts",
    included: true,
    metadata: input.metadata ?? null,
    source: {
      id: "github-source",
      label: "Repository",
      type: "github_repo",
      externalId: "owner/repository",
    },
  };
}

describe("public Artifact publication policy", () => {
  it("derives provenance only from Evidence directly linked to a used approved Highlight", async () => {
    const selected = highlight({
      id: "highlight-selected",
      text: "Implemented the durable workflow.",
      evidenceItemIds: ["github-excerpt", "not-retrieved"],
    });
    const unused = highlight({
      id: "highlight-unused",
      text: "Implemented an unrelated feature.",
      evidenceItemIds: ["unrelated-evidence"],
    });
    const supportingEvidence = [
      evidence({ id: "github-excerpt" }),
      evidence({ id: "unrelated-evidence", type: "manual_note_excerpt" }),
    ];

    const derived = deriveArtifactEvidenceItemIds({
      highlights: [selected, unused],
      usedHighlightIds: [selected.id],
      allowedEvidenceItemIds: new Set(supportingEvidence.map((item) => item.id)),
    });
    expect(derived).toEqual(["github-excerpt"]);

    const generated = await mockArtifactGenerationService.generate({
      request: {
        userId: "user-1",
        workItemId: "work-item-1",
        type: "resume_bullets",
        targetAngle: "general",
        tone: "concise",
      },
      highlights: [selected],
      supportingEvidence,
    });
    expect(generated.supportingEvidenceItemIds).toEqual(["github-excerpt"]);

    const sameParentSibling = evidence({ id: "same-parent-sibling" });
    const excludedDirectEvidence = {
      ...evidence({ id: "not-retrieved" }),
      included: false,
    };
    expect(selectArtifactSupportingEvidence({
      highlights: [selected],
      evidenceItems: [
        ...supportingEvidence,
        sameParentSibling,
        excludedDirectEvidence,
      ],
    }).map((item) => item.id)).toEqual(["github-excerpt"]);
  });

  it("publishes only Highlights as peer sources and preserves exact GitHub provenance underneath", () => {
    const selected = highlight({
      id: "highlight-selected",
      text: "Implemented the durable workflow.",
      evidenceItemIds: ["github-excerpt"],
    });
    const githubExcerpt = evidence({
      id: "github-excerpt",
      content: "export async function executeWorkflow() { return resumeRun(); }",
      metadata: {
        repository: "owner/repository",
        commitSha: "a".repeat(40),
        blobSha: "b".repeat(40),
        path: "src/workflow.ts",
        startLine: 10,
        endLine: 12,
        url: "https://github.com/owner/repository/blob/immutable/src/workflow.ts#L10-L12",
        excerptHash: "sha256:exact",
      },
    });
    const unrelatedRawEvidence = evidence({
      id: "unrelated-raw",
      type: "manual_note_excerpt",
      content: "Raw private note that must not become a peer source.",
    });

    const citations = buildPublicArtifactCitations({
      highlights: [selected],
      usedHighlightIds: [selected.id],
      supportingEvidence: [githubExcerpt, unrelatedRawEvidence],
    });

    expect(citations).toHaveLength(1);
    expect(citations.map((citation) => citation.kind)).toEqual(["highlight"]);
    expect(citations.some((citation) =>
      citation.kind === "evidence" || citation.kind === "github_file"
    )).toBe(false);
    expect(citations[0]?.provenance).toEqual([{
      evidenceItemId: "github-excerpt",
      title: "Evidence github-excerpt",
      excerpt: "export async function executeWorkflow() { return resumeRun(); }",
      repository: "owner/repository",
      commitSha: "a".repeat(40),
      blobSha: "b".repeat(40),
      path: "src/workflow.ts",
      startLine: 10,
      endLine: 12,
      url: "https://github.com/owner/repository/blob/immutable/src/workflow.ts#L10-L12",
      contentHash: "sha256:exact",
    }]);
    expect(JSON.stringify(citations)).not.toContain("Raw private note");

    const persistedRows = buildChatCitationRows("assistant-message", citations);
    expect(persistedRows).toHaveLength(1);
    expect(persistedRows[0]).toMatchObject({
      kind: "highlight",
      highlightId: "highlight-selected",
      evidenceItemId: null,
      metadata: {
        provenance: [{
          evidenceItemId: "github-excerpt",
          path: "src/workflow.ts",
          commitSha: "a".repeat(40),
          contentHash: "sha256:exact",
        }],
      },
    });

    const verificationSources = buildPublicArtifactVerificationSources([selected]);
    expect(verificationSources.map((source) => source.kind)).toEqual(["highlight"]);
    expect(JSON.stringify(verificationSources)).not.toContain("github_file");
    expect(JSON.stringify(verificationSources)).not.toContain("Raw private note");
  });

  it("requires the model-facing Evidence ID field to remain empty", () => {
    expect(artifactGenerationExampleOutput.supportingEvidenceItemIds).toEqual([]);
    expect(
      artifactGenerationLlmOutputSchema.safeParse({
        content: "Implemented a durable, retry-safe project workflow.",
        usedHighlightIds: ["highlight-selected"],
        supportingEvidenceItemIds: ["raw-evidence"],
      }).success,
    ).toBe(false);
    expect(
      artifactGenerationJsonSchema.properties.supportingEvidenceItemIds,
    ).toMatchObject({ minItems: 0, maxItems: 0 });
  });

  it("restores immutable Evidence underneath its snapshotted Highlight lineage", () => {
    const snapshots = readArtifactHighlightProvenance([{
      id: "highlight-provenance-row",
      highlightId: "highlight-selected",
      highlightSnapshot: {
        text: "Implemented the durable workflow.",
        summary: "Verified workflow implementation.",
        visibility: "resume_safe",
        confidence: "high",
        evidenceItemIds: ["github-excerpt"],
      },
      highlight: null,
    }]);
    const nested = nestArtifactEvidenceUnderHighlights(snapshots, [{
      id: "github-excerpt",
      title: "Immutable excerpt",
    }, {
      id: "unrelated-raw",
      title: "Unrelated raw input",
    }]);

    expect(nested).toEqual([{
      id: "highlight-selected",
      text: "Implemented the durable workflow.",
      summary: "Verified workflow implementation.",
      visibility: "resume_safe",
      confidence: "high",
      evidenceItemIds: ["github-excerpt"],
      provenance: [{ id: "github-excerpt", title: "Immutable excerpt" }],
    }]);
  });
});
