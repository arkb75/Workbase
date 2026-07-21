import { describe, expect, it } from "vitest";
import type {
  ProjectKnowledgeCitation,
  ProjectResearchDossier,
  ProjectResearchResult,
} from "@/src/domain/project-chat";
import { assertAnswerCitationContract } from "@/src/services/chat-citation-service";
import { normalizeProjectResearchResultForChat } from "@/src/services/project-research-result-normalization-service";

function projectFact(
  id: string,
  statement: string,
): ProjectKnowledgeCitation {
  return {
    kind: "project_fact",
    label: `Project Fact · ${id}`,
    excerpt: statement,
    projectFactId: id,
    provenance: [{
      evidenceItemId: `evidence-${id}`,
      title: "Pinned repository excerpt",
      excerpt: "source excerpt",
      repository: "workbase/demo",
      commitSha: "a".repeat(40),
      path: `src/${id}.ts`,
      startLine: 1,
      endLine: 20,
    }],
  };
}

function highlight(
  id: string,
  statement: string,
): ProjectKnowledgeCitation {
  return {
    kind: "highlight",
    label: `Highlight · ${id}`,
    excerpt: statement,
    highlightId: id,
  };
}

function result(
  overrides: Partial<ProjectResearchResult> = {},
): ProjectResearchResult {
  return {
    status: "answered",
    answer: "",
    findings: [],
    citations: [],
    coverageGaps: [],
    warnings: [],
    candidateIds: [],
    generationRunIds: [],
    partial: false,
    exploredEvidence: [],
    coverage: null,
    ...overrides,
  };
}

function researchDossier(): ProjectResearchDossier {
  return {
    version: 1,
    controllerVersion: "test",
    allowedActions: [],
    remaining: null,
    objective: "Answer the question",
    phase: "completed",
    startedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:05:00.000Z",
    researchedAt: "2026-07-18T00:05:00.000Z",
    completedAt: "2026-07-18T00:05:00.000Z",
    repositories: [{
      sourceId: "source-1",
      name: "workbase/demo",
      importedAt: "2026-04-06T00:00:00.000Z",
      pinnedSha: "a".repeat(40),
      committedAt: "2026-07-18T00:00:00.000Z",
      resolvedAt: "2026-07-18T00:05:00.000Z",
    }],
    coverage: null,
    coverageGaps: [],
    warnings: [],
    partial: false,
    usage: null,
    notebook: null,
    candidateIds: [],
    provisionalProjectFactIds: [],
    generationRunIds: [],
    modelUsage: [],
    finalization: null,
  };
}

describe("project research result normalization", () => {
  it("persists only durable citations actually used by supported findings", () => {
    const first = "Repository reads are pinned to an immutable commit.";
    const unused = "The workspace includes a theme switcher.";
    const third = "Approved Project Facts become reusable technical memory.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: `${first} [citation:1]\n\n${third} [citation:3]`,
        citations: [
          projectFact("fact-1", first),
          projectFact("fact-unused", unused),
          highlight("highlight-3", third),
        ],
        findings: [
          { statement: first, confidence: "high", isInference: false, citationIndexes: [0] },
          { statement: unused, confidence: "high", isInference: false, citationIndexes: [1] },
          { statement: third, confidence: "high", isInference: false, citationIndexes: [2] },
        ],
      }),
    });

    expect(normalized.status).toBe("answered");
    expect(normalized.citations.map((citation) =>
      citation.projectFactId ?? citation.highlightId
    )).toEqual(["fact-1", "highlight-3"]);
    expect(normalized.answer).toContain(`${first} [citation:1]`);
    expect(normalized.answer).toContain(`${third} [citation:2]`);
    expect(normalized.answer).not.toContain("theme switcher");
    expect(normalized.diagnostics.discardedCitationCount).toBe(1);
    expect(normalized.research.citations).toEqual(normalized.citations);
    expect(normalized.research.exploredEvidence).toEqual([]);
    assertAnswerCitationContract({
      content: normalized.answer,
      citations: normalized.citations,
      policy: normalized.citationPolicy,
      groundedClaims: normalized.groundedClaims,
    });
  });

  it("recovers a citation-free research draft from exact structured findings", () => {
    const statement =
      "The artifact workflow uses approved Highlights as generation context.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: "Repository research completed.",
        citations: [projectFact("fact-1", statement)],
        findings: [{
          statement,
          confidence: "high",
          isInference: false,
          citationIndexes: [0],
        }],
      }),
    });

    expect(normalized).toMatchObject({
      status: "answered",
      citationPolicy: "required_inline",
      diagnostics: {
        fallbackUsed: true,
        reason: "normalized_supported_findings",
      },
    });
    expect(normalized.answer).toBe(`${statement} [citation:1]`);
    expect(normalized.citations).toHaveLength(1);
  });

  it("does not repeat successful structured findings through a prose research summary", () => {
    const first = "The agent exits when its iteration limit is reached.";
    const second = "The agent rejects a response without a stop reason.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: [
          "This assessment uses auto-applied, evidence-backed Project Facts from repository research.",
          `- ${first} [citation:1]`,
          `- ${second} [citation:2]`,
        ].join("\n"),
        citations: [
          projectFact("fact-1", first),
          projectFact("fact-2", second),
        ],
        findings: [
          { statement: first, confidence: "high", isInference: false, citationIndexes: [0] },
          { statement: second, confidence: "high", isInference: false, citationIndexes: [1] },
        ],
      }),
    });

    expect(normalized.answer.split(first)).toHaveLength(2);
    expect(normalized.answer.split(second)).toHaveLength(2);
    expect(normalized.answer).not.toContain("This assessment uses auto-applied");
  });

  it("keeps a supported subset when another research finding is unsupported", () => {
    const supported =
      "Repository exploration enforces a bounded file-read budget.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: [
          `${supported} [citation:1]`,
          "The runtime guarantees zero production failures. [citation:2]",
        ].join("\n\n"),
        citations: [
          projectFact("fact-1", supported),
          projectFact("fact-2", "The runtime records normalized stop reasons."),
        ],
        findings: [
          { statement: supported, confidence: "high", isInference: false, citationIndexes: [0] },
          {
            statement: "The runtime guarantees zero production failures.",
            confidence: "high",
            isInference: false,
            citationIndexes: [1],
          },
        ],
        partial: true,
        coverageGaps: ["Deployment behavior was not inspected."],
      }),
    });

    expect(normalized.status).toBe("answered");
    expect(normalized.answer).toBe(
      `${supported} [citation:1]\n\n> **Evidence gap:** Deployment behavior was not inspected.`,
    );
    expect(normalized.answer).not.toContain("zero production failures");
    expect(normalized.citations).toHaveLength(1);
    expect(normalized.research.partial).toBe(true);
    expect(normalized.research.coverageGaps).toEqual([
      "Deployment behavior was not inspected.",
    ]);
  });

  it("keeps a requested negative evidence boundary even when supported research is otherwise complete", () => {
    const supported =
      "The agent exits when the iteration limit is reached.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: `${supported} [citation:1]`,
        citations: [projectFact("fact-1", supported)],
        findings: [
          { statement: supported, confidence: "high", isInference: false, citationIndexes: [0] },
        ],
        partial: false,
        coverageGaps: [
          "The inspected excerpts did not establish a retry or backoff policy; an iteration guard must not be reported as a retry count.",
        ],
      }),
    });

    expect(normalized.status).toBe("answered");
    expect(normalized.answer).toBe(
      `${supported} [citation:1]\n\n> **Evidence gap:** The inspected excerpts did not establish a retry or backoff policy; an iteration guard must not be reported as a retry count.`,
    );
    expect(normalized.citations).toHaveLength(1);
  });

  it("preserves multiple requested negative evidence boundaries", () => {
    const supported =
      "The agent exits when the iteration limit is reached.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: `${supported} [citation:1]`,
        citations: [projectFact("fact-1", supported)],
        findings: [
          { statement: supported, confidence: "high", isInference: false, citationIndexes: [0] },
        ],
        coverageGaps: [
          "The inspected excerpts did not establish a retry policy.",
          "The inspected excerpts did not establish a backoff policy.",
          "Deployment behavior was not inspected.",
        ],
      }),
    });

    expect(normalized.answer).toContain("> **Evidence gaps:**");
    expect(normalized.answer).toContain("> - The inspected excerpts did not establish a retry policy.");
    expect(normalized.answer).toContain("> - The inspected excerpts did not establish a backoff policy.");
    expect(normalized.answer).toContain("> - Deployment behavior was not inspected.");
  });

  it("never promotes raw GitHub exploration as a peer source", () => {
    const statement =
      "The implementation uses a retry loop with three attempts.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: `${statement} [citation:1]`,
        citations: [{
          kind: "github_file",
          label: "src/runtime.ts",
          excerpt: "for (let attempt = 0; attempt < 3; attempt += 1)",
          sourceId: "source-1",
          repository: "workbase/demo",
          commitSha: "a".repeat(40),
          path: "src/runtime.ts",
          startLine: 10,
          endLine: 14,
        }],
        findings: [{
          statement,
          confidence: "high",
          isInference: false,
          citationIndexes: [0],
        }],
      }),
    });

    expect(normalized.status).toBe("insufficient_context");
    expect(normalized.citations).toEqual([]);
    expect(normalized.answer).toContain(
      "no durable Project Fact, Highlight, or included evidence",
    );
    expect(normalized.research.exploredEvidence).toEqual([]);
  });

  it("turns malformed citation ordinals into a specific evidence gap", () => {
    const statement =
      "Repository reads are pinned to an immutable commit.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: `${statement} [citation:999]`,
        citations: [projectFact("fact-1", statement)],
        findings: [{
          statement,
          confidence: "high",
          isInference: false,
          citationIndexes: [0],
        }],
        coverageGaps: ["The requested control flow was not established."],
      }),
    });

    expect(normalized.status).toBe("insufficient_context");
    expect(normalized.citationPolicy).toBe("none");
    expect(normalized.answer).toBe(
      "Repository research completed, but no durable Project Fact, Highlight, or included evidence supported a user-facing answer. Remaining evidence gap: The requested control flow was not established.",
    );
    expect(normalized.answer).not.toContain("verified against its sources");
  });

  it("rejects topically related but unsupported claims", () => {
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer:
          "The runtime guarantees exactly-once execution across every deployment. [citation:1]",
        citations: [
          projectFact(
            "fact-1",
            "The runtime persists progress events for durable workflows.",
          ),
        ],
        findings: [{
          statement:
            "The runtime guarantees exactly-once execution across every deployment.",
          confidence: "high",
          isInference: false,
          citationIndexes: [0],
        }],
      }),
    });

    expect(normalized.status).toBe("insufficient_context");
    expect(normalized.answer).toContain("no durable Project Fact");
    expect(normalized.research.findings).toEqual([]);
  });

  it("rejects stale import-date claims when a newer repository inspection exists", () => {
    const statement =
      "The repository assessment is current as of April 6, 2026.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        answer: `${statement} [citation:1]`,
        citations: [projectFact("fact-1", statement)],
        findings: [{
          statement,
          confidence: "high",
          isInference: false,
          citationIndexes: [0],
        }],
      }),
      dossier: researchDossier(),
    });

    expect(normalized.status).toBe("insufficient_context");
    expect(normalized.answer).toContain("no durable Project Fact");
  });

  it("normalizes empty and failed results without leaking provider errors", () => {
    const empty = normalizeProjectResearchResultForChat({
      result: result(),
    });
    expect(empty.status).toBe("insufficient_context");
    expect(empty.answer).toBe(
      "Repository research completed, but it did not produce a user-facing answer.",
    );

    const failed = normalizeProjectResearchResultForChat({
      result: result({
        status: "failed",
        answer: "ValidationException: secret provider details",
        warnings: ["The answer could not be verified against its sources."],
        coverageGaps: ["No supported fact was extracted."],
      }),
    });
    expect(failed.status).toBe("insufficient_context");
    expect(failed.answer).toBe(
      "Repository research stopped before it could produce a supported answer. Remaining evidence gap: No supported fact was extracted.",
    );
    expect(failed.answer).not.toContain("ValidationException");
    expect(failed.answer).not.toContain("verified against its sources");
    expect(failed.research.citations).toEqual([]);
    expect(failed.research.warnings).toEqual([]);
  });

  it.each(["failed", "insufficient_context"] as const)(
    "publishes the union of safe answer and finding subsets when research ends %s",
    (status) => {
      const answerStatement =
        "Repository reads are pinned to an immutable commit.";
      const findingStatement =
        "The research loop enforces a bounded file-read budget.";
      const normalized = normalizeProjectResearchResultForChat({
        result: result({
          status,
          answer: `${answerStatement} [citation:1]`,
          citations: [
            projectFact("fact-answer", answerStatement),
            projectFact("fact-finding", findingStatement),
          ],
          findings: [{
            statement: findingStatement,
            confidence: "high",
            isInference: false,
            citationIndexes: [1],
          }],
          coverageGaps: ["Retry behavior was not established."],
        }),
      });

      expect(normalized.status).toBe("answered");
      expect(normalized.answer).toContain(answerStatement);
      expect(normalized.answer).toContain(findingStatement);
      expect(normalized.answer).toContain("supported subset recovered");
      expect(normalized.citations).toHaveLength(2);
      expect(normalized.research.partial).toBe(true);
      expect(normalized.diagnostics.inputStatus).toBe(status);
      expect(normalized.diagnostics.fallbackUsed).toBe(true);
    },
  );

  it("does not expose draft facts while a review batch is pending", () => {
    const statement = "A sensitive integration stores an encrypted token.";
    const normalized = normalizeProjectResearchResultForChat({
      result: result({
        status: "awaiting_review",
        answer: `${statement} [citation:1]`,
        citations: [projectFact("fact-1", statement)],
        findings: [{
          statement,
          confidence: "high",
          isInference: false,
          citationIndexes: [0],
        }],
        candidateIds: ["candidate-1", "candidate-2"],
      }),
    });

    expect(normalized).toMatchObject({
      status: "awaiting_review",
      citationPolicy: "none",
      citations: [],
      answer:
        "Repository research produced 2 Project Fact candidates that must be reviewed before they can support an answer.",
    });
    expect(normalized.research.citations).toEqual([]);
    expect(normalized.research.findings).toEqual([]);
  });
});
