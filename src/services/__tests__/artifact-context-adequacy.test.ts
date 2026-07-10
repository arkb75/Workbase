import { describe, expect, it } from "vitest";
import { artifactContextAdequacy } from "@/src/services/highlight-retrieval-service";

function highlight(input: { text: string; summary: string; domain: string }) {
  return {
    text: input.text,
    summary: input.summary,
    tags: [{ dimension: "domain", tag: input.domain, score: 1 }],
  } as never;
}

describe("artifact context adequacy", () => {
  it("accepts approved context that covers the brief and requested angle", () => {
    const result = artifactContextAdequacy({
      request: {
        userId: "user-1",
        workItemId: "work-1",
        type: "resume_bullets",
        targetAngle: "backend",
        tone: "technical",
        brief: "Emphasize queue architecture and latency impact.",
      },
      highlights: [
        highlight({
          text: "Designed the queue architecture and reduced latency.",
          summary: "Backend queue ownership and impact.",
          domain: "backend",
        }),
      ],
    });

    expect(result.status).toBe("sufficient");
    expect(result.coverageGaps).toEqual([]);
  });

  it("requires research when an approved highlight is unrelated", () => {
    const result = artifactContextAdequacy({
      request: {
        userId: "user-1",
        workItemId: "work-1",
        type: "resume_bullets",
        targetAngle: "backend",
        tone: "technical",
        brief: "Emphasize queue architecture and latency impact.",
      },
      highlights: [
        highlight({
          text: "Built a responsive design system.",
          summary: "Frontend component styling.",
          domain: "full_stack",
        }),
      ],
    });

    expect(result.status).toBe("needs_research");
    expect(result.coverageGaps.length).toBeGreaterThan(0);
  });
});
