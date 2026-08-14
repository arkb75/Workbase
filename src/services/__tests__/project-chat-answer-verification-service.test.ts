import { describe, expect, it } from "vitest";
import type { ProjectKnowledgeCitation } from "@/src/domain/project-chat";
import {
  analyzeProjectChatCitationSyntax,
  compactProjectChatVerificationSources,
  finalizeModelLedProjectChatAnswer,
  projectChatAnswerVerificationSchema,
  projectChatAnswerVerificationSystemPrompt,
  projectChatRepairInstructions,
} from "@/src/services/project-chat-answer-verification-service";
import { analyzeProjectChatPublicationSafety } from "@/src/lib/project-chat-publication-safety";
import {
  claimLedgerValidationIssues,
  supportedClaimLedgerAnswer,
} from "@/src/services/project-chat-claim-ledger-service";

const catalog: ProjectKnowledgeCitation[] = [
  {
    kind: "evidence",
    label: "Resolved runtime profiles",
    excerpt: "primary_answer uses model-a; verification uses model-b",
    contentHash: "a".repeat(64),
  },
  {
    kind: "github_file",
    label: "Runtime implementation",
    excerpt: "The runtime resolves every profile independently.",
    repository: "arkb75/Workbase",
    commitSha: "1".repeat(40),
    path: "src/lib/llm-config.ts",
    startLine: 1,
    endLine: 20,
  },
];

describe("model-led project-chat answer boundaries", () => {
  it("shows the verifier every frozen source, including uncited repair candidates", () => {
    const sources = compactProjectChatVerificationSources(catalog);
    expect(sources).toEqual([
      expect.objectContaining({ citationIndex: 1, label: "Resolved runtime profiles" }),
      expect.objectContaining({ citationIndex: 2, label: "Runtime implementation" }),
    ]);
    expect(sources[1]?.excerpt).toContain("resolves every profile independently");
  });

  it("records a useful qualified claim without rejecting the whole answer", () => {
    const parsed = projectChatAnswerVerificationSchema.parse({
      requiresProjectCitations: true,
      instructionSatisfied: false,
      formatSatisfied: true,
      answerUseful: true,
      researchObjective: null,
      recommendedCapabilities: [],
      claimLedger: {
        version: "project-chat-claim-ledger-v1",
        entries: [{
          id: "claim_1",
          quote: "This was the most important change.",
          centrality: "central",
          support: "reasonable_inference",
          action: "qualify",
          citationIndexes: [1, 2],
          missingOrContradictedPremise: null,
          rationale: "Scope is established, but importance is a judgment.",
          confidence: "high",
        }],
      },
      issues: [{
        code: "qualified_majority",
        explanation: "The sources establish merged scope but not an objective ranking of importance.",
        candidateCitationIndexes: [1, 2],
      }],
    });
    expect(parsed.answerUseful).toBe(true);
    expect(parsed.claimLedger.entries[0]?.action).toBe("qualify");
  });

  it("requests one semantic evidence continuation instead of publishing a central resolvable gap", () => {
    expect(projectChatAnswerVerificationSchema.parse({
      requiresProjectCitations: true,
      instructionSatisfied: false,
      formatSatisfied: true,
      answerUseful: true,
      researchObjective: "Establish the requested ordering and merge relationship from the attached repository.",
      recommendedCapabilities: ["repository_git"],
      claimLedger: {
        version: "project-chat-claim-ledger-v1",
        entries: [{
          id: "claim_1",
          quote: "Change A preceded change B.",
          centrality: "central",
          support: "ambiguous",
          action: "research",
          citationIndexes: [1],
          missingOrContradictedPremise: "The frozen sources do not establish commit ordering.",
          rationale: "Pinned Git history can resolve the central relationship.",
          confidence: "high",
        }],
      },
      issues: [{
        code: "ordering_not_established",
        explanation: "Durable memory names changes but does not establish their relative order.",
        candidateCitationIndexes: [1],
      }],
    })).toMatchObject({
      recommendedCapabilities: ["repository_git"],
      claimLedger: { entries: [expect.objectContaining({ action: "research" })] },
    });
  });

  it("limits deterministic citation validation to syntax and catalog range", () => {
    expect(analyzeProjectChatCitationSyntax(
      "Supported [citation:1] and implemented here [citation:2].",
      catalog.length,
    )).toEqual({ issues: [], citationIndexes: [1, 2] });

    expect(analyzeProjectChatCitationSyntax(
      "Bad [citation:wat] and missing [citation:7].",
      catalog.length,
    ).issues).toEqual([
      "Malformed citation marker: [citation:wat].",
      "Citation 7 is outside the available source catalog.",
      "One or more citation markers are not in canonical [citation:N] form.",
    ]);
  });

  it("preserves the primary model's table structure while compacting citations", () => {
    const answer = [
      "| Purpose | Profile | Model |",
      "|---|---|---|",
      "| Final answer | `primary_answer` | `model-a` [citation:1] |",
      "| Verification | `verification` | `model-b` [citation:1] |",
      "",
      "The mapping is resolved from the active runtime, not inferred from docs. [citation:2]",
    ].join("\n");
    const result = finalizeModelLedProjectChatAnswer({
      answer,
      catalog,
      requiresProjectCitations: true,
    });

    expect(result.answer).toBe(answer);
    expect(result.answer).toContain("| Purpose | Profile | Model |");
    expect(result.citations).toHaveLength(2);
    expect(result.citationPolicy).toBe("required_inline");
    expect(result.groundedClaims.length).toBeGreaterThanOrEqual(2);
  });

  it("allows genuinely conversational answers without manufacturing sources", () => {
    const result = finalizeModelLedProjectChatAnswer({
      answer: "Yes—tell me which trade-off you want to explore first.",
      catalog,
      requiresProjectCitations: false,
    });
    expect(result).toMatchObject({
      answer: "Yes—tell me which trade-off you want to explore first.",
      citations: [],
      citationPolicy: "none",
      groundedClaims: [],
    });
  });

  it("fails closed when a project-grounded answer has no source", () => {
    expect(() => finalizeModelLedProjectChatAnswer({
      answer: "The active runtime uses model-a.",
      catalog,
      requiresProjectCitations: true,
    })).toThrow("cites no authoritative project source");
  });

  it("rejects internal conversation transport even when the semantic verifier would publish", () => {
    const leaked = [
      "The repository is current. [citation:1]",
      "",
      "Everything else in the prior summary is confirmed accurate against the current repository state. [citation:1]",
      "<message_id>cmsr2hs5d00yob3un3nmthh9k</message_id>",
      '<used_sources>[{"ordinal":1,"kind":"repository_state"}]</used_sources>',
    ].join("\n");

    expect(analyzeProjectChatPublicationSafety({
      answer: leaked,
      requiresProjectCitations: true,
    })).toContainEqual(expect.objectContaining({ code: "internal_protocol_exposed" }));
    expect(() => finalizeModelLedProjectChatAnswer({
      answer: leaked,
      catalog,
      requiresProjectCitations: true,
    })).toThrow("internal conversation or provenance transport syntax");
  });

  it("leaves semantic catch-all grounding to the verifier instead of a layout regex", () => {
    const answer = [
      "The active runtime is resolved from configuration. [citation:1]",
      "",
      "Everything else in the prior summary, including security and recovery behavior, is confirmed accurate against the current repository state.",
    ].join("\n");

    expect(analyzeProjectChatPublicationSafety({
      answer,
      requiresProjectCitations: true,
    })).toContainEqual(expect.objectContaining({
      code: "uncited_project_claim_block",
      explanation: "Substantive project claim block 2 has no inline source attachment.",
    }));
    expect(finalizeModelLedProjectChatAnswer({
      answer,
      catalog,
      requiresProjectCitations: true,
    }).answer).toBe(answer);
    expect(finalizeModelLedProjectChatAnswer({
      answer,
      catalog,
      requiresProjectCitations: false,
    }).answer).toBe(answer);
  });

  it("keeps formatting flexible while requiring each substantive list claim to be grounded", () => {
    const answer = [
      "Here is the short version:",
      "",
      "- Runtime selection comes from active configuration. [citation:1]",
      "- Repository implementation resolves each profile independently. [citation:2]",
    ].join("\n");

    expect(analyzeProjectChatPublicationSafety({
      answer,
      requiresProjectCitations: true,
    })).toEqual([]);
    expect(finalizeModelLedProjectChatAnswer({
      answer,
      catalog,
      requiresProjectCitations: true,
    }).answer).toBe(answer);
  });

  it("accepts an authoritative citation line immediately after a Markdown table", () => {
    const result = finalizeModelLedProjectChatAnswer({
      answer: [
        "| Purpose | Model |",
        "|---|---|",
        "| Final answers | Terra |",
        "| Verification | Luna |",
        "",
        "[citation:1]",
      ].join("\n"),
      catalog,
      requiresProjectCitations: true,
    });
    expect(result.answer).toContain("| Final answers | Terra |");
    expect(result.groundedClaims).toEqual([{
      claim: "| Verification | Luna |",
      citationIndexes: [1],
    }]);
  });

  it("asks the primary model—not a template—to repair or state an evidence boundary", () => {
    const instructions = projectChatRepairInstructions({
      requiresProjectCitations: true,
      instructionSatisfied: true,
      formatSatisfied: true,
      answerUseful: true,
      researchObjective: null,
      recommendedCapabilities: [],
      claimLedger: {
        version: "project-chat-claim-ledger-v1",
        entries: [{
          id: "claim_1",
          quote: "The system has a 20 ms p95.",
          centrality: "supporting",
          support: "unfounded",
          action: "remove_unfounded",
          citationIndexes: [],
          missingOrContradictedPremise: "No source establishes p95.",
          rationale: "The metric is not present in the frozen evidence.",
          confidence: "high",
        }],
      },
      issues: [{ code: "missing_metric", explanation: "No source establishes p95.", candidateCitationIndexes: [] }],
      generationRunId: "verification-1",
      mechanicalIssues: [],
    });
    expect(instructions).toContain("No source establishes p95.");
    expect(instructions).toContain("remove only claims explicitly marked remove");
    expect(instructions).toContain("Return only the revised user-facing answer");
    expect(instructions).not.toContain("Here is what I found");
  });

  it("does not discard a supported bounded revision solely for redundant table-marker placement", () => {
    expect(projectChatAnswerVerificationSystemPrompt({
      attempt: 1,
      researchContinuationUsed: false,
    }))
      .not.toContain("bounded revision 1 of at most 2");
    expect(projectChatAnswerVerificationSystemPrompt({
      attempt: 2,
      researchContinuationUsed: false,
    }))
      .toContain("Do not turn editorial preferences or repeated citation placement into substantive objections");
    expect(projectChatAnswerVerificationSystemPrompt({
      attempt: 2,
      researchContinuationUsed: false,
    }))
      .toContain("Classify the remaining claims precisely");
    expect(projectChatAnswerVerificationSystemPrompt({
      attempt: 2,
      researchContinuationUsed: false,
    }))
      .toContain("already received its bounded revision");
    expect(projectChatAnswerVerificationSystemPrompt({
      attempt: 1,
      researchContinuationUsed: false,
    })).toContain("Build an internal claim ledger");
    expect(projectChatAnswerVerificationSystemPrompt({
      attempt: 1,
      researchContinuationUsed: false,
    })).toContain("harmless wording or Markdown differences are not verification failures");
    expect(projectChatAnswerVerificationSystemPrompt({
      attempt: 2,
      researchContinuationUsed: true,
    })).toContain("Do not request another");
  });

  it("requires high confidence and an explicit premise before removing a claim", () => {
    expect(claimLedgerValidationIssues({
      version: "project-chat-claim-ledger-v1",
      entries: [{
        id: "claim_1",
        quote: "The migration reduced latency by 40%.",
        centrality: "supporting",
        support: "unfounded",
        action: "remove_unfounded",
        citationIndexes: [],
        missingOrContradictedPremise: null,
        rationale: "The metric was not found.",
        confidence: "medium",
      }],
    })).toEqual([
      "Removing claim_1 requires high confidence.",
      "claim_1 must identify the missing or contradicted premise.",
    ]);
  });

  it("can salvage verified claims without retaining a rejected peripheral claim", () => {
    expect(supportedClaimLedgerAnswer({
      version: "project-chat-claim-ledger-v1",
      entries: [{
        id: "claim_1",
        quote: "Drafting uses model-a.",
        centrality: "central",
        support: "direct",
        action: "keep_direct",
        citationIndexes: [1],
        missingOrContradictedPremise: null,
        rationale: "The configuration directly establishes the assignment.",
        confidence: "high",
      }, {
        id: "claim_2",
        quote: "This reduced latency by 40%.",
        centrality: "supporting",
        support: "unfounded",
        action: "remove_unfounded",
        citationIndexes: [],
        missingOrContradictedPremise: "No performance measurement is present.",
        rationale: "The metric is invented.",
        confidence: "high",
      }],
    })).toBe("- Drafting uses model-a. [citation:1]");
  });

  it("keeps a scoped reasonable inference in fallback publication but drops an ambiguous claim", () => {
    expect(supportedClaimLedgerAnswer({
      version: "project-chat-claim-ledger-v1",
      entries: [{
        id: "claim_1",
        quote: "The invite flow is implemented transactionally.",
        centrality: "central",
        support: "direct",
        action: "keep_direct",
        citationIndexes: [1],
        missingOrContradictedPremise: null,
        rationale: "The service directly establishes the transaction.",
        confidence: "high",
      }, {
        id: "claim_2",
        quote: "No production p95 is established by the repository evidence inspected.",
        centrality: "central",
        support: "reasonable_inference",
        action: "qualify",
        citationIndexes: [1, 2],
        missingOrContradictedPremise: "The inspected sources contain no production telemetry, but the search was bounded.",
        rationale: "The negative claim is explicitly limited to inspected evidence.",
        confidence: "medium",
      }, {
        id: "claim_3",
        quote: "The session is cookie-backed.",
        centrality: "supporting",
        support: "ambiguous",
        action: "qualify",
        citationIndexes: [2],
        missingOrContradictedPremise: "The inspected route requires a session but does not establish its storage mechanism.",
        rationale: "The storage mechanism needs another source.",
        confidence: "high",
      }],
    })).toBe([
      "- The invite flow is implemented transactionally. [citation:1]",
      "- Based on the inspected evidence: No production p95 is established by the repository evidence inspected. [citation:1] [citation:2]",
    ].join("\n"));
  });
});
