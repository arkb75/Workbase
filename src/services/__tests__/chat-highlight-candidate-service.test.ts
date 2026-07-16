import { describe, expect, it } from "vitest";
import {
  chatCandidateTextSimilarity,
  classifyChatCandidateMatch,
  isHighlightWorthyUserContext,
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
