import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import {
  assertAnswerCitationContract,
  CitationIntegrityError,
  dedupeCitationCatalog,
  finalizeGroundedAnswer,
  selectReferencedCitations,
  splitCitationText,
} from "@/src/services/chat-citation-service";
import { buildChatCitationRows } from "@/src/services/project-chat-store";

const catalog: ProjectKnowledgeCitation[] = [
  {
    kind: "evidence",
    label: "Workbase README",
    excerpt: "Architecture overview",
    evidenceItemId: "evidence-readme",
  },
  {
    kind: "github_file",
    label: "src/services/types.ts",
    excerpt: "Service contracts",
    repository: "workbase/demo",
    commitSha: "a".repeat(40),
    path: "src/services/types.ts",
    startLine: 1,
    endLine: 47,
  },
  {
    kind: "project_fact",
    label: "Artifacts require approved highlights",
    excerpt: "Approved technical memory",
    projectFactId: "fact-1",
  },
];

describe("chat citation selection", () => {
  it("persists only referenced citations and compacts their ordinals", () => {
    const result = selectReferencedCitations(
      "The pipeline is approval gated [citation:3]. The README agrees [citation:1]. " +
        "The fact remains decisive [citation:3].",
      catalog,
    );

    expect(result.content).toBe(
      "The pipeline is approval gated [citation:1]. The README agrees [citation:2]. " +
        "The fact remains decisive [citation:1].",
    );
    expect(result.citations.map((citation) => citation.label)).toEqual([
      "Artifacts require approved highlights",
      "Workbase README",
    ]);
    expect(result.referencedIndexes).toEqual([2, 0]);
  });

  it("drops invalid markers instead of attaching the full catalog", () => {
    const result = selectReferencedCitations(
      "This answer has an unavailable source [citation:99].",
      catalog,
    );

    expect(result.content).toBe("This answer has an unavailable source.");
    expect(result.citations).toEqual([]);
  });

  it("groups adjacent markers into semantic citation text", () => {
    expect(
      splitCitationText("One claim [citation:1][citation:2]. Another [citation:3]."),
    ).toEqual([
      { kind: "text", text: "One claim " },
      { kind: "citations", ordinals: [1, 2] },
      { kind: "text", text: ". Another " },
      { kind: "citations", ordinals: [3] },
      { kind: "text", text: "." },
    ]);
  });

  it("removes markers beyond the persistence limit", () => {
    const largeCatalog = Array.from({ length: 21 }, (_, index) => ({
      kind: "evidence" as const,
      label: `Evidence ${index + 1}`,
      excerpt: "Grounded evidence.",
      evidenceItemId: `evidence-${index + 1}`,
    }));
    const answer = largeCatalog.map((_, index) => `[citation:${index + 1}]`).join("");
    const result = selectReferencedCitations(answer, largeCatalog);

    expect(result.citations).toHaveLength(20);
    expect(result.content).not.toContain("[citation:21]");
  });

  it("deduplicates citations by their durable source identity", () => {
    expect(dedupeCitationCatalog([catalog[0]!, catalog[0]!, catalog[2]!])).toEqual([
      catalog[0],
      catalog[2],
    ]);
  });

  it("keeps distinct content-addressed runtime authorities separate", () => {
    const runtime = {
      kind: "evidence" as const,
      label: "Runtime profiles",
      excerpt: "primary_answer=model-a",
      contentHash: "a".repeat(64),
    };
    const repository = {
      kind: "evidence" as const,
      label: "Repository state",
      excerpt: "head=abc",
      contentHash: "b".repeat(64),
    };
    expect(dedupeCitationCatalog([runtime, repository, runtime])).toEqual([
      runtime,
      repository,
    ]);
  });

  it("serializes structured grounded blocks and writes canonical markers itself", () => {
    const result = finalizeGroundedAnswer({
      blocks: [
        { heading: "Architecture", bodyMarkdown: "Built the approval-gated pipeline.", citationIndexes: [3, 1] },
        { heading: "Reuse", bodyMarkdown: "Reused the same fact.", citationIndexes: [3] },
      ],
      catalog,
    });
    expect(result.markdown).toContain("### Architecture\nBuilt the approval-gated pipeline. [citation:1][citation:2]");
    expect(result.markdown).toContain("Reused the same fact. [citation:1]");
    expect(result.citations.map((citation) => citation.label)).toEqual([
      "Artifacts require approved highlights",
      "Workbase README",
    ]);
    expect(result.groundedClaims[0]?.citationIndexes).toEqual([1, 2]);
  });

  it("writes a structured block's canonical markers on every accomplishment bullet", () => {
    const result = finalizeGroundedAnswer({
      blocks: [{
        heading: "Review and UI",
        bodyMarkdown: [
          "- Preserves immutable knowledge history.",
          "- Built the candidate review UI.",
        ].join("\n"),
        citationIndexes: [3, 1],
      }],
      catalog,
    });

    expect(result.markdown).toContain(
      "- Preserves immutable knowledge history. [citation:1][citation:2]\n" +
      "- Built the candidate review UI. [citation:1][citation:2]",
    );
    expect(result.citations).toHaveLength(2);
  });

  it("never injects citation markers into list-looking fenced code", () => {
    const result = finalizeGroundedAnswer({
      blocks: [{
        heading: "Example",
        bodyMarkdown: ["```text", "- not a Markdown claim", "```"].join("\n"),
        citationIndexes: [1],
      }],
      catalog,
    });

    expect(result.markdown).toContain("```text\n- not a Markdown claim\n```\n\n[citation:1]");
    expect(result.markdown).not.toContain("- not a Markdown claim [citation:1]");
  });

  it("rejects model-authored plain or canonical citation syntax", () => {
    for (const bodyMarkdown of ["Claim [3][5]", "Claim [citation:1]"]) {
      expect(() => finalizeGroundedAnswer({
        blocks: [{ bodyMarkdown, citationIndexes: [1] }],
        catalog,
      })).toThrow(CitationIntegrityError);
    }
  });

  it("does not allow a factual answer with zero persisted sources to complete", () => {
    expect(() => assertAnswerCitationContract({
      content: "A factual project answer.",
      citations: [],
      policy: "required_inline",
      groundedClaims: [],
    })).toThrow("must include at least one persisted inline citation");
  });

  it("allows procedural answers without citations and attached artifact provenance", () => {
    expect(() => assertAnswerCitationContract({ content: "Choose a candidate to review.", citations: [], policy: "none" })).not.toThrow();
    expect(() => assertAnswerCitationContract({ content: "Generated artifact", citations: [catalog[0]!], policy: "attached" })).not.toThrow();
  });

  it("snapshots immutable nested provenance for a used Highlight citation", () => {
    const provenance = [{
      evidenceItemId: "evidence-file-1",
      title: "src/services/project-chat-agent-service.ts",
      excerpt: "Builds the grounded memory catalog.",
      repository: "arkb75/Workbase",
      commitSha: "d".repeat(40),
      blobSha: "e".repeat(40),
      path: "src/services/project-chat-agent-service.ts",
      startLine: 130,
      endLine: 210,
      url: "https://github.com/arkb75/Workbase/blob/immutable/src/services/project-chat-agent-service.ts#L130-L210",
      contentHash: "f".repeat(64),
    }];
    const [row] = buildChatCitationRows("message-1", [{
      kind: "highlight",
      label: "Built grounded project chat",
      excerpt: "A reviewed Highlight.",
      highlightId: "highlight-1",
      provenance,
    }]);

    expect(row).toMatchObject({
      messageId: "message-1",
      kind: "highlight",
      highlightId: "highlight-1",
      ordinal: 1,
    });
    expect(row?.metadata).toMatchObject({ provenance });
  });

  it("persists compact repository evidence handles without raw command output", () => {
    const [row] = buildChatCitationRows("message-1", [{
      kind: "evidence",
      label: "acme/ledger — git log -5 — output lines 40-55",
      excerpt: "a1b2c3 Ada add reconciliation retry",
      sourceId: "source-1",
      repository: "acme/ledger",
      commitSha: "a".repeat(40),
      contentHash: "b".repeat(64),
      evidenceHandle: "evidence-1234567890",
      sourceOutputHash: "c".repeat(64),
      sourceOutputBytes: 81_000,
      sourceCommand: "git log -5",
      sourceStartLine: 40,
      sourceEndLine: 55,
      sourceTotalLines: 900,
      truncated: true,
    }]);

    expect(row?.excerpt).toBe("a1b2c3 Ada add reconciliation retry");
    expect(row?.metadata).toMatchObject({
      evidenceHandle: "evidence-1234567890",
      sourceOutputHash: "c".repeat(64),
      sourceOutputBytes: 81_000,
      sourceCommand: "git log -5",
      sourceStartLine: 40,
      sourceEndLine: 55,
      sourceTotalLines: 900,
      truncated: true,
    });
    expect(JSON.stringify(row)).not.toContain("rawOutput");
    expect(JSON.stringify(row)).not.toContain("redactedOutput");
  });
});
