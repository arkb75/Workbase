import type { EvidenceItemType } from "@/src/lib/options";
import { normalizeWhitespace } from "@/src/lib/utils";

const DEFAULT_PROMPT_EXCERPT_CHARS = 320;
const README_PROMPT_EXCERPT_CHARS = 520;

function truncateAtWordBoundary(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  const truncated = value.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace >= Math.floor(maxChars * 0.6)) {
    return `${truncated.slice(0, lastSpace).trim()}…`;
  }

  return `${truncated.trim()}…`;
}

function summarizeReadmeContent(markdown: string) {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const highSignalLines = lines.filter((line) => {
    if (/^#{1,3}\s+/.test(line) || /^[-*]\s+/.test(line)) {
      return true;
    }

    return /\b(tech stack|core product flows|project structure|data layer|ml|model|api|next\.js|react|typescript|dynamodb|prisma|aws|messaging|feed|ranking|uploads)\b/i.test(
      line,
    );
  });

  const selectedLines = (highSignalLines.length ? highSignalLines : lines)
    .map((line) =>
      normalizeWhitespace(
        line
          .replace(/^#{1,3}\s+/, "")
          .replace(/^[-*]\s+/, "")
          .replace(/`/g, ""),
      ),
    )
    .filter(Boolean)
    .slice(0, 10);

  return truncateAtWordBoundary(
    normalizeWhitespace(selectedLines.join(" | ")),
    README_PROMPT_EXCERPT_CHARS,
  );
}

export function compressEvidenceContentForPrompt(params: {
  evidenceType: EvidenceItemType;
  title: string;
  content: string;
}) {
  if (params.evidenceType === "github_readme") {
    return summarizeReadmeContent(params.content);
  }

  return truncateAtWordBoundary(
    normalizeWhitespace(params.content),
    DEFAULT_PROMPT_EXCERPT_CHARS,
  );
}

export function buildPromptReadyEvidenceExcerpt(params: {
  evidenceType: EvidenceItemType;
  title: string;
  content: string;
}) {
  const compressedContent = compressEvidenceContentForPrompt(params);
  const normalizedTitle = normalizeWhitespace(params.title);

  if (!normalizedTitle) {
    return compressedContent;
  }

  const titlePrefix = normalizedTitle.endsWith(":")
    ? normalizedTitle
    : `${normalizedTitle}:`;
  const withTitle = `${titlePrefix} ${compressedContent}`.trim();

  return truncateAtWordBoundary(
    normalizeWhitespace(withTitle),
    params.evidenceType === "github_readme"
      ? README_PROMPT_EXCERPT_CHARS
      : DEFAULT_PROMPT_EXCERPT_CHARS,
  );
}
