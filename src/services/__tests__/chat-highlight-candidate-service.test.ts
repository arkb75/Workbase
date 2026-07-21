import { describe, expect, it } from "vitest";
import {
  chatCandidateTextSimilarity,
  classifySelfReportedProjectContext,
  classifyChatCandidateMatch,
  isHighlightWorthyUserContext,
  proposeHighlightFromChatContext,
} from "@/src/services/chat-highlight-candidate-service";

describe("chat highlight candidate detection", () => {
  it("recognizes reusable ownership and impact context", () => {
    expect(
      isHighlightWorthyUserContext(
        "I designed and shipped the queue worker, reducing imports from 40 minutes to 11 minutes.",
      ),
    ).toBe(true);
    expect(isHighlightWorthyUserContext(
      "I measured a 37% reduction in import latency after adding batching.",
    )).toBe(true);
  });

  it("does not turn routine project questions into candidates", () => {
    expect(isHighlightWorthyUserContext("How does the queue worker operate?"))
      .toBe(false);
  });

  it("does not treat hypotheticals or negated ownership as self-reported facts", () => {
    expect(isHighlightWorthyUserContext("Did I implement the queue worker and reduce latency by 40%?"))
      .toBe(false);
    expect(isHighlightWorthyUserContext("I did not build the queue worker; another team owned it."))
      .toBe(false);
  });

  it.each([
    [
      "I reduced latency by 37%. Check the repository to verify that.",
      "question_or_request",
    ],
    [
      "Approve the claim that I reduced latency by 37%.",
      "question_or_request",
    ],
    [
      "Delete the claim that I reduced latency by 37%.",
      "question_or_request",
    ],
    [
      "Does this mean I reduced latency by 37%.",
      "question_or_request",
    ],
    [
      "Write a resume bullet saying I reduced latency by 37%.",
      "question_or_request",
    ],
    [
      "Turn my 37% latency reduction into a resume bullet.",
      "question_or_request",
    ],
    [
      "Use the 37% result in a LinkedIn summary.",
      "question_or_request",
    ],
    [
      "Resume bullet: I reduced import latency by 37%.",
      "question_or_request",
    ],
    [
      "Sources for the claim that I reduced latency by 37%.",
      "question_or_request",
    ],
    [
      "I reduced latency by 37% — cite the sources.",
      "question_or_request",
    ],
    [
      "Did your prior answer say I reduced latency by 37%?",
      "question_or_request",
    ],
    [
      "We plan to support 100 users.",
      "prospective_or_hedged",
    ],
    [
      "Our target is 99.9% uptime.",
      "prospective_or_hedged",
    ],
    [
      "I think the batching change reduced latency by 37%.",
      "prospective_or_hedged",
    ],
    [
      "I never reduced import latency by 37%.",
      "negated",
    ],
    [
      'The prior assistant said "I reduced import latency by 37%."',
      "quoted_or_attributed",
    ],
    [
      "According to the release note, I reduced import latency by 37%.",
      "quoted_or_attributed",
    ],
  ] as const)(
    "does not auto-apply a question, command, uncertain statement, or quoted claim: %s",
    (statement, expected) => {
      expect(classifySelfReportedProjectContext(statement)).toBe(expected);
      expect(isHighlightWorthyUserContext(statement)).toBe(false);
    },
  );

  it.each([
    "I reduced latency by 37%. Check the repository to verify that.",
    "Approve the claim that I reduced latency by 37%.",
    "Write a resume bullet saying I reduced latency by 37%.",
    "Turn my 37% latency reduction into a resume bullet.",
    "Sources for the claim that I reduced latency by 37%.",
    "Our target is 99.9% uptime.",
    'The prior assistant said "I reduced import latency by 37%."',
  ])("returns before persistence for an ineligible chat turn: %s", async (text) => {
    await expect(proposeHighlightFromChatContext({
      userId: "user-1",
      workItemId: "work-item-1",
      threadId: "thread-1",
      messageId: "message-1",
      agentRunId: "run-1",
      text,
    })).resolves.toBeNull();
  });

  it("matches a self-reported revision without paying for a vector lookup", () => {
    expect(chatCandidateTextSimilarity(
      "I reduced repository refresh latency by 37% after batching file analysis.",
      "Reduced repository refresh latency by 37% through batched file analysis.",
    )).toBeGreaterThanOrEqual(0.62);
    expect(chatCandidateTextSimilarity(
      "I reduced repository refresh latency by 37%.",
      "Implemented GitHub OAuth callback validation.",
    )).toBeLessThan(0.62);
  });
});

describe("chat candidate match classification", () => {
  it.each([
    [{ verificationStatus: null, cosineDistance: null }, "new"],
    [{ verificationStatus: "approved" as const, cosineDistance: 0.1 }, "revision"],
    [{ verificationStatus: "draft" as const, cosineDistance: 0.1 }, "duplicate"],
    [
      { verificationStatus: "rejected" as const, cosineDistance: 0.1 },
      "rejected_guidance_match",
    ],
  ])("classifies %o as %s", (input, expected) => {
    expect(classifyChatCandidateMatch(input)).toBe(expected);
  });
});
