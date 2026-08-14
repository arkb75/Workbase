import { Prisma } from "@/src/generated/prisma/client";
import type {
  AnswerCitationPolicy,
  FinalizedChatAnswer,
  ProjectKnowledgeCitation,
} from "@/src/domain/project-chat";
import {
  publicArtifactVisibilityRules,
  type ArtifactType,
  type VisibilityLevel,
} from "@/src/lib/options";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { looksLikeArtifactRequest } from "@/src/services/artifact-brief-service";
import { assertAnswerCitationContract } from "@/src/services/chat-citation-service";
import {
  completeProjectResearchDossier,
  parseProjectResearchDossier,
} from "@/src/services/project-research-dossier-service";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

interface RollingSummaryMessage {
  id: string;
  role: string;
  content: string;
  citations?: Array<{ kind: string; label: string }>;
}

function compactRollingSummaryLine(message: RollingSummaryMessage) {
  const content = normalizeWhitespace(
    message.content
      .replace(/\[citation:\d+\]/gi, "")
      .replace(/```[\s\S]*?```/g, " [code omitted] "),
  );
  const compactContent = content.length > 280
    ? `${content.slice(0, 277).trimEnd()}…`
    : content;
  const sourceManifest = (message.citations ?? [])
    .slice(0, 3)
    .map((citation) =>
      `${normalizeWhitespace(citation.kind).slice(0, 40)}:${normalizeWhitespace(citation.label).slice(0, 100)}`
    );
  return [
    `${message.role} (${message.id}): ${compactContent || "[empty message]"}`,
    sourceManifest.length ? `used sources: ${sourceManifest.join("; ")}` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * Preserves both the thread's opening objective/decisions and its most recent
 * older turns inside a fixed prompt budget. Each assistant entry carries only
 * the high-level type/title manifest of sources the answer actually used.
 */
export function buildRollingConversationSummary(
  messages: RollingSummaryMessage[],
  maxCharacters = 6_000,
) {
  if (!messages.length || maxCharacters <= 0) return null;
  const lines = messages.map(compactRollingSummaryLine);
  const selected = new Set<number>();
  const openingCount = Math.min(2, lines.length);
  for (let index = 0; index < openingCount; index += 1) selected.add(index);

  const render = () => {
    const indexes = Array.from(selected).sort((left, right) => left - right);
    const output: string[] = [];
    indexes.forEach((index, position) => {
      const previous = indexes[position - 1];
      if (previous !== undefined && index > previous + 1) {
        output.push(`… ${index - previous - 1} older message(s) omitted from the compact summary …`);
      }
      output.push(lines[index]!);
    });
    return output.join("\n");
  };

  for (let index = lines.length - 1; index >= openingCount; index -= 1) {
    selected.add(index);
    if (render().length > maxCharacters) selected.delete(index);
  }
  const rendered = render();
  return rendered.length <= maxCharacters
    ? rendered
    : `${rendered.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`;
}

export function buildChatCitationRows(messageId: string, citations: ProjectKnowledgeCitation[]) {
  return citations.map((citation, index) => ({
    messageId,
    kind: citation.kind,
    ordinal: index + 1,
    highlightId: citation.highlightId ?? null,
    projectFactId: citation.projectFactId ?? null,
    evidenceItemId: citation.evidenceItemId ?? null,
    artifactId: citation.artifactId ?? null,
    sourceId: citation.sourceId ?? null,
    label: citation.label.slice(0, 300),
    excerpt: citation.excerpt.slice(0, 2_000),
    immutableUrl: citation.url ?? null,
    repository: citation.repository ?? null,
    commitSha: citation.commitSha ?? null,
    blobSha: citation.blobSha ?? null,
    path: citation.path ?? null,
    startLine: citation.startLine ?? null,
    endLine: citation.endLine ?? null,
    contentHash: citation.contentHash ?? null,
    metadata: citation.redacted || citation.redactionCategories?.length || citation.provenance?.length
      ? toInputJson({
          redacted: citation.redacted ?? false,
          redactionCategories: citation.redactionCategories ?? [],
          // Snapshot nested provenance at answer time so later fact edits cannot
          // silently rewrite the historical source panel.
          provenance: citation.provenance ?? [],
        })
      : Prisma.JsonNull,
  }));
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function mergeCompletedRunResult(input: {
  existing: unknown;
  next: unknown;
  researchState: unknown;
  environmentSnapshot: unknown;
}) {
  const existing = record(input.existing) ?? {};
  const next = record(input.next) ?? {};
  const dossier = parseProjectResearchDossier(input.researchState, input.environmentSnapshot);
  return {
    ...existing,
    ...next,
    partial: Boolean(existing.partial || next.partial || dossier?.partial),
    coverageGaps: Array.from(new Set([
      ...stringArray(existing.coverageGaps),
      ...stringArray(next.coverageGaps),
      ...(dossier?.coverageGaps ?? []),
    ])),
    warnings: Array.from(new Set([
      ...stringArray(existing.warnings),
      ...stringArray(next.warnings),
      ...(dossier?.warnings ?? []),
    ])),
    exploredEvidenceCount: Math.max(
      typeof existing.exploredEvidenceCount === "number" ? existing.exploredEvidenceCount : 0,
      typeof next.exploredEvidenceCount === "number" ? next.exploredEvidenceCount : 0,
      dossier?.notebook?.citations.length ?? 0,
    ),
    ...(dossier ? {
      research: {
        repositories: dossier.repositories,
        coverage: dossier.coverage,
        coverageGaps: dossier.coverageGaps,
        warnings: dossier.warnings,
        partial: dossier.partial,
        usage: dossier.usage,
        candidateIds: dossier.candidateIds,
        exploredEvidenceCount: dossier.notebook?.citations.length ?? 0,
        researchedAt: dossier.researchedAt,
      },
    } : {}),
  };
}

const ARTIFACT_PROVENANCE_CHANGED_MESSAGE =
  "The artifact was not published because its approved source context changed before finalization. Review the affected Highlights and Evidence, then retry.";

type ArtifactFinalizationProvenanceResult =
  | { eligible: true }
  | { eligible: false; message: string };

/**
 * Locks and revalidates the complete public-Artifact authority graph in the
 * same transaction that publishes the Artifact. The earlier workflow check
 * protects the verifier input; this fence protects the verifier-to-publish
 * interval, where review or reconciliation may have changed durable memory.
 */
async function revalidateArtifactFinalizationProvenance(
  tx: Prisma.TransactionClient,
  input: {
    artifactId: string;
    runId: string;
    workItemId: string;
  },
): Promise<ArtifactFinalizationProvenanceResult> {
  const artifacts = await tx.$queryRaw<Array<{
    id: string;
    type: string;
    lifecycleStatus: string;
    publicSafetyStatus: string;
    workItemId: string | null;
    originatingAgentRunId: string | null;
  }>>`
    SELECT
      "id",
      "type"::text AS "type",
      "lifecycleStatus"::text AS "lifecycleStatus",
      "publicSafetyStatus"::text AS "publicSafetyStatus",
      "workItemId",
      "originatingAgentRunId"
    FROM "Artifact"
    WHERE "id" = ${input.artifactId}
    FOR UPDATE
  `;
  const artifact = artifacts[0];
  if (
    !artifact ||
    artifact.workItemId !== input.workItemId ||
    artifact.originatingAgentRunId !== input.runId ||
    !["quarantined", "active"].includes(artifact.lifecycleStatus) ||
    artifact.publicSafetyStatus !== "verified" ||
    !(artifact.type in publicArtifactVisibilityRules)
  ) {
    return {
      eligible: false,
      message:
        "The artifact was not published because its verified draft is no longer eligible for this project run. Retry generation from current approved context.",
    };
  }

  // Lock the immutable-at-publication dependency lists before locking their
  // live entities. This prevents provenance rows from being removed or added
  // while the final eligibility decision is made.
  const highlightProvenance = await tx.$queryRaw<Array<{
    id: string;
    highlightId: string | null;
  }>>`
    SELECT "id", "highlightId"
    FROM "ArtifactHighlightProvenance"
    WHERE "artifactId" = ${input.artifactId}
    FOR UPDATE
  `;
  const evidenceProvenance = await tx.$queryRaw<Array<{
    id: string;
    evidenceItemId: string | null;
  }>>`
    SELECT "id", "evidenceItemId"
    FROM "ArtifactEvidenceProvenance"
    WHERE "artifactId" = ${input.artifactId}
    FOR UPDATE
  `;

  const highlights = await tx.$queryRaw<Array<{
    id: string;
    verificationStatus: string;
    lifecycleStatus: string;
    publicSafetyStatus: string;
    sensitivityFlag: boolean;
    visibility: string;
  }>>`
    SELECT
      "id",
      "verificationStatus"::text AS "verificationStatus",
      "lifecycleStatus"::text AS "lifecycleStatus",
      "publicSafetyStatus"::text AS "publicSafetyStatus",
      "sensitivityFlag",
      "visibility"::text AS "visibility"
    FROM "Claim"
    WHERE "id" IN (
      SELECT "highlightId"
      FROM "ArtifactHighlightProvenance"
      WHERE "artifactId" = ${input.artifactId}
        AND "highlightId" IS NOT NULL
    )
    FOR UPDATE
  `;
  const expectedHighlightIds = new Set(
    highlightProvenance.flatMap((entry) => entry.highlightId ? [entry.highlightId] : []),
  );
  const allowedVisibilities = new Set<VisibilityLevel>(
    publicArtifactVisibilityRules[artifact.type as ArtifactType],
  );
  if (
    highlightProvenance.length === 0 ||
    expectedHighlightIds.size !== highlightProvenance.length ||
    highlights.length !== expectedHighlightIds.size ||
    highlights.some((highlight) =>
      highlight.verificationStatus !== "approved" ||
      highlight.lifecycleStatus !== "active" ||
      highlight.publicSafetyStatus !== "verified" ||
      highlight.sensitivityFlag ||
      !allowedVisibilities.has(highlight.visibility as VisibilityLevel)
    )
  ) {
    return {
      eligible: false,
      message:
        "The artifact was not published because a supporting Highlight is no longer active, approved, non-sensitive, public-safe, and visibility-compatible. Review the source Highlights, then retry.",
    };
  }

  const evidence = await tx.$queryRaw<Array<{
    id: string;
    included: boolean;
    lifecycleStatus: string;
  }>>`
    SELECT
      "id",
      "included",
      "lifecycleStatus"::text AS "lifecycleStatus"
    FROM "EvidenceItem"
    WHERE "id" IN (
      SELECT "evidenceItemId"
      FROM "ArtifactEvidenceProvenance"
      WHERE "artifactId" = ${input.artifactId}
        AND "evidenceItemId" IS NOT NULL
    )
    FOR UPDATE
  `;
  const expectedEvidenceIds = new Set(
    evidenceProvenance.flatMap((entry) => entry.evidenceItemId ? [entry.evidenceItemId] : []),
  );
  if (
    expectedEvidenceIds.size !== evidenceProvenance.length ||
    evidence.length !== expectedEvidenceIds.size ||
    evidence.some((item) => !item.included || item.lifecycleStatus !== "active")
  ) {
    return {
      eligible: false,
      message:
        "The artifact was not published because supporting Evidence is no longer included and active. Review the source Evidence, then retry.",
    };
  }

  // Lock the exact live Highlight↔Evidence edges used to authorize every
  // persisted Evidence dependency. A source that is still active but was
  // detached from all used Highlights can no longer justify publication.
  const liveLinks = expectedEvidenceIds.size
    ? await tx.$queryRaw<Array<{
        highlightId: string;
        evidenceItemId: string;
      }>>`
        SELECT "highlightId", "evidenceItemId"
        FROM "HighlightEvidence"
        WHERE "highlightId" IN (
          SELECT "highlightId"
          FROM "ArtifactHighlightProvenance"
          WHERE "artifactId" = ${input.artifactId}
            AND "highlightId" IS NOT NULL
        )
          AND "evidenceItemId" IN (
            SELECT "evidenceItemId"
            FROM "ArtifactEvidenceProvenance"
            WHERE "artifactId" = ${input.artifactId}
              AND "evidenceItemId" IS NOT NULL
          )
        FOR UPDATE
      `
    : [];
  const linkedEvidenceIds = new Set(liveLinks.map((link) => link.evidenceItemId));
  if ([...expectedEvidenceIds].some((evidenceItemId) => !linkedEvidenceIds.has(evidenceItemId))) {
    return {
      eligible: false,
      message:
        "The artifact was not published because supporting Evidence is no longer linked to any of the used Highlights. Review the Highlight provenance, then retry.",
    };
  }

  return { eligible: true };
}

export async function createProjectChatThread(input: {
  userId: string;
  workItemId: string;
  title?: string;
}) {
  await prisma.workItem.findFirstOrThrow({
    where: {
      id: input.workItemId,
      userId: input.userId,
    },
    select: { id: true },
  });

  return prisma.chatThread.create({
    data: {
      userId: input.userId,
      workItemId: input.workItemId,
      title: input.title?.trim().slice(0, 80) || "New conversation",
    },
  });
}

export async function renameProjectChatThread(input: {
  userId: string;
  workItemId: string;
  threadId: string;
  title: string;
}) {
  return prisma.chatThread.updateMany({
    where: {
      id: input.threadId,
      workItemId: input.workItemId,
      userId: input.userId,
      archivedAt: null,
    },
    data: {
      title: normalizeWhitespace(input.title).slice(0, 80) || "Conversation",
    },
  });
}

export async function archiveProjectChatThread(input: {
  userId: string;
  workItemId: string;
  threadId: string;
}) {
  return prisma.chatThread.updateMany({
    where: {
      id: input.threadId,
      workItemId: input.workItemId,
      userId: input.userId,
    },
    data: {
      archivedAt: new Date(),
    },
  });
}

export async function createProjectChatRun(input: {
  userId: string;
  workItemId: string;
  threadId: string;
  message: string;
  idempotencyKey: string;
  kind?: "chat_turn" | "artifact_workflow";
}) {
  const message = normalizeWhitespace(input.message).slice(0, 4_000);

  if (message.length < 2) {
    throw new Error("A chat message must contain at least two characters.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "ChatThread"
      WHERE "id" = ${input.threadId}
        AND "workItemId" = ${input.workItemId}
        AND "userId" = ${input.userId}
        AND "archivedAt" IS NULL
      FOR UPDATE
    `;
    const thread = await tx.chatThread.findFirstOrThrow({
      where: {
        id: input.threadId,
        workItemId: input.workItemId,
        userId: input.userId,
        archivedAt: null,
      },
    });
    const existingRun = await tx.agentRun.findUnique({
      where: {
        userId_idempotencyKey: {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });

    if (existingRun) {
      return existingRun;
    }
    const activeRun = await tx.agentRun.findFirst({
      where: {
        threadId: thread.id,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      select: { id: true },
    });
    if (activeRun) {
      throw new Error("Finish or cancel the active thread run before sending another message.");
    }

    const sequence =
      (
        await tx.chatMessage.aggregate({
          where: { threadId: thread.id },
          _max: { sequence: true },
        })
      )._max.sequence ?? 0;
    const kind =
      input.kind ?? (looksLikeArtifactRequest(message) ? "artifact_workflow" : "chat_turn");
    const run = await tx.agentRun.create({
      data: {
        userId: input.userId,
        workItemId: input.workItemId,
        threadId: thread.id,
        idempotencyKey: input.idempotencyKey,
        kind,
        request: toInputJson({ message, brief: kind === "artifact_workflow" ? message : null }),
      },
    });

    await tx.chatMessage.createMany({
      data: [
        {
          threadId: thread.id,
          agentRunId: run.id,
          sequence: sequence + 1,
          role: "user",
          status: "completed",
          content: message,
        },
        {
          threadId: thread.id,
          agentRunId: run.id,
          sequence: sequence + 2,
          role: "assistant",
          status: "queued",
          content: "",
        },
      ],
    });

    if (thread.title === "New conversation") {
      await tx.chatThread.update({
        where: { id: thread.id },
        data: {
          title: message.length > 58 ? `${message.slice(0, 57).trim()}…` : message,
        },
      });
    } else {
      await tx.chatThread.update({
        where: { id: thread.id },
        data: { updatedAt: new Date() },
      });
    }

    return run;
  });
}

export async function attachWorkflowToAgentRun(input: {
  runId: string;
  workflowId: string;
}) {
  await prisma.agentRun.update({
    where: { id: input.runId },
    data: { workflowId: input.workflowId },
  });
}

export async function appendAgentRunEvent(input: {
  runId: string;
  type: "progress" | "tool_call" | "tool_result" | "status_change" | "warning" | "error";
  message?: string | null;
  toolName?: string | null;
  payload?: unknown;
  isUserVisible?: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "AgentRun" WHERE "id" = ${input.runId} FOR UPDATE
    `;
    if (!runs[0] || ["completed", "insufficient_context", "failed", "cancelled"].includes(runs[0].status)) {
      return null;
    }
    const max = await tx.agentRunEvent.aggregate({
      where: { agentRunId: input.runId },
      _max: { sequence: true },
    });

    return tx.agentRunEvent.create({
      data: {
        agentRunId: input.runId,
        sequence: (max._max.sequence ?? 0) + 1,
        type: input.type,
        message: input.message?.slice(0, 500) ?? null,
        toolName: input.toolName?.slice(0, 120) ?? null,
        payload: input.payload == null ? Prisma.JsonNull : toInputJson(input.payload),
        isUserVisible: input.isUserVisible ?? true,
      },
    });
  });
}

export async function markAgentRunRunning(runId: string) {
  return prisma.$transaction(async (tx) => {
    const [run] = await tx.$queryRaw<Array<{ status: string; startedAt: Date | null }>>`
      SELECT "status"::text AS "status", "startedAt"
      FROM "AgentRun"
      WHERE "id" = ${runId}
      FOR UPDATE
    `;
    if (!run || !["queued", "running", "awaiting_review"].includes(run.status)) {
      return { active: false as const, status: run?.status ?? "missing" };
    }
    await tx.agentRun.update({
      where: { id: runId },
      data: {
        status: "running",
        startedAt: run.startedAt ?? new Date(),
      },
    });
    await tx.chatMessage.updateMany({
      where: { agentRunId: runId, role: "assistant" },
      data: { status: "running" },
    });
    return { active: true as const, status: "running" as const };
  });
}

export async function markAgentRunAwaitingReview(input: {
  runId: string;
  content: string;
  result: unknown;
  citations: ProjectKnowledgeCitation[];
  citationPolicy: AnswerCitationPolicy;
  groundedClaims?: Array<{ claim: string; citationIndexes: number[] }>;
  freshness?: FinalizedChatAnswer["freshness"];
}) {
  const content = input.content.trim();
  assertAnswerCitationContract({ content, citations: input.citations, policy: input.citationPolicy, groundedClaims: input.groundedClaims });
  return prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "AgentRun" WHERE "id" = ${input.runId} FOR UPDATE
    `;
    if (!runs[0] || !["queued", "running", "awaiting_review"].includes(runs[0].status)) {
      return {
        persisted: false as const,
        status: runs[0]?.status ?? "missing",
      };
    }
    const message = await tx.chatMessage.findFirstOrThrow({
      where: { agentRunId: input.runId, role: "assistant" },
      orderBy: { sequence: "desc" },
    });
    await tx.chatCitation.deleteMany({ where: { messageId: message.id } });
    if (input.citations.length) {
      await tx.chatCitation.createMany({ data: buildChatCitationRows(message.id, input.citations) });
    }
    await tx.chatMessage.update({
      where: { id: message.id },
      data: {
        content,
        status: "awaiting_review",
        finalizedAt: null,
        metadata: toInputJson({
          provisional: true,
          originatingRunId: input.runId,
          citationContractVersion: 2,
          citationIntegrity: "verified",
          renderVersion: 2,
          citationPolicy: input.citationPolicy,
          freshness: input.freshness ?? null,
        }),
      },
    });
    await tx.agentRun.update({
      where: { id: input.runId },
      data: {
        status: "awaiting_review",
        result: toInputJson(input.result),
        provisionalResult: toInputJson({
          content,
          citations: input.citations.map((citation, index) => ({
            ordinal: index + 1,
            kind: citation.kind,
            label: citation.label,
            projectFactId: citation.projectFactId ?? null,
          })),
          capturedAt: new Date().toISOString(),
        }),
      },
    });
    return { persisted: true as const, status: "awaiting_review" as const };
  });
}

export async function completeAgentRun(input: {
  runId: string;
  content: string;
  result: unknown;
  citations?: ProjectKnowledgeCitation[];
  citationPolicy: AnswerCitationPolicy;
  groundedClaims?: Array<{ claim: string; citationIndexes: number[] }>;
  freshness?: FinalizedChatAnswer["freshness"];
  researchFinalization?: {
    usedProjectFactIds: string[];
  };
  artifactFinalization?: {
    artifactId: string;
    supersedesArtifactId?: string | null;
  };
}) {
  const content = input.content.trim();
  const citations = input.citations ?? [];
  const requestedPublicationOutcome = record(input.result)?.publicationOutcome;
  const publicationOutcome = requestedPublicationOutcome === "answered" ||
      requestedPublicationOutcome === "answered_with_gaps"
    ? requestedPublicationOutcome
    : null;
  assertAnswerCitationContract({ content, citations, policy: input.citationPolicy, groundedClaims: input.groundedClaims });
  return prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{
      status: string;
      result: unknown;
      researchState: unknown;
      environmentSnapshot: unknown;
      workItemId: string;
    }>>`
      SELECT
        "status"::text AS "status",
        "result",
        "researchState",
        "environmentSnapshot",
        "workItemId"
      FROM "AgentRun"
      WHERE "id" = ${input.runId}
      FOR UPDATE
    `;
    if (
      !runs[0] ||
      ["completed", "insufficient_context", "failed", "cancelled"].includes(runs[0].status)
    ) {
      return {
        persisted: false as const,
        status: runs[0]?.status ?? "missing",
      };
    }
    const artifactProvenance = input.artifactFinalization
      ? await revalidateArtifactFinalizationProvenance(tx, {
          artifactId: input.artifactFinalization.artifactId,
          runId: input.runId,
          workItemId: runs[0].workItemId,
        })
      : { eligible: true as const };
    const provenanceFailureMessage = artifactProvenance.eligible
      ? null
      : artifactProvenance.message || ARTIFACT_PROVENANCE_CHANGED_MESSAGE;
    const finalContent = provenanceFailureMessage ?? content;
    const finalCitations = provenanceFailureMessage ? [] : citations;
    const finalCitationPolicy: AnswerCitationPolicy = provenanceFailureMessage
      ? "none"
      : input.citationPolicy;
    const finalStatus = provenanceFailureMessage
      ? "insufficient_context" as const
      : "completed" as const;
    const message = await tx.chatMessage.findFirstOrThrow({
      where: { agentRunId: input.runId, role: "assistant" },
      orderBy: { sequence: "desc" },
      include: {
        _count: { select: { citations: true } },
      },
    });
    // A review-resumed workflow is marked running before finalization, so the
    // run status alone cannot identify its provisional citation rows. Count
    // rows in the existing message read and replace only when rows are really
    // present; ordinary first-pass turns still avoid the extra delete write.
    if (message._count.citations > 0) {
      await tx.chatCitation.deleteMany({ where: { messageId: message.id } });
    }

    if (finalCitations.length) {
      await tx.chatCitation.createMany({ data: buildChatCitationRows(message.id, finalCitations) });
    }

    await tx.chatMessage.update({
      where: { id: message.id },
      data: {
        content: finalContent,
        status: "completed",
        finalizedAt: new Date(),
        metadata: toInputJson({
          provisional: false,
          originatingRunId: input.runId,
          citationContractVersion: 2,
          citationIntegrity: provenanceFailureMessage ? "not_applicable" : "verified",
          renderVersion: 2,
          citationPolicy: finalCitationPolicy,
          freshness: input.freshness ?? null,
          ...(publicationOutcome ? { publicationOutcome } : {}),
          ...(provenanceFailureMessage ? {
            outcome: "insufficient_context",
            operationalFailure: false,
            retryable: true,
            failureCode: "artifact_provenance_changed",
          } : {}),
        }),
      },
    });
    // The rolling summary contains only messages outside the latest 12-turn
    // prompt window. Short threads therefore need no history read at all; for
    // long threads, load only the prefix that can actually enter the summary.
    const olderMessages = message.sequence > 12
      ? await tx.chatMessage.findMany({
          where: {
            threadId: message.threadId,
            sequence: { lte: message.sequence - 12 },
          },
          orderBy: { sequence: "asc" },
          include: {
            citations: {
              orderBy: { ordinal: "asc" },
              select: { kind: true, label: true },
            },
          },
        })
      : [];
    const rollingSummary = buildRollingConversationSummary(
      olderMessages.map((entry) => ({
        id: entry.id,
        role: entry.role,
        content: entry.id === message.id ? finalContent : entry.content,
        citations: entry.citations,
      })),
    );
    await tx.chatThread.update({
      where: { id: message.threadId },
      data: {
        rollingSummary: rollingSummary ? rollingSummary.slice(-6_000) : null,
        conversationState: toInputJson({
          version: 1,
          olderTurns: olderMessages.slice(-24).map((entry) => ({
            messageId: entry.id,
            role: entry.role,
            summary: (entry.id === message.id ? finalContent : entry.content).slice(0, 800),
          })),
          lastCompletedRunId: input.runId,
          updatedAt: new Date().toISOString(),
        }),
      },
    });
    const completedResearchState = completeProjectResearchDossier(
      runs[0].researchState,
      runs[0].environmentSnapshot,
      {
        status: finalStatus,
        citationCount: finalCitations.length,
        usedProjectFactIds: provenanceFailureMessage
          ? []
          : input.researchFinalization?.usedProjectFactIds ?? finalCitations.flatMap((citation) => citation.projectFactId ? [citation.projectFactId] : []),
      },
    );
    const completedResult = mergeCompletedRunResult({
      existing: runs[0].result,
      next: provenanceFailureMessage
        ? {
            ...(record(input.result) ?? {}),
            status: "insufficient_context",
            message: provenanceFailureMessage,
            failureCode: "artifact_provenance_changed",
          }
        : input.result,
      researchState: completedResearchState ?? runs[0].researchState,
      environmentSnapshot: runs[0].environmentSnapshot,
    });
    if (input.artifactFinalization && provenanceFailureMessage) {
      await tx.artifact.updateMany({
        where: {
          id: input.artifactFinalization.artifactId,
          originatingAgentRunId: input.runId,
        },
        data: {
          lifecycleStatus: "quarantined",
          publicSafetyStatus: "failed",
          staleReason: provenanceFailureMessage,
        },
      });
    } else if (input.artifactFinalization) {
      const activated = await tx.artifact.updateMany({
        where: {
          id: input.artifactFinalization.artifactId,
          originatingAgentRunId: input.runId,
          lifecycleStatus: { in: ["quarantined", "active"] },
          publicSafetyStatus: "verified",
        },
        data: {
          lifecycleStatus: "active",
          staleReason: null,
        },
      });
      if (activated.count !== 1) {
        throw new Error(
          "The verified Artifact could not be activated atomically with its completed run.",
        );
      }
      if (input.artifactFinalization.supersedesArtifactId) {
        await tx.artifact.updateMany({
          where: {
            id: input.artifactFinalization.supersedesArtifactId,
            workItemId: runs[0].workItemId,
            lifecycleStatus: "active",
          },
          data: { lifecycleStatus: "superseded" },
        });
      }
    }
    await tx.agentRun.update({
      where: { id: input.runId },
      data: {
        status: finalStatus,
        result: toInputJson(completedResult),
        ...(completedResearchState ? { researchState: toInputJson(completedResearchState) } : {}),
        ...(provenanceFailureMessage ? {
          error: toInputJson({
            message: provenanceFailureMessage,
            code: "artifact_provenance_changed",
            retryable: true,
          }),
        } : {}),
        finishedAt: new Date(),
      },
    });
    if (provenanceFailureMessage) {
      return {
        persisted: true as const,
        status: "insufficient_context" as const,
        message: provenanceFailureMessage,
      };
    }
    return {
      persisted: true as const,
      status: "completed" as const,
    };
  });
}

export async function cancelActiveAgentRunPersistence(input: {
  runId: string;
  userId: string;
  workItemId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const runs = await tx.$queryRaw<Array<{
      status: string;
      workflowId: string | null;
      knowledgeRefreshRunId: string | null;
    }>>`
      SELECT
        "status"::text AS "status",
        "workflowId",
        "knowledgeRefreshRunId"
      FROM "AgentRun"
      WHERE "id" = ${input.runId}
        AND "userId" = ${input.userId}
        AND "workItemId" = ${input.workItemId}
      FOR UPDATE
    `;
    const status = runs[0]?.status ?? "missing";
    if (!["queued", "running", "awaiting_review"].includes(status)) {
      return {
        cancelled: false as const,
        status,
        workflowId: runs[0]?.workflowId ?? null,
        knowledgeRefreshRunId: runs[0]?.knowledgeRefreshRunId ?? null,
      };
    }

    const assistantMessages = await tx.chatMessage.findMany({
      where: { agentRunId: input.runId, role: "assistant" },
      select: { id: true },
    });
    const messageIds = assistantMessages.map((message) => message.id);
    if (messageIds.length) {
      await tx.chatCitation.deleteMany({
        where: { messageId: { in: messageIds } },
      });
    }
    await tx.chatMessage.updateMany({
      where: {
        id: { in: messageIds },
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: {
        status: "cancelled",
        content: "This run was cancelled.",
        finalizedAt: new Date(),
        metadata: toInputJson({
          outcome: "cancelled",
          operationalFailure: false,
          citationIntegrity: "not_applicable",
        }),
      },
    });
    await tx.agentRun.update({
      where: { id: input.runId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return {
      cancelled: true as const,
      status: "cancelled" as const,
      workflowId: runs[0]?.workflowId ?? null,
      knowledgeRefreshRunId: runs[0]?.knowledgeRefreshRunId ?? null,
    };
  });
}

export async function failAgentRun(input: {
  runId: string;
  message: string;
  insufficient?: boolean;
  failure?: {
    code: string;
    stage?: string | null;
    retryable: boolean;
    recovery?: string | null;
  };
}) {
  const status = input.insufficient ? "insufficient_context" : "failed";
  await prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({
      where: { id: input.runId },
      select: { status: true, researchState: true, environmentSnapshot: true },
    });
    if (!run || !["queued", "running", "awaiting_review"].includes(run.status)) return;
    const completedResearchState = completeProjectResearchDossier(
      run.researchState,
      run.environmentSnapshot,
      { status, citationCount: 0, usedProjectFactIds: [] },
    );
    const updated = await tx.agentRun.updateMany({
      where: {
        id: input.runId,
        status: { in: ["queued", "running", "awaiting_review"] },
      },
      data: {
        status,
        error: toInputJson({
          message: input.message,
          ...(input.failure ? {
            code: input.failure.code,
            stage: input.failure.stage ?? null,
            retryable: input.failure.retryable,
            recovery: input.failure.recovery ?? null,
          } : {}),
        }),
        ...(completedResearchState ? { researchState: toInputJson(completedResearchState) } : {}),
        finishedAt: new Date(),
      },
    });
    if (!updated.count) return;
    await tx.chatMessage.updateMany({
      where: { agentRunId: input.runId, role: "assistant" },
      data: {
        // "Insufficient context" is a valid conversational outcome, not an
        // operationally failed assistant turn. Keep it in multi-turn history
        // so a follow-up such as "why?" can refer to the precise evidence gap.
        status: input.insufficient ? "completed" : "failed",
        content: input.message,
        finalizedAt: new Date(),
        metadata: toInputJson({
          outcome: status,
          operationalFailure: !input.insufficient,
          retryable: input.failure?.retryable ?? true,
          failureCode: input.failure?.code ?? null,
          recovery: input.failure?.recovery ?? null,
        }),
      },
    });
  });
}

export async function getProjectChatWorkspace(input: {
  userId: string;
  workItemId: string;
  activeThreadId?: string | null;
}) {
  const threads = await prisma.chatThread.findMany({
    where: {
      userId: input.userId,
      workItemId: input.workItemId,
      archivedAt: null,
    },
    orderBy: { updatedAt: "desc" },
  });
  const activeThread =
    threads.find((thread) => thread.id === input.activeThreadId) ?? threads[0] ?? null;

  if (!activeThread) {
    return {
      threads,
      activeThread: null,
      messages: [],
      runs: [],
      events: [],
      candidates: [],
    };
  }

  const [messages, runs] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { threadId: activeThread.id },
      include: {
        citations: {
          orderBy: { ordinal: "asc" },
          include: {
            projectFact: {
              include: {
                evidence: { include: { evidenceItem: true } },
              },
            },
          },
        },
      },
      orderBy: { sequence: "asc" },
    }),
    prisma.agentRun.findMany({
      where: { threadId: activeThread.id },
      include: {
        events: {
          where: { isUserVisible: true },
          orderBy: { sequence: "asc" },
        },
        candidates: {
          include: {
            highlight: {
              include: {
                tags: true,
                evidence: {
                  include: { evidenceItem: true },
                },
              },
            },
            highlightSuggestion: true,
            projectFact: {
              include: {
                evidence: { include: { evidenceItem: true } },
                supersedesProjectFact: true,
              },
            },
          },
          orderBy: [{ batchNumber: "asc" }, { ordinal: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return {
    threads,
    activeThread,
    messages,
    runs,
    events: runs.flatMap((run) => run.events.map((event) => ({ ...event, runId: run.id }))),
    candidates: runs.flatMap((run) =>
      run.candidates.map((candidate) => ({ ...candidate, runId: run.id })),
    ),
  };
}
