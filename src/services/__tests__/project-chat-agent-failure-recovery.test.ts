import { describe, expect, it } from "vitest";
import { modelLedProjectChatSystemPrompt } from "@/src/services/project-chat-model-agent-service";
import { projectChatRepairInstructions } from "@/src/services/project-chat-answer-verification-service";
import { usesLegacyProjectChatTestHarness } from "@/src/services/project-chat-agent-service";

describe("model-led project-chat failure recovery", () => {
  it("never enables the deterministic legacy agent for a real provider", () => {
    for (const provider of ["openrouter", "bedrock"] as const) {
      expect(usesLegacyProjectChatTestHarness({
        provider,
        nodeEnv: "test",
        vitest: "true",
      })).toBe(false);
    }
  });

  it("uses one model repair for verifier issues without prescribing fallback prose", () => {
    const instructions = projectChatRepairInstructions({
      requiresProjectCitations: true,
      instructionSatisfied: true,
      formatSatisfied: false,
      answerUseful: true,
      researchObjective: null,
      recommendedCapabilities: [],
      claimLedger: {
        version: "project-chat-claim-ledger-v1",
        entries: [{
          id: "claim_1",
          quote: "The unsupported path is src/unknown.ts.",
          centrality: "supporting",
          support: "unfounded",
          action: "remove_unfounded",
          citationIndexes: [3],
          missingOrContradictedPremise: "No source establishes that path.",
          rationale: "The cited source does not contain the path.",
          confidence: "high",
        }],
      },
      issues: [
        { code: "unsupported_claim", explanation: "One claim is not supported by the cited source.", candidateCitationIndexes: [3] },
        { code: "format_mismatch", explanation: "The requested relationships are not presented clearly.", candidateCitationIndexes: [] },
      ],
      generationRunId: "verification-1",
      mechanicalIssues: [],
    });
    expect(instructions).toContain("Revise your prior answer once");
    expect(instructions).toContain("unsupported_claim");
    expect(instructions).toContain("format_mismatch");
    expect(instructions).toContain("[citation:3]");
    expect(instructions).toContain("Do not call tools, search again, or introduce new sources");
    expect(instructions).toContain("frozen source catalog");
    expect(instructions).not.toContain("deterministic_source_synthesis");
    expect(instructions).not.toContain("## What I found");
  });

  it("tells the primary model to remove leaked transport syntax during its one repair", () => {
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
          quote: "The supported project answer cites its source.",
          centrality: "central",
          support: "direct",
          action: "keep_direct",
          citationIndexes: [1],
          missingOrContradictedPremise: null,
          rationale: "The source directly supports the answer.",
          confidence: "high",
        }],
      },
      issues: [],
      generationRunId: "verification-transport-leak",
      mechanicalIssues: [
        "The answer exposes internal conversation or provenance transport syntax.",
        "Substantive project claim block 3 has no inline source attachment.",
      ],
    });

    expect(instructions).toContain("internal conversation or provenance transport syntax");
    expect(instructions).toContain("claim block 3 has no inline source attachment");
    expect(instructions).toContain("Return only the revised user-facing answer");
  });

  it("keeps provider failures fail-closed instead of promising a canned recovery", () => {
    const prompt = modelLedProjectChatSystemPrompt({ afterFactReview: false });
    expect(prompt).toContain("State missing support plainly");
    expect(prompt).not.toContain("source exact fallback");
    expect(prompt).not.toContain("always answer");
  });
});
