import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import {
  dedupeCitationCatalog,
  selectReferencedCitations,
  splitCitationText,
} from "@/src/services/chat-citation-service";

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
});
