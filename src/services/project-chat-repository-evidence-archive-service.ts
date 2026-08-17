import { createHash } from "node:crypto";
import { prisma } from "@/src/lib/prisma";
import {
  createProjectRepositoryRawEvidence,
  PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION,
  readProjectRepositoryEvidenceTarget,
  repositoryEvidenceTargetUrl,
} from "@/src/services/project-chat-repository-evidence-service";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

export interface ArchivedRepositoryEvidenceCitation {
  id: string;
  label: string;
  excerpt: string;
  immutableUrl: string | null;
  sourceId: string | null;
  repository: string | null;
  commitSha: string | null;
  contentHash: string | null;
  metadata: unknown;
}

export function verifyArchivedRepositoryEvidence(input: {
  citation: ArchivedRepositoryEvidenceCitation;
  payload: unknown;
}) {
  const metadata = record(input.citation.metadata);
  const payload = record(input.payload);
  if (
    !metadata ||
    !payload ||
    payload.mode !== "repository_evidence_archive" ||
    payload.version !== PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION ||
    metadata.evidenceArchiveVersion !== PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION ||
    typeof metadata.evidenceHandle !== "string" ||
    payload.evidenceId !== metadata.evidenceHandle ||
    typeof payload.sourceId !== "string" ||
    typeof payload.repository !== "string" ||
    typeof payload.commitSha !== "string" ||
    typeof payload.redactedOutput !== "string" ||
    !Array.isArray(payload.args) ||
    !payload.args.every((argument) => typeof argument === "string")
  ) return null;

  const target = readProjectRepositoryEvidenceTarget(payload.target);
  const evidence = createProjectRepositoryRawEvidence({
    sourceId: payload.sourceId,
    repository: payload.repository,
    commitSha: payload.commitSha,
    args: payload.args as string[],
    output: payload.redactedOutput,
    target,
  });
  const startLine = positiveInteger(metadata.sourceStartLine);
  const endLine = positiveInteger(metadata.sourceEndLine);
  if (
    evidence.evidenceId !== metadata.evidenceHandle ||
    evidence.outputHash !== payload.outputHash ||
    evidence.outputHash !== metadata.sourceOutputHash ||
    evidence.totalBytes !== payload.totalBytes ||
    evidence.totalBytes !== metadata.sourceOutputBytes ||
    evidence.totalLines !== payload.totalLines ||
    evidence.totalLines !== metadata.sourceTotalLines ||
    evidence.command !== metadata.sourceCommand ||
    input.citation.sourceId !== evidence.sourceId ||
    input.citation.repository !== evidence.repository ||
    input.citation.commitSha !== evidence.commitSha ||
    !startLine ||
    !endLine ||
    endLine < startLine ||
    endLine > evidence.totalLines ||
    createHash("sha256").update(input.citation.excerpt).digest("hex") !==
      input.citation.contentHash
  ) return null;

  const citedOutput = evidence.output.split("\n").slice(startLine - 1, endLine).join("\n");
  if (!citedOutput.startsWith(input.citation.excerpt)) return null;
  const targetUrl = repositoryEvidenceTargetUrl(evidence.repository, target);
  if ((input.citation.immutableUrl ?? null) !== targetUrl) return null;

  return {
    citationId: input.citation.id,
    label: input.citation.label,
    excerpt: input.citation.excerpt,
    sourceId: evidence.sourceId,
    repository: evidence.repository,
    snapshotCommitSha: evidence.commitSha,
    command: evidence.command,
    args: evidence.args,
    output: evidence.output,
    outputHash: evidence.outputHash,
    totalBytes: evidence.totalBytes,
    totalLines: evidence.totalLines,
    citedRange: { startLine, endLine },
    target,
    targetUrl,
    snapshotUrl: typeof metadata.repositorySnapshotUrl === "string"
      ? metadata.repositorySnapshotUrl
      : null,
  };
}

export async function getArchivedRepositoryEvidenceCitation(input: {
  userId: string;
  workItemId: string;
  citationId: string;
}) {
  const citation = await prisma.chatCitation.findFirst({
    where: {
      id: input.citationId,
      message: {
        thread: {
          workItemId: input.workItemId,
          userId: input.userId,
        },
      },
    },
    select: {
      id: true,
      label: true,
      excerpt: true,
      immutableUrl: true,
      sourceId: true,
      repository: true,
      commitSha: true,
      contentHash: true,
      metadata: true,
      message: { select: { agentRunId: true } },
    },
  });
  const metadata = record(citation?.metadata);
  if (!citation?.excerpt || !citation.message.agentRunId || !metadata) return null;
  const evidenceHandle = typeof metadata.evidenceHandle === "string"
    ? metadata.evidenceHandle
    : null;
  if (!evidenceHandle) return null;

  const events = await prisma.agentRunEvent.findMany({
    where: {
      agentRunId: citation.message.agentRunId,
      type: "tool_result",
      toolName: "inspect_project",
      isUserVisible: false,
    },
    orderBy: { sequence: "desc" },
    take: 40,
    select: { payload: true },
  });
  for (const event of events) {
    const payload = record(event.payload);
    if (payload?.evidenceId !== evidenceHandle) continue;
    const verified = verifyArchivedRepositoryEvidence({
      citation: {
        id: citation.id,
        label: citation.label,
        excerpt: citation.excerpt,
        immutableUrl: citation.immutableUrl,
        sourceId: citation.sourceId,
        repository: citation.repository,
        commitSha: citation.commitSha,
        contentHash: citation.contentHash,
        metadata: citation.metadata,
      },
      payload: event.payload,
    });
    if (verified) return verified;
  }
  return null;
}
