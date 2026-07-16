import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CitationList,
  MessageContent,
  selectLatestRunFeedback,
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

  it("renders safe GitHub-flavored Markdown instead of literal syntax", () => {
    const markup = renderToStaticMarkup(createElement(MessageContent, {
      content: "## Architecture\n\n- **Durable** workflows\n- ~~Legacy~~ current behavior\n\n| Area | State |\n| --- | --- |\n| Chat | Ready |\n\n`inline`\n\n```ts\nconst ready = true\n```",
      citations: [],
      workItemId: "work-item-1",
    }));
    expect(markup).toContain("<h2");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<strong");
    expect(markup).toContain("<del");
    expect(markup).toContain("<table");
    expect(markup).toContain("<pre");
    expect(markup).not.toContain("## Architecture");
  });

  it("does not turn citation-looking text inside code into a source chip", () => {
    const markup = renderToStaticMarkup(createElement(MessageContent, {
      content: "`[citation:1]` outside [citation:1]",
      citations: [citations[0]!],
      workItemId: "work-item-1",
    }));
    expect(markup.match(/aria-label="Sources 1"/g)).toHaveLength(1);
    expect(markup).toContain("[citation:1]");
  });

  it("strips raw HTML, blocks unsafe URLs, and never fetches Markdown images", () => {
    const markup = renderToStaticMarkup(createElement(MessageContent, {
      content: "<script>alert('x')</script>\n\n[unsafe](javascript:alert(1))\n\n![diagram](https://example.com/image.png)",
      citations: [],
      workItemId: "work-item-1",
    }));
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("[Image: diagram]");
  });

  it("keeps citation navigation separate from the provenance disclosure", () => {
    const markup = renderToStaticMarkup(
      createElement(CitationList, {
        citations: [{
          id: "project-fact-citation",
          kind: "project_fact",
          label: "Repository knowledge refresh",
          excerpt: "Refreshes repository knowledge through a bounded workflow.",
          projectFactId: "project-fact-1",
          provenance: [{
            id: "provenance-1",
            title: "Knowledge refresh service",
            excerpt: "The service starts and analyzes repository refreshes.",
            path: "src/services/knowledge-refresh-service.ts",
            commitSha: "1234567890abcdef",
            url: "https://github.com/example/workbase/blob/1234567890abcdef/src/services/knowledge-refresh-service.ts#L1-L20",
          }],
        }],
        workItemId: "work-item-1",
      }),
    );

    expect(markup).toContain('href="/work-items/work-item-1?tab=highlights#project-facts"');
    expect(markup).toContain(">1. Repository knowledge refresh</a>");
    expect(markup).toContain("<summary");
    expect(markup).toContain("View underlying evidence");
    expect(markup).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<summary\b/);
  });

  it("renders immutable provenance as its own safe external link", () => {
    const provenanceUrl = "https://github.com/example/workbase/blob/1234567890abcdef/src/services/knowledge-refresh-service.ts#L1-L20";
    const markup = renderToStaticMarkup(
      createElement(CitationList, {
        citations: [{
          id: "highlight-citation",
          kind: "highlight",
          label: "Built repository refresh",
          excerpt: "Implemented repository refresh.",
          highlightId: "highlight-1",
          provenance: [{
            id: "provenance-1",
            title: "Knowledge refresh service",
            excerpt: "The refresh entrypoint is defined here.",
            path: "src/services/knowledge-refresh-service.ts",
            commitSha: "1234567890abcdef",
            url: provenanceUrl,
          }],
        }],
        workItemId: "work-item-1",
      }),
    );

    expect(markup).toContain(`href="${provenanceUrl}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("src/services/knowledge-refresh-service.ts · 12345678");
  });
});

describe("project chat run feedback", () => {
  it("clears a stale failure banner and Retry control after a successful retry", () => {
    const result = selectLatestRunFeedback([
      {
        id: "failed",
        status: "failed",
        kind: "chat_turn",
        failure: { code: "workflow_failed", stage: null, message: "failed", recovery: null, retryable: true },
      },
      { id: "success", status: "completed", kind: "chat_turn", failure: null },
    ]);

    expect(result).toEqual({ retryableRun: null, latestFailure: null });
  });
});
