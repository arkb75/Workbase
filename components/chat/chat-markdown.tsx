import type { ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import type { Link, Parent, Root, Text } from "mdast";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { cn } from "@/src/lib/utils";

const citationGroupPattern = /(?:\[citation:\d+\])+/gi;
const citationPattern = /\[citation:(\d+)\]/gi;

function remarkWorkbaseCitations(options?: { maxOrdinal?: number }) {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent: Parent | undefined) => {
      if (index === undefined || !parent) return;
      const matches = Array.from(node.value.matchAll(citationGroupPattern));
      if (!matches.length) return;
      const replacement: Array<Text | Link> = [];
      let cursor = 0;
      for (const match of matches) {
        const start = match.index ?? 0;
        if (start > cursor) replacement.push({ type: "text", value: node.value.slice(cursor, start) });
        const ordinals = Array.from(match[0].matchAll(citationPattern))
          .map((entry) => Number(entry[1]))
          .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0 && (!options?.maxOrdinal || ordinal <= options.maxOrdinal));
        const unique = Array.from(new Set(ordinals));
        if (unique.length) {
          replacement.push({
            type: "link",
            url: "#",
            children: [{ type: "text", value: `[${unique.join(", ")}]` }],
            data: {
              hProperties: {
                "data-workbase-citations": unique.join(","),
              },
            },
          });
        }
        cursor = start + match[0].length;
      }
      if (cursor < node.value.length) replacement.push({ type: "text", value: node.value.slice(cursor) });
      parent.children.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}

function citationOrdinals(node: { properties?: Record<string, unknown> } | undefined) {
  const raw = node?.properties?.["data-workbase-citations"] ?? node?.properties?.dataWorkbaseCitations;
  const value = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "";
  return value.split(",").map(Number).filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0);
}

export function ChatMarkdown({
  content,
  maxCitationOrdinal,
  renderCitationGroup,
  tone = "assistant",
}: {
  content: string;
  maxCitationOrdinal: number;
  renderCitationGroup?: (ordinals: number[]) => ReactNode;
  tone?: "assistant" | "user";
}) {
  const dark = tone === "user";
  return (
    <div className={cn("chat-markdown min-w-0", dark && "chat-markdown-dark")}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, [remarkWorkbaseCitations, { maxOrdinal: maxCitationOrdinal }]]}
        urlTransform={(url) => defaultUrlTransform(url)}
        components={{
          h1: ({ children }) => <h2 className="mb-3 mt-6 text-lg font-semibold leading-7 first:mt-0">{children}</h2>,
          h2: ({ children }) => <h2 className="mb-3 mt-6 text-lg font-semibold leading-7 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-5 text-[15px] font-semibold leading-6 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-2 mt-4 text-sm font-semibold leading-6 first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="my-3 leading-7 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children, className }) => <ul className={cn("my-3 list-disc space-y-1.5 pl-5 marker:text-[color:var(--ink-muted)]", className)}>{children}</ul>,
          ol: ({ children, className }) => <ol className={cn("my-3 list-decimal space-y-1.5 pl-5 marker:text-[color:var(--ink-muted)]", className)}>{children}</ol>,
          li: ({ children, className }) => <li className={cn("pl-1 leading-7 [&>p]:my-0", className)}>{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-4 border-l-2 border-[color:var(--accent)]/35 pl-4 text-[color:var(--ink-soft)]">{children}</blockquote>,
          hr: () => <hr className="my-5 border-black/8" />,
          strong: ({ children }) => <strong className="font-semibold text-inherit">{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          del: ({ children }) => <del className="opacity-70">{children}</del>,
          code: ({ className, children, ...props }) => (
            <code
              className={cn("rounded bg-black/[0.055] px-1.5 py-0.5 font-mono text-[0.88em]", dark && "bg-white/12", className)}
              {...props}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className={cn("my-4 overflow-x-auto rounded-xl border border-black/8 bg-[#f7f7f5] p-4 text-xs leading-6", dark && "border-white/15 bg-white/8", "[&_code]:bg-transparent [&_code]:p-0")}>
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-lg border border-black/8">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className={cn("bg-black/[0.035]", dark && "bg-white/8")}>{children}</thead>,
          th: ({ children }) => <th className="border-b border-black/8 px-3 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-black/6 px-3 py-2 align-top leading-5">{children}</td>,
          img: ({ alt }) => <span className="text-xs italic opacity-70">{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>,
          a: ({ node, href, children, ...props }) => {
            const ordinals = citationOrdinals(node);
            if (ordinals.length && renderCitationGroup) return <>{renderCitationGroup(ordinals)}</>;
            const external = Boolean(href && /^https?:\/\//i.test(href));
            return (
              <a
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                className="font-medium text-[color:var(--accent)] underline decoration-[color:var(--accent)]/30 underline-offset-2 hover:decoration-current"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

export { remarkWorkbaseCitations };
