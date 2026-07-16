import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "@/components/chat/chat-markdown";

describe("chat markdown renderer", () => {
  it("renders semantic markdown and replaces canonical citations with chips", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        content={"## Accomplishment\n\nBuilt **grounded chat**. [citation:1]\n\n- Durable workflows\n- `ProjectFact` memory"}
        maxCitationOrdinal={1}
        renderCitationGroup={(ordinals) => <button data-citations={ordinals.join(",")}>Sources {ordinals.join(", ")}</button>}
      />,
    );

    expect(html).toContain("<h2");
    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<code");
    expect(html).toContain('data-citations="1"');
    expect(html).not.toContain("[citation:1]");
  });

  it("preserves citation-looking text when no citation catalog exists", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        content="I typed [citation:1] literally."
        maxCitationOrdinal={0}
        renderCitationGroup={(ordinals) => <button data-citations={ordinals.join(",")}>Sources</button>}
      />,
    );

    expect(html).toContain("[citation:1]");
    expect(html).not.toContain("data-citations");
  });

  it("preserves out-of-range markers while converting valid adjacent citations", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        content="Grounded [citation:1][citation:2][citation:1]."
        maxCitationOrdinal={1}
        renderCitationGroup={(ordinals) => <button data-citations={ordinals.join(",")}>Sources</button>}
      />,
    );

    expect(html.match(/data-citations="1"/g)).toHaveLength(2);
    expect(html).toContain("[citation:2]");
  });

  it("uses visible table and divider borders in dark user messages", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        content={"---\n\n| Capability | Status |\n| --- | --- |\n| Chat | Grounded |"}
        maxCitationOrdinal={0}
        tone="user"
      />,
    );

    expect(html).toContain("border-white/15");
    expect(html).toContain("border-white/10");
  });
});
