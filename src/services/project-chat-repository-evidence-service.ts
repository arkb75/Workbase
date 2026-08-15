import { createHash } from "node:crypto";

export const PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION =
  "project-chat-repository-evidence-v1";

export interface ProjectRepositoryRawEvidence {
  evidenceId: string;
  sourceId: string;
  repository: string;
  commitSha: string;
  args: string[];
  command: string;
  output: string;
  outputHash: string;
  totalBytes: number;
  totalLines: number;
}

export interface ProjectRepositoryEvidenceSegment {
  evidenceId: string;
  segmentId: string;
  sourceId: string;
  repository: string;
  commitSha: string;
  args: string[];
  command: string;
  excerpt: string;
  excerptHash: string;
  outputHash: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  totalBytes: number;
  truncated: boolean;
}

const ignoredTerms = new Set([
  "about",
  "after",
  "against",
  "before",
  "between",
  "commit",
  "current",
  "does",
  "from",
  "have",
  "into",
  "project",
  "repository",
  "show",
  "that",
  "their",
  "these",
  "this",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function normalizeOutput(value: string) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function truncateUtf8(value: string, maximumBytes: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function evidenceTerms(input: { objective: string; args: readonly string[] }) {
  const raw = [input.objective, ...input.args.filter((argument) => !argument.startsWith("-"))]
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9_.:/-]{2,}/g) ?? [];
  return Array.from(new Set(raw.flatMap((term) =>
    term
      .split(/[/:]/)
      .map((part) => part.replace(/^[-.]+|[-.]+$/g, ""))
      .filter((part) =>
        part.length >= 3 &&
        !ignoredTerms.has(part) &&
        !/^[a-f0-9]{12,64}$/.test(part)
      )
  ))).slice(0, 32);
}

function lineScore(line: string, terms: readonly string[]) {
  const normalized = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += term.includes(".") || term.includes("-") ? 4 : 2;
  }
  if (/^(?:commit |diff --git |@@ |[+\-]{3} )/.test(line)) score += 1;
  if (/^[^\s:]+:\d+(?::\d+)?:/.test(line)) score += 2;
  return score;
}

function segmentId(evidenceId: string, startLine: number, endLine: number, excerpt: string) {
  return createHash("sha256")
    .update(`${evidenceId}:${startLine}:${endLine}:`)
    .update(excerpt)
    .digest("hex")
    .slice(0, 24);
}

function buildSegment(input: {
  evidence: ProjectRepositoryRawEvidence;
  lines: readonly string[];
  startIndex: number;
  endIndex: number;
  maximumBytes: number;
}): ProjectRepositoryEvidenceSegment | null {
  const unbounded = input.lines.slice(input.startIndex, input.endIndex + 1).join("\n");
  const excerpt = truncateUtf8(unbounded, input.maximumBytes).trimEnd();
  if (!excerpt) return null;
  const excerptLineCount = excerpt.split("\n").length;
  const startLine = input.startIndex + 1;
  const endLine = Math.min(input.endIndex + 1, startLine + excerptLineCount - 1);
  return {
    evidenceId: input.evidence.evidenceId,
    segmentId: segmentId(input.evidence.evidenceId, startLine, endLine, excerpt),
    sourceId: input.evidence.sourceId,
    repository: input.evidence.repository,
    commitSha: input.evidence.commitSha,
    args: [...input.evidence.args],
    command: input.evidence.command,
    excerpt,
    excerptHash: createHash("sha256").update(excerpt).digest("hex"),
    outputHash: input.evidence.outputHash,
    startLine,
    endLine,
    totalLines: input.evidence.totalLines,
    totalBytes: input.evidence.totalBytes,
    truncated:
      startLine !== 1 ||
      endLine !== input.evidence.totalLines ||
      Buffer.byteLength(excerpt, "utf8") < Buffer.byteLength(unbounded, "utf8"),
  };
}

export function createProjectRepositoryRawEvidence(input: {
  sourceId: string;
  repository: string;
  commitSha: string;
  args: string[];
  output: string;
}): ProjectRepositoryRawEvidence {
  const output = normalizeOutput(input.output);
  const outputHash = createHash("sha256").update(output).digest("hex");
  const evidenceId = createHash("sha256")
    .update(PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION)
    .update(input.sourceId)
    .update(input.commitSha)
    .update(JSON.stringify(input.args))
    .update(outputHash)
    .digest("hex")
    .slice(0, 32);
  return {
    evidenceId,
    sourceId: input.sourceId,
    repository: input.repository,
    commitSha: input.commitSha,
    args: [...input.args],
    command: `git ${input.args.join(" ")}`,
    output,
    outputHash,
    totalBytes: Buffer.byteLength(output, "utf8"),
    totalLines: output ? output.split("\n").length : 0,
  };
}

/**
 * Produces exact source slices rather than an abstractive summary. The first
 * slice preserves command context; remaining slices favor question-relevant
 * lines while retaining their original order and immutable output offsets.
 */
export function compactProjectRepositoryEvidence(input: {
  evidence: ProjectRepositoryRawEvidence;
  objective: string;
  maximumBytes: number;
  maximumSegments: number;
  contextLines?: number;
}) {
  const lines = input.evidence.output.split("\n");
  if (!input.evidence.output) return [] as ProjectRepositoryEvidenceSegment[];
  if (input.evidence.totalBytes <= input.maximumBytes) {
    return [buildSegment({
      evidence: input.evidence,
      lines,
      startIndex: 0,
      endIndex: lines.length - 1,
      maximumBytes: input.maximumBytes,
    })].filter((segment): segment is ProjectRepositoryEvidenceSegment => Boolean(segment));
  }

  const terms = evidenceTerms({ objective: input.objective, args: input.evidence.args });
  const contextLines = input.contextLines ?? 18;
  const scored = lines
    .map((line, index) => ({ index, score: lineScore(line, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const centers = [0];
  for (const entry of scored) {
    if (centers.length >= input.maximumSegments) break;
    if (centers.every((center) => Math.abs(center - entry.index) > contextLines)) {
      centers.push(entry.index);
    }
  }
  if (centers.length < input.maximumSegments && lines.length > contextLines * 3) {
    for (const fallback of [Math.floor(lines.length / 2), lines.length - 1]) {
      if (centers.length >= input.maximumSegments) break;
      if (centers.every((center) => Math.abs(center - fallback) > contextLines)) {
        centers.push(fallback);
      }
    }
  }

  const windows = centers
    .map((center) => ({
      startIndex: Math.max(0, center - contextLines),
      endIndex: Math.min(lines.length - 1, center + contextLines),
    }))
    .sort((left, right) => left.startIndex - right.startIndex)
    .filter((window, index, all) =>
      index === 0 || window.startIndex > all[index - 1]!.endIndex
    );
  const bytesPerSegment = Math.max(1_024, Math.floor(input.maximumBytes / windows.length));
  let remaining = input.maximumBytes;
  const segments: ProjectRepositoryEvidenceSegment[] = [];
  for (const window of windows) {
    if (remaining <= 0) break;
    const segment = buildSegment({
      evidence: input.evidence,
      lines,
      ...window,
      maximumBytes: Math.min(bytesPerSegment, remaining),
    });
    if (!segment) continue;
    segments.push(segment);
    remaining -= Buffer.byteLength(segment.excerpt, "utf8");
  }
  return segments;
}

export function expandProjectRepositoryEvidence(input: {
  evidence: ProjectRepositoryRawEvidence;
  startLine: number;
  maximumLines: number;
  maximumBytes: number;
}) {
  const lines = input.evidence.output.split("\n");
  const startIndex = Math.max(0, Math.min(lines.length - 1, input.startLine - 1));
  const endIndex = Math.min(lines.length - 1, startIndex + input.maximumLines - 1);
  return buildSegment({
    evidence: input.evidence,
    lines,
    startIndex,
    endIndex,
    maximumBytes: input.maximumBytes,
  });
}
