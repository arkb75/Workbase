const citationGroupPattern = /(?:\[citation:\d+\])+/gi;
const citationPattern = /\[citation:(\d+)\]/gi;
const atxHeadingPattern = /^( {0,3})(#{1,6})([ \t]+)/;
const fencePattern = /^( {0,3})(`{3,}|~{3,})/;

export interface PresentableChatCitation {
  kind: string;
  label: string;
  url?: string | null;
  highlightId?: string | null;
  projectFactId?: string | null;
  evidenceItemId?: string | null;
  artifactId?: string | null;
}

export function safeHttpUrl(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function resolveChatCitationHref(
  citation: PresentableChatCitation,
  workItemId: string,
) {
  const external = safeHttpUrl(citation.url);
  if (external) return external;

  const base = `/work-items/${encodeURIComponent(workItemId)}`;
  if (citation.highlightId) return `${base}?tab=highlights`;
  if (citation.projectFactId) return `${base}?tab=highlights#project-facts`;
  if (citation.evidenceItemId) return `${base}?tab=sources`;
  if (citation.artifactId) {
    return `${base}?tab=artifacts&artifactId=${encodeURIComponent(citation.artifactId)}`;
  }
  return null;
}

export function isExternalChatHref(href: string | null | undefined) {
  return Boolean(href && /^https?:\/\//i.test(href));
}

function normalizeAtxHeadingDepth(markdown: string) {
  const lines = markdown.split("\n");
  let activeFence: "`" | "~" | null = null;
  let minimumDepth = 7;

  for (const line of lines) {
    const fence = line.match(fencePattern);
    if (fence) {
      const marker = fence[2]?.[0] as "`" | "~";
      activeFence = activeFence === marker ? null : activeFence ?? marker;
      continue;
    }
    if (activeFence) continue;
    const heading = line.match(atxHeadingPattern);
    if (heading) minimumDepth = Math.min(minimumDepth, heading[2]!.length);
  }

  if (minimumDepth === 7 || minimumDepth === 2) return markdown;
  const offset = 2 - minimumDepth;
  activeFence = null;
  return lines.map((line) => {
    const fence = line.match(fencePattern);
    if (fence) {
      const marker = fence[2]?.[0] as "`" | "~";
      activeFence = activeFence === marker ? null : activeFence ?? marker;
      return line;
    }
    if (activeFence) return line;
    return line.replace(atxHeadingPattern, (_match, indent: string, hashes: string, spacing: string) => {
      const depth = Math.max(2, Math.min(6, hashes.length + offset));
      return `${indent}${"#".repeat(depth)}${spacing}`;
    });
  }).join("\n");
}

function compactCitationMarkers(markdown: string, citationCount: number) {
  return markdown
    .replace(citationGroupPattern, (group) => {
      const ordinals = Array.from(group.matchAll(citationPattern))
        .map((match) => Number(match[1]))
        .filter((ordinal) => Number.isInteger(ordinal) && ordinal > 0 && ordinal <= citationCount);
      const unique = Array.from(new Set(ordinals));
      return unique.length ? `[${unique.join(", ")}]` : "";
    })
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n");
}

function escapeMarkdownLabel(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\s+/g, " ")
    .trim();
}

function readableKind(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function markdownDestination(value: string) {
  return `<${value.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}

export function buildChatClipboardPayload(input: {
  content: string;
  citations: readonly PresentableChatCitation[];
  workItemId: string;
}) {
  const answer = normalizeAtxHeadingDepth(
    compactCitationMarkers(input.content.trim(), input.citations.length),
  );
  const sources = input.citations.map((citation, index) => {
    const label = escapeMarkdownLabel(citation.label) || `Source ${index + 1}`;
    const href = resolveChatCitationHref(citation, input.workItemId);
    const source = href ? `[${label}](${markdownDestination(href)})` : label;
    return `${index + 1}. ${source} — ${readableKind(citation.kind)}`;
  });
  const markdown = [
    answer,
    sources.length ? `## Sources\n\n${sources.join("\n")}` : null,
  ].filter(Boolean).join("\n\n").trim();

  // The explicit Copy Markdown action intentionally writes the same canonical
  // representation to both MIME types. Destinations that understand Markdown
  // retain structure; plain-text destinations still receive readable content
  // without rendered-HTML styling or private citation marker syntax.
  return {
    markdown,
    plainText: markdown,
  };
}
