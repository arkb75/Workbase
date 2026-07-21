import { describe, expect, it } from "vitest";
import { buildRollingConversationSummary } from "@/src/services/project-chat-store";

describe("project chat rolling conversation summary", () => {
  it("retains opening decisions, recent context, and used-source manifests within a fixed budget", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 0
        ? "Earlier decision: repository discoveries must become reviewed durable memory before ordinary chat can reuse them."
        : index === 39
          ? "Current runtime decision: use the bounded Bedrock loop inside the durable workflow boundary."
          : `Filler turn ${index + 1}: ${"implementation context ".repeat(90)}`,
      citations: index === 1
        ? [{ kind: "project_fact", label: "Repository discovery admission policy" }]
        : [],
    }));

    const summary = buildRollingConversationSummary(messages, 6_000);

    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(6_000);
    expect(summary).toContain("Earlier decision: repository discoveries");
    expect(summary).toContain("Current runtime decision");
    expect(summary).toContain("project_fact:Repository discovery admission policy");
    expect(summary).toMatch(/older message\(s\) omitted/);
  });

  it("returns null when no older messages exist", () => {
    expect(buildRollingConversationSummary([])).toBeNull();
  });
});
