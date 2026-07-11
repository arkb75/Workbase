import { describe, expect, it } from "vitest";
import {
  buildStandaloneResearchQuestion,
  requiresLiveRepositoryResearch,
} from "@/src/services/project-chat-agent-service";

describe("project chat repository intent", () => {
  it.each([
    "Pull more recent information from the repo.",
    "Inspect the GitHub repository before answering.",
    "Can you check the repo for the latest implementation?",
    "Summarize my strongest accomplishments and make sure your information is up to date.",
  ])("forces live research for %s", (question) => {
    expect(requiresLiveRepositoryResearch(question)).toBe(true);
  });

  it("does not force repository access for an ordinary memory-backed question", () => {
    expect(requiresLiveRepositoryResearch("Summarize my strongest accomplishments.")).toBe(false);
  });

  it("resolves a follow-up into a standalone research objective", () => {
    expect(
      buildStandaloneResearchQuestion({
        currentQuestion: "Pull more recent information from the repo too.",
        delegatedQuestion: "Find what changed recently.",
        history: [
          {
            id: "user-1",
            role: "user",
            content: "Summarize my strongest accomplishments.",
            citations: [],
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Earlier summary.",
            citations: [],
          },
        ],
      }),
    ).toBe(
      [
        "Prior user objective: Summarize my strongest accomplishments.",
        "Prior assistant answer: Earlier summary.",
        "Current follow-up: Pull more recent information from the repo too.",
        "Specific research request: Find what changed recently.",
      ].join("\n"),
    );
  });
});
