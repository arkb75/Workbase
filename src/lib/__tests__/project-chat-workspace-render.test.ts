import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MessageContent,
  type ChatWorkspaceCitation,
} from "@/components/chat/project-chat-workspace";

const citations: ChatWorkspaceCitation[] = [1, 2].map((ordinal) => ({
  id: `citation-${ordinal}`,
  kind: "evidence",
  label: `Evidence ${ordinal}`,
  excerpt: "Grounded evidence.",
  evidenceItemId: `evidence-${ordinal}`,
  provenance: [],
}));

describe("project chat citation rendering", () => {
  it("renders adjacent citations as a semantic, copyable group", () => {
    const markup = renderToStaticMarkup(
      createElement(MessageContent, {
        content: "Grounded claim [citation:1][citation:2].",
        citations,
        workItemId: "work-item-1",
      }),
    );
    const text = markup.replace(/<[^>]+>/g, "");

    expect(markup).toContain('aria-label="Sources 1, 2"');
    expect(text).toContain("Grounded claim [1, 2].");
    expect(text).not.toContain("Grounded claim 12");
  });
});
