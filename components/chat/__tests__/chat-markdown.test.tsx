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
});
