import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectRepositoryRawEvidence,
  PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION,
  repositoryEvidenceTargetUrl,
} from "@/src/services/project-chat-repository-evidence-service";

const { findCitation, findEvents } = vi.hoisted(() => ({
  findCitation: vi.fn(),
  findEvents: vi.fn(),
}));

vi.mock("@/src/lib/prisma", () => ({
  prisma: {
    chatCitation: { findFirst: findCitation },
    agentRunEvent: { findMany: findEvents },
  },
}));

import {
  getArchivedRepositoryEvidenceCitation,
  verifyArchivedRepositoryEvidence,
} from "@/src/services/project-chat-repository-evidence-archive-service";

function fixture() {
  const target = { kind: "commit" as const, commitSha: "1".repeat(40) };
  const evidence = createProjectRepositoryRawEvidence({
    sourceId: "source-1",
    repository: "acme/ledger",
    commitSha: "2".repeat(40),
    args: ["show", "--stat", target.commitSha],
    output: "commit one\nAuthor: Ada\ncleanup generated code",
    target,
  });
  const excerpt = "Author: Ada\ncleanup generated code";
  const metadata = {
    evidenceHandle: evidence.evidenceId,
    evidenceArchiveVersion: PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION,
    evidenceTarget: target,
    repositorySnapshotUrl: `https://github.com/acme/ledger/commit/${evidence.commitSha}`,
    sourceOutputHash: evidence.outputHash,
    sourceOutputBytes: evidence.totalBytes,
    sourceCommand: evidence.command,
    sourceStartLine: 2,
    sourceEndLine: 3,
    sourceTotalLines: evidence.totalLines,
    truncated: true,
  };
  const citation = {
    id: "citation-1",
    label: "Historical cleanup",
    excerpt,
    immutableUrl: repositoryEvidenceTargetUrl(evidence.repository, target),
    sourceId: evidence.sourceId,
    repository: evidence.repository,
    commitSha: evidence.commitSha,
    contentHash: createHash("sha256").update(excerpt).digest("hex"),
    metadata,
  };
  const payload = {
    mode: "repository_evidence_archive",
    version: PROJECT_CHAT_REPOSITORY_EVIDENCE_VERSION,
    evidenceId: evidence.evidenceId,
    sourceId: evidence.sourceId,
    repository: evidence.repository,
    commitSha: evidence.commitSha,
    args: evidence.args,
    command: evidence.command,
    target,
    redactedOutput: evidence.output,
    outputHash: evidence.outputHash,
    totalBytes: evidence.totalBytes,
    totalLines: evidence.totalLines,
  };
  return { citation, payload, evidence, target };
}

describe("repository evidence archive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores an exact historical target while retaining the separate inspected snapshot", () => {
    const { citation, payload, target, evidence } = fixture();
    const verified = verifyArchivedRepositoryEvidence({ citation, payload });
    expect(verified).toMatchObject({
      target,
      targetUrl: `https://github.com/acme/ledger/commit/${target.commitSha}`,
      snapshotCommitSha: evidence.commitSha,
      snapshotUrl: `https://github.com/acme/ledger/commit/${evidence.commitSha}`,
      citedRange: { startLine: 2, endLine: 3 },
    });
    expect(verified?.targetUrl).not.toBe(verified?.snapshotUrl);
  });

  it("rejects output, range, hash, and canonical-target tampering", () => {
    const { citation, payload } = fixture();
    expect(verifyArchivedRepositoryEvidence({
      citation,
      payload: { ...payload, redactedOutput: `${payload.redactedOutput}\nforged` },
    })).toBeNull();
    expect(verifyArchivedRepositoryEvidence({
      citation: { ...citation, metadata: { ...citation.metadata, sourceStartLine: 1 } },
      payload,
    })).toBeNull();
    expect(verifyArchivedRepositoryEvidence({
      citation: { ...citation, immutableUrl: `https://github.com/acme/ledger/commit/${"f".repeat(40)}` },
      payload,
    })).toBeNull();
  });

  it("scopes lookup to the authenticated user and requested Work Item", async () => {
    const { citation, payload } = fixture();
    findCitation.mockResolvedValue({ ...citation, message: { agentRunId: "run-1" } });
    findEvents.mockResolvedValue([{ payload }]);

    await expect(getArchivedRepositoryEvidenceCitation({
      userId: "user-1",
      workItemId: "work-1",
      citationId: citation.id,
    })).resolves.toMatchObject({ citationId: citation.id });
    expect(findCitation).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: citation.id,
        message: { thread: { workItemId: "work-1", userId: "user-1" } },
      },
    }));
  });
});
