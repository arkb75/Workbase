import { createHash } from "node:crypto";
import { Prisma } from "@/src/generated/prisma/client";
import type {
  ClaimDraft,
  ClaimSnapshot,
  EvidenceItemSnapshot,
  JsonValue,
  SourceSnapshot,
  WorkItemSnapshot,
} from "@/src/domain/types";
import {
  areNearDuplicateHighlights,
  filterDuplicateClaimDrafts,
} from "@/src/domain/claim-regeneration";
import { readGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import {
  createHighlightWithRelations,
} from "@/src/lib/evidence-persistence";
import { updateGenerationRunResultRefs } from "@/src/lib/generation-runs";
import { coerceHighlightTagAssignments } from "@/src/lib/highlight-tags";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { claimResearchService } from "@/src/services/claim-research-service";
import { claimVerificationService } from "@/src/services/claim-verification-service";
import {
  buildHighlightEmbeddingText,
  upsertHighlightEmbedding,
} from "@/src/services/highlight-embedding-service";
import {
  serializeHighlightDraft,
  snapshotHighlight,
} from "@/src/services/highlight-suggestion-service";
import {
  upsertReviewableKnowledgeChangeInTransaction,
} from "@/src/services/knowledge-change-service";
import { lockKnowledgeWorkItemMutation } from "@/src/services/knowledge-mutation-lock-service";
import { resolveActiveTextModelIdentity } from "@/src/lib/llm-config";
import { sourceIngestionService } from "@/src/services/source-ingestion-service";
import { USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION } from "@/src/lib/evidence-items";
import {
  buildExactManualEvidenceFallback,
  MANUAL_EVIDENCE_EXTRACTIVE_POLICY_VERSION,
  markDraftsCitingRedactedEvidence,
  sanitizeManualProviderContext,
  sanitizeNormalizedManualEvidence,
} from "@/src/services/manual-evidence-highlight-safety";

export const MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND =
  "manual_evidence_highlights" as const;
export const MANUAL_EVIDENCE_HIGHLIGHT_MANAGER =
  "manual_evidence_highlight_workflow" as const;
export const MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION =
  `manual-evidence-highlights-v3:${MANUAL_EVIDENCE_EXTRACTIVE_POLICY_VERSION}:${USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION}` as const;
export const MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION =
  "manual-evidence-highlight-request-v2" as const;

const ACTIVE_AGENT_RUN_STATUSES = new Set(["queued", "running", "awaiting_review"]);
const ACTIVE_REPOSITORY_REFRESH_STATUSES = [
  "queued",
  "inventorying",
  "analyzing",
  "routing",
  "semantic_analysis",
  "auditing",
  "reconciling",
] as const;

export type ManualEvidenceHighlightTrigger =
  | "work_item_create"
  | "manual_source_add"
  | "manual_evidence_change";

export type ManualEvidenceHighlightTerminalOutcome =
  | "ready"
  | "no_safe_candidates"
  | "no_evidence"
  | "superseded_input";

export type ManualEvidenceHighlightRequestEvidence = {
  id: string;
  sourceId: string;
  externalId: string;
  contentHash: string;
  included: true;
};

export type ManualEvidenceHighlightRequest = {
  kind: typeof MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND;
  policyVersion: typeof MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION;
  requestSchemaVersion: typeof MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION;
  trigger: ManualEvidenceHighlightTrigger;
  sourceIds: string[];
  evidenceItems: ManualEvidenceHighlightRequestEvidence[];
  contextHash: string;
  inputFingerprint: string;
  executionKey: string;
};

export type ManualEvidenceProviderWorkItemContext = Pick<
  WorkItemSnapshot,
  "id" | "title" | "type" | "description"
>;

export type ManualEvidenceContentHashInput = {
  externalId: string;
  title: string;
  content: string;
  searchText: string;
  parentKind: string | null;
  parentKey: string | null;
  metadata: unknown;
  source: {
    label: string;
    externalId: string | null;
    rawContent: string | null;
    metadata: unknown;
  };
};

export type ManualEvidenceHighlightPreparedPlan = {
  inputFingerprint: string;
  drafts: ClaimDraft[];
  generationRunIds: string[];
};

export type ManualEvidenceHighlightPersistenceResult =
  | { status: "deferred_repository_refresh" }
  | {
      status: "persisted";
      terminalOutcome: "ready" | "no_safe_candidates";
      createdHighlightIds: string[];
      replayedHighlightIds: string[];
      deduplicatedHighlightIds: string[];
      suggestionIds: string[];
      suppressedHighlightIds: string[];
    }
  | {
      status: "superseded_input";
      terminalOutcome: "superseded_input";
      createdHighlightIds: [];
      replayedHighlightIds: [];
      deduplicatedHighlightIds: [];
      suggestionIds: [];
      suppressedHighlightIds: [];
    }
  | { status: "inactive"; runStatus: string };

type ManualEvidenceRow = {
  id: string;
  workItemId: string;
  sourceId: string;
  externalId: string;
  type: "manual_note_excerpt";
  title: string;
  content: string;
  searchText: string;
  parentKind: string | null;
  parentKey: string | null;
  included: boolean;
  lifecycleStatus: string;
  reviewState: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  source: {
    id: string;
    workItemId: string;
    type: "manual_note";
    label: string;
    externalId: string | null;
    rawContent: string | null;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  };
  tags: Array<{
    dimension: "domain" | "competency" | "emphasis" | "audience_fit";
    tag: string;
    score: number | null;
  }>;
};

function jsonRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFingerprintValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalFingerprintValue(entry)]),
    );
  }
  return value ?? null;
}

export function manualEvidenceProviderContextHash(
  workItem: ManualEvidenceProviderWorkItemContext,
) {
  return sha256(JSON.stringify(canonicalFingerprintValue({
    workItem: {
      id: workItem.id,
      title: workItem.title,
      type: workItem.type,
      description: workItem.description,
    },
  })));
}

export function manualEvidenceContentHash(input: ManualEvidenceContentHashInput) {
  return sha256(JSON.stringify(canonicalFingerprintValue({
    externalId: input.externalId,
    title: input.title,
    content: input.content,
    searchText: input.searchText,
    parentKind: input.parentKind,
    parentKey: input.parentKey,
    metadata: input.metadata,
    source: {
      label: input.source.label,
      externalId: input.source.externalId,
      rawContent: input.source.rawContent,
      metadata: input.source.metadata,
    },
  })));
}

export function manualEvidenceInputFingerprint(
  evidenceItems: readonly ManualEvidenceHighlightRequestEvidence[],
  contextHash: string,
) {
  return sha256(
    [
      contextHash,
      ...evidenceItems
        .map((item) => [
          item.id,
          item.sourceId,
          item.externalId,
          item.contentHash,
          item.included ? "included" : "excluded",
        ].join(":"))
        .sort(),
    ].join("|"),
  );
}

export function buildManualEvidenceHighlightRequest(input: {
  workItem: ManualEvidenceProviderWorkItemContext;
  trigger: ManualEvidenceHighlightTrigger;
  evidenceItems: Array<ManualEvidenceContentHashInput & {
    id: string;
    sourceId: string;
  }>;
}): ManualEvidenceHighlightRequest {
  const evidenceItems = input.evidenceItems
    .map((item): ManualEvidenceHighlightRequestEvidence => ({
      id: item.id,
      sourceId: item.sourceId,
      externalId: item.externalId,
      contentHash: manualEvidenceContentHash({
        externalId: item.externalId,
        title: item.title,
        content: item.content,
        searchText: item.searchText,
        parentKind: item.parentKind,
        parentKey: item.parentKey,
        metadata: item.metadata,
        source: {
          label: item.source.label,
          externalId: item.source.externalId,
          rawContent: item.source.rawContent,
          metadata: item.source.metadata,
        },
      }),
      included: true,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const contextHash = manualEvidenceProviderContextHash(input.workItem);
  const inputFingerprint = manualEvidenceInputFingerprint(
    evidenceItems,
    contextHash,
  );
  return {
    kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
    policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
    requestSchemaVersion: MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION,
    trigger: input.trigger,
    sourceIds: Array.from(new Set(evidenceItems.map((item) => item.sourceId))).sort(),
    evidenceItems,
    contextHash,
    inputFingerprint,
    executionKey: [
      MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
      MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION,
      input.workItem.id,
      inputFingerprint,
    ].join(":"),
  };
}

export function readManualEvidenceHighlightRequest(
  value: unknown,
): ManualEvidenceHighlightRequest | null {
  const request = jsonRecord(value);
  if (
    request?.kind !== MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND ||
    request.policyVersion !== MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION ||
    request.requestSchemaVersion !==
      MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION ||
    (
      request.trigger !== "work_item_create" &&
      request.trigger !== "manual_source_add" &&
      request.trigger !== "manual_evidence_change"
    ) ||
    typeof request.contextHash !== "string" ||
    typeof request.inputFingerprint !== "string" ||
    typeof request.executionKey !== "string" ||
    !request.executionKey.startsWith(
      `${MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION}:${MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION}:`,
    ) ||
    !request.executionKey.endsWith(`:${request.inputFingerprint}`)
  ) {
    return null;
  }
  const sourceIds = jsonStringArray(request.sourceIds);
  const evidenceItems = Array.isArray(request.evidenceItems)
    ? request.evidenceItems.flatMap((value) => {
        const item = jsonRecord(value);
        return item &&
          typeof item.id === "string" &&
          typeof item.sourceId === "string" &&
          typeof item.externalId === "string" &&
          typeof item.contentHash === "string" &&
          item.included === true
          ? [{
              id: item.id,
              sourceId: item.sourceId,
              externalId: item.externalId,
              contentHash: item.contentHash,
              included: true as const,
            }]
          : [];
      })
    : [];
  if (
    manualEvidenceInputFingerprint(evidenceItems, request.contextHash) !==
      request.inputFingerprint ||
    sourceIds.slice().sort().join("|") !==
      Array.from(new Set(evidenceItems.map((item) => item.sourceId))).sort().join("|")
  ) {
    return null;
  }
  return {
    kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
    policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
    requestSchemaVersion: MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION,
    trigger: request.trigger,
    sourceIds: Array.from(new Set(sourceIds)).sort(),
    evidenceItems: evidenceItems.sort((left, right) => left.id.localeCompare(right.id)),
    contextHash: request.contextHash,
    inputFingerprint: request.inputFingerprint,
    executionKey: request.executionKey,
  };
}

function toInputJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function mapWorkItem(workItem: {
  id: string;
  userId: string;
  title: string;
  type: "project" | "experience";
  description: string;
  startDate: Date | null;
  endDate: Date | null;
}): WorkItemSnapshot {
  return {
    id: workItem.id,
    userId: workItem.userId,
    title: workItem.title,
    type: workItem.type,
    description: workItem.description,
    startDate: workItem.startDate,
    endDate: workItem.endDate,
  };
}

function mapSource(source: ManualEvidenceRow["source"]): SourceSnapshot {
  return {
    id: source.id,
    workItemId: source.workItemId,
    type: source.type,
    label: source.label,
    externalId: source.externalId,
    rawContent: source.rawContent,
    metadata: (source.metadata as JsonValue | null) ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function mapEvidence(item: ManualEvidenceRow): EvidenceItemSnapshot {
  return {
    id: item.id,
    workItemId: item.workItemId,
    sourceId: item.sourceId,
    externalId: item.externalId,
    type: item.type,
    title: item.title,
    content: item.content,
    searchText: item.searchText,
    parentKind: item.parentKind,
    parentKey: item.parentKey,
    included: item.included,
    lifecycleStatus: item.lifecycleStatus as EvidenceItemSnapshot["lifecycleStatus"],
    reviewState: item.reviewState as EvidenceItemSnapshot["reviewState"],
    metadata: (item.metadata as JsonValue | null) ?? null,
    source: {
      id: item.source.id,
      label: item.source.label,
      type: item.source.type,
      externalId: item.source.externalId,
      metadata: (item.source.metadata as JsonValue | null) ?? null,
    },
    tags: coerceHighlightTagAssignments(item.tags),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function mapHighlight(highlight: {
  id: string;
  workItemId: string;
  text: string;
  summary: string;
  confidence: ClaimSnapshot["confidence"];
  ownershipClarity: ClaimSnapshot["ownershipClarity"];
  sensitivityFlag: boolean;
  verificationStatus: ClaimSnapshot["verificationStatus"];
  lifecycleStatus: ClaimSnapshot["lifecycleStatus"];
  reviewState: ClaimSnapshot["reviewState"];
  approvalSource: ClaimSnapshot["approvalSource"];
  publicSafetyStatus: ClaimSnapshot["publicSafetyStatus"];
  validatedThroughSha: string | null;
  visibility: ClaimSnapshot["visibility"];
  risksSummary: string | null;
  missingInfo: string | null;
  rejectionReason: string | null;
  verificationNotes: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  evidence: Array<{
    evidenceItemId: string;
    evidenceItem: {
      sourceId: string;
      title: string;
      content: string;
      source: { id: string; label: string; type: "manual_note" | "github_repo" | "chat_context" };
    };
  }>;
  tags: Array<{
    dimension: "domain" | "competency" | "emphasis" | "audience_fit";
    tag: string;
    score: number | null;
  }>;
}): ClaimSnapshot {
  return {
    id: highlight.id,
    workItemId: highlight.workItemId,
    text: highlight.text,
    summary: highlight.summary,
    confidence: highlight.confidence,
    ownershipClarity: highlight.ownershipClarity,
    sensitivityFlag: highlight.sensitivityFlag,
    verificationStatus: highlight.verificationStatus,
    lifecycleStatus: highlight.lifecycleStatus,
    reviewState: highlight.reviewState,
    approvalSource: highlight.approvalSource,
    publicSafetyStatus: highlight.publicSafetyStatus,
    validatedThroughSha: highlight.validatedThroughSha,
    visibility: highlight.visibility,
    risksSummary: highlight.risksSummary,
    missingInfo: highlight.missingInfo,
    rejectionReason: highlight.rejectionReason,
    verificationNotes: highlight.verificationNotes,
    metadata: (highlight.metadata as JsonValue | null) ?? null,
    evidence: {
      summary: highlight.summary,
      verificationNotes: highlight.verificationNotes,
      sourceRefs: highlight.evidence.map((entry) => ({
        evidenceItemId: entry.evidenceItemId,
        sourceId: entry.evidenceItem.sourceId,
        sourceLabel: entry.evidenceItem.source.label,
        sourceType: entry.evidenceItem.source.type,
        title: entry.evidenceItem.title,
        excerpt: entry.evidenceItem.content,
      })),
    },
    tags: coerceHighlightTagAssignments(highlight.tags),
    createdAt: highlight.createdAt,
    updatedAt: highlight.updatedAt,
  };
}

function managedBy(highlight: Pick<ClaimSnapshot, "metadata">) {
  const metadata = jsonRecord(highlight.metadata);
  return typeof metadata?.managedBy === "string" ? metadata.managedBy : null;
}

function originatingAgentRunId(highlight: Pick<ClaimSnapshot, "metadata">) {
  const metadata = jsonRecord(highlight.metadata);
  return typeof metadata?.originatingAgentRunId === "string"
    ? metadata.originatingAgentRunId
    : null;
}

function evidenceMatchesRequest(
  evidenceItems: ManualEvidenceRow[],
  request: ManualEvidenceHighlightRequest,
  workItem: ManualEvidenceProviderWorkItemContext,
) {
  if (manualEvidenceProviderContextHash(workItem) !== request.contextHash) {
    return false;
  }
  if (evidenceItems.length !== request.evidenceItems.length) return false;
  const expected = new Map(request.evidenceItems.map((item) => [item.id, item]));
  for (const item of evidenceItems) {
    const identity = expected.get(item.id);
    if (
      !identity ||
      item.type !== "manual_note_excerpt" ||
      item.source.type !== "manual_note" ||
      item.sourceId !== identity.sourceId ||
      item.externalId !== identity.externalId ||
      !item.included ||
      item.lifecycleStatus !== "active" ||
      item.reviewState === "reverted" ||
      manualEvidenceContentHash(item) !== identity.contentHash
    ) {
      return false;
    }
  }
  return manualEvidenceInputFingerprint(
    evidenceItems.map((item) => ({
      id: item.id,
      sourceId: item.sourceId,
      externalId: item.externalId,
      contentHash: manualEvidenceContentHash(item),
      included: true,
    })),
    request.contextHash,
  ) === request.inputFingerprint;
}

async function loadCompleteManualEvidenceRows(
  db: typeof prisma | Prisma.TransactionClient,
  workItemId: string,
) {
  return await db.evidenceItem.findMany({
    where: {
      workItemId,
      type: "manual_note_excerpt",
      included: true,
      lifecycleStatus: "active",
      reviewState: { not: "reverted" },
      source: { type: "manual_note" },
    },
    include: {
      source: true,
      tags: true,
    },
    orderBy: { id: "asc" },
  }) as ManualEvidenceRow[];
}

export async function buildCurrentManualEvidenceHighlightRequest(input: {
  db?: typeof prisma | Prisma.TransactionClient;
  workItemId: string;
  trigger: ManualEvidenceHighlightTrigger;
}) {
  const db = input.db ?? prisma;
  const [workItem, evidenceItems] = await Promise.all([
    db.workItem.findUnique({
      where: { id: input.workItemId },
      select: {
        id: true,
        title: true,
        type: true,
        description: true,
      },
    }),
    loadCompleteManualEvidenceRows(db, input.workItemId),
  ]);
  if (!workItem) return null;
  return evidenceItems.length
    ? buildManualEvidenceHighlightRequest({
        workItem,
        trigger: input.trigger,
        evidenceItems,
      })
    : null;
}

type ManualHighlightForInputReconciliation = Prisma.HighlightGetPayload<{
  include: {
    evidence: {
      include: {
        evidenceItem: true;
      };
    };
  };
}>;

function storedManualEvidenceContentHashes(metadata: unknown) {
  const hashes = jsonRecord(jsonRecord(metadata)?.evidenceContentHashes);
  if (!hashes) return null;
  const entries = Object.entries(hashes).flatMap(([evidenceId, contentHash]) =>
    typeof contentHash === "string" ? [[evidenceId, contentHash] as const] : []
  );
  return entries.length ? new Map(entries) : null;
}

function manualHighlightStillMatchesInput(
  highlight: ManualHighlightForInputReconciliation,
  request: ManualEvidenceHighlightRequest | null,
) {
  const metadata = jsonRecord(highlight.metadata);
  if (
    metadata?.managedBy !== MANUAL_EVIDENCE_HIGHLIGHT_MANAGER ||
    metadata.policyVersion !== MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION ||
    !request
  ) {
    return false;
  }
  const currentHashes = new Map(
    request.evidenceItems.map((item) => [item.id, item.contentHash]),
  );
  const supportingEvidenceIds = Array.from(new Set(
    highlight.evidence.map((entry) => entry.evidenceItemId),
  ));
  if (
    !supportingEvidenceIds.length ||
    supportingEvidenceIds.some((evidenceId) => !currentHashes.has(evidenceId))
  ) {
    return false;
  }
  const storedHashes = storedManualEvidenceContentHashes(metadata);
  if (storedHashes) {
    return supportingEvidenceIds.every((evidenceId) =>
      storedHashes.get(evidenceId) === currentHashes.get(evidenceId)
    );
  }

  // Rows written before per-Evidence hashes were introduced can only be
  // proven current when the complete captured input is unchanged. Retiring an
  // unverifiable legacy row is safer than silently retrieving stale content.
  return metadata.inputFingerprint === request.inputFingerprint;
}

/**
 * Remove stale manual-owned knowledge from retrieval before a replacement run
 * is started. Callers hold the WorkItem and knowledge mutation locks, so the
 * input snapshot, ownership check, and retirement are one fenced transition.
 */
export async function reconcileManualEvidenceHighlightsForInput(input: {
  tx: Prisma.TransactionClient;
  workItemId: string;
  request: ManualEvidenceHighlightRequest | null;
}) {
  const candidates = await input.tx.highlight.findMany({
    where: {
      workItemId: input.workItemId,
      lifecycleStatus: {
        in: ["active", "needs_validation", "stale", "quarantined"],
      },
    },
    include: {
      evidence: { include: { evidenceItem: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const retiredHighlightIds: string[] = [];
  const currentFingerprint = input.request?.inputFingerprint ??
    manualEvidenceInputFingerprint(
      [],
      sha256("no-current-manual-evidence-context"),
    );

  for (const highlight of candidates) {
    const metadata = jsonRecord(highlight.metadata);
    if (
      metadata?.managedBy !== MANUAL_EVIDENCE_HIGHLIGHT_MANAGER ||
      manualHighlightStillMatchesInput(highlight, input.request)
    ) {
      continue;
    }
    const policyChanged =
      metadata.policyVersion !== MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION;
    const retiredAt = new Date();
    const claimed = await input.tx.highlight.updateMany({
      where: {
        id: highlight.id,
        workItemId: input.workItemId,
        lifecycleStatus: highlight.lifecycleStatus,
        metadata: {
          equals: highlight.metadata === null
            ? Prisma.DbNull
            : highlight.metadata as Prisma.InputJsonValue,
        },
        updatedAt: highlight.updatedAt,
      },
      data: {
        lifecycleStatus: "retired",
        reviewState: "pending_review",
        publicSafetyStatus: "not_eligible",
        autoAppliedAt: null,
        metadata: toInputJson({
          ...metadata,
          retiredBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
          retiredForPolicyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
          retiredForInputFingerprint: currentFingerprint,
          retiredAt: retiredAt.toISOString(),
        }),
      },
    });
    if (claimed.count !== 1) continue;
    retiredHighlightIds.push(highlight.id);
    await upsertReviewableKnowledgeChangeInTransaction({
      workItemId: input.workItemId,
      entityKind: "highlight",
      action: "retired",
      entityId: highlight.id,
      beforeSnapshot: {
        id: highlight.id,
        text: highlight.text,
        lifecycleStatus: highlight.lifecycleStatus,
        inputFingerprint: metadata.inputFingerprint ?? null,
        policyVersion: metadata.policyVersion ?? null,
      },
      afterSnapshot: {
        id: highlight.id,
        text: highlight.text,
        lifecycleStatus: "retired",
        inputFingerprint: currentFingerprint,
        policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
      },
      reason: policyChanged
        ? "The manual Highlight policy changed, so this prior-policy automatic Highlight was removed from retrieval pending current-policy re-verification."
        : "The included manual Evidence or its captured content changed, so this automatic Highlight was removed from retrieval pending a grounded successor.",
      provenance: {
        managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
        originatingAgentRunId: metadata.originatingAgentRunId ?? null,
        previousInputFingerprint: metadata.inputFingerprint ?? null,
        currentInputFingerprint: currentFingerprint,
        currentEvidenceIds: input.request?.evidenceItems.map((item) => item.id) ?? [],
        previousPolicyVersion: metadata.policyVersion ?? null,
        currentPolicyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
      },
      policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
      modelId: "deterministic/manual-evidence-input-reconciliation",
      idempotencyKey: [
        "manual-evidence-retired",
        MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
        highlight.id,
        currentFingerprint.slice(0, 24),
      ].join(":"),
    }, input.tx);
  }

  return { retiredHighlightIds };
}

function requestIsBoundToWorkItem(
  request: ManualEvidenceHighlightRequest,
  workItemId: string,
) {
  return request.executionKey === [
    MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
    MANUAL_EVIDENCE_HIGHLIGHT_REQUEST_SCHEMA_VERSION,
    workItemId,
    request.inputFingerprint,
  ].join(":");
}

function parsePreparedPlan(value: unknown): ManualEvidenceHighlightPreparedPlan | null {
  const checkpoint = jsonRecord(value);
  if (
    checkpoint?.kind !== "manual_evidence_highlight_plan" ||
    checkpoint.policyVersion !== MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION ||
    typeof checkpoint.inputFingerprint !== "string" ||
    !Array.isArray(checkpoint.drafts)
  ) {
    return null;
  }
  const drafts = checkpoint.drafts.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const draft = value as Partial<ClaimDraft>;
    if (
      typeof draft.text !== "string" ||
      typeof draft.summary !== "string" ||
      !draft.evidence ||
      !Array.isArray(draft.evidence.sourceRefs) ||
      !Array.isArray(draft.tags)
    ) {
      return [];
    }
    return [{
      ...draft,
      confidence: draft.confidence ?? "medium",
      ownershipClarity: draft.ownershipClarity ?? "partial",
      sensitivityFlag: Boolean(draft.sensitivityFlag),
      verificationStatus: draft.verificationStatus ?? "draft",
      visibility: draft.visibility ?? "private",
      risksSummary: draft.risksSummary ?? null,
      missingInfo: draft.missingInfo ?? null,
      rejectionReason: draft.rejectionReason ?? null,
      verificationNotes: draft.verificationNotes ?? null,
      metadata: draft.metadata ?? null,
      evidence: draft.evidence,
      tags: draft.tags,
    } as ClaimDraft];
  });
  if (drafts.length !== checkpoint.drafts.length) return null;
  return {
    inputFingerprint: checkpoint.inputFingerprint,
    drafts,
    generationRunIds: jsonStringArray(checkpoint.generationRunIds),
  };
}

export async function prepareManualEvidenceHighlights(
  runId: string,
): Promise<
  | { status: "prepared"; plan: ManualEvidenceHighlightPreparedPlan; replayed?: true }
  | { status: "superseded_input"; inputFingerprint: string }
  | { status: "inactive"; runStatus: string }
> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: {
      workItem: true,
    },
  });
  if (!run || run.kind !== MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND) {
    return { status: "inactive", runStatus: run?.status ?? "missing" };
  }
  if (!ACTIVE_AGENT_RUN_STATUSES.has(run.status)) {
    return { status: "inactive", runStatus: run.status };
  }
  const request = readManualEvidenceHighlightRequest(run.request);
  if (!request || !requestIsBoundToWorkItem(request, run.workItemId)) {
    throw new Error("The manual Highlight run has an invalid evidence request.");
  }
  const checkpoint = parsePreparedPlan(run.researchState);
  if (checkpoint?.inputFingerprint === request.inputFingerprint) {
    return { status: "prepared", plan: checkpoint, replayed: true };
  }
  const evidenceRows = await loadCompleteManualEvidenceRows(prisma, run.workItemId);
  if (!evidenceMatchesRequest(evidenceRows, request, run.workItem)) {
    return {
      status: "superseded_input",
      inputFingerprint: request.inputFingerprint,
    };
  }
  const existingHighlights = await prisma.highlight.findMany({
    where: {
      workItemId: run.workItemId,
      lifecycleStatus: { in: ["active", "needs_validation"] },
    },
    include: {
      evidence: { include: { evidenceItem: { include: { source: true } } } },
      tags: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const workItem = mapWorkItem(run.workItem);
  const sources = Array.from(
    new Map(evidenceRows.map((item) => [item.source.id, mapSource(item.source)])).values(),
  );
  const evidenceItems = evidenceRows.map(mapEvidence);
  const existingClaims = existingHighlights.map(mapHighlight);
  // Manual notes are user-authored and can contain pasted credentials. Redact
  // provider-facing Work Item, Source, Evidence, and prior-Highlight context
  // before either drafting or verification. Authoritative Evidence remains in
  // the database and is used only by the exact deterministic fallback below.
  const providerContext = sanitizeManualProviderContext({
    workItem,
    sources,
    evidenceItems,
    existingHighlights: existingClaims,
  });
  const normalizedEvidence = sanitizeNormalizedManualEvidence({
    evidenceItems: await sourceIngestionService.normalize({
      workItem: providerContext.workItem,
      sources: providerContext.sources,
      evidenceItems: providerContext.evidenceItems,
    }),
    evidenceDlpCategories: providerContext.evidenceDlpCategories,
  });
  const generated = await claimResearchService.generate({
    workItem: providerContext.workItem,
    evidenceItems: normalizedEvidence,
    existingHighlights: providerContext.existingHighlights,
    agentRunId: run.id,
  });
  const verified = generated.highlights.length
    ? await claimVerificationService.verify({
        workItem: providerContext.workItem,
        evidenceItems: normalizedEvidence,
        highlights: generated.highlights,
        agentRunId: run.id,
      })
    : [];
  const safetyMarkedDrafts = markDraftsCitingRedactedEvidence({
    drafts: verified,
    evidenceDlpCategories: providerContext.evidenceDlpCategories,
    workItemDlpCategories: providerContext.workItemDlpCategories,
  });
  const exactFallback = buildExactManualEvidenceFallback({
    evidenceItems,
  });
  const nonConflictingDrafts = exactFallback
    ? safetyMarkedDrafts.filter((draft) =>
        !areNearDuplicateHighlights(exactFallback, draft)
      )
    : safetyMarkedDrafts;
  const verificationRun = readGenerationRunMetadata(verified);
  const plan: ManualEvidenceHighlightPreparedPlan = {
    inputFingerprint: request.inputFingerprint,
    // Put the exact extractive fallback first so a semantically similar
    // quarantined model paraphrase cannot suppress the safe user-authored row.
    drafts: filterDuplicateClaimDrafts(
      exactFallback
        ? [exactFallback, ...nonConflictingDrafts]
        : nonConflictingDrafts,
      [],
    ),
    generationRunIds: Array.from(new Set([
      ...generated.generationRunIds.generation,
      ...(verificationRun?.id ? [verificationRun.id] : []),
    ])),
  };
  const checkpointData = {
    kind: "manual_evidence_highlight_plan",
    policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
    inputFingerprint: plan.inputFingerprint,
    drafts: plan.drafts.map(serializeHighlightDraft),
    generationRunIds: plan.generationRunIds,
    preparedAt: new Date().toISOString(),
  };
  const persisted = await prisma.agentRun.updateMany({
    where: {
      id: run.id,
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      status: { in: ["queued", "running", "awaiting_review"] },
    },
    data: { researchState: toInputJson(checkpointData) },
  });
  if (!persisted.count) {
    const current = await prisma.agentRun.findUnique({
      where: { id: run.id },
      select: { status: true },
    });
    return { status: "inactive", runStatus: current?.status ?? "missing" };
  }
  return { status: "prepared", plan };
}

function draftEvidenceIsScoped(
  draft: ClaimDraft,
  allowedEvidenceIds: Set<string>,
) {
  const citedIds = draft.evidence.sourceRefs.flatMap((reference) =>
    reference.evidenceItemId ? [reference.evidenceItemId] : []
  );
  return citedIds.length > 0 && citedIds.every((id) => allowedEvidenceIds.has(id));
}

export async function persistManualEvidenceHighlights(input: {
  runId: string;
  plan: ManualEvidenceHighlightPreparedPlan;
}): Promise<ManualEvidenceHighlightPersistenceResult> {
  return prisma.$transaction(async (tx): Promise<ManualEvidenceHighlightPersistenceResult> => {
    const runIdentity = await tx.agentRun.findUnique({
      where: { id: input.runId },
      select: {
        workItemId: true,
        workItem: {
          select: {
            id: true,
            title: true,
            type: true,
            description: true,
          },
        },
      },
    });
    if (!runIdentity) return { status: "inactive", runStatus: "missing" };

    // Deletion, repository reconciliation, reviews, chat candidates, and this
    // workflow all acquire WorkItem/knowledge locks in this order.
    const lockedWorkItems = await tx.$queryRaw<Array<
      ManualEvidenceProviderWorkItemContext
    >>`
      SELECT "id", "title", "type"::text AS "type", "description"
      FROM "WorkItem"
      WHERE "id" = ${runIdentity.workItemId}
      FOR UPDATE
    `;
    const lockedWorkItem = lockedWorkItems[0];
    if (!lockedWorkItem) return { status: "inactive", runStatus: "missing" };
    await lockKnowledgeWorkItemMutation(tx, runIdentity.workItemId);
    const lockedRuns = await tx.$queryRaw<Array<{
      status: string;
      kind: string;
      request: unknown;
    }>>`
      SELECT "status"::text AS "status", "kind"::text AS "kind", "request"
      FROM "AgentRun"
      WHERE "id" = ${input.runId}
      FOR UPDATE
    `;
    const lockedRun = lockedRuns[0];
    if (
      !lockedRun ||
      lockedRun.kind !== MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND ||
      !ACTIVE_AGENT_RUN_STATUSES.has(lockedRun.status)
    ) {
      return { status: "inactive", runStatus: lockedRun?.status ?? "missing" };
    }
    const request = readManualEvidenceHighlightRequest(lockedRun.request);
    if (!request || !requestIsBoundToWorkItem(request, runIdentity.workItemId)) {
      throw new Error("The manual Highlight run request is invalid.");
    }
    if (request.inputFingerprint !== input.plan.inputFingerprint) {
      return {
        status: "superseded_input",
        terminalOutcome: "superseded_input",
        createdHighlightIds: [],
        replayedHighlightIds: [],
        deduplicatedHighlightIds: [],
        suggestionIds: [],
        suppressedHighlightIds: [],
      };
    }

    const activeRepositoryRefresh = await tx.knowledgeRefreshRun.findFirst({
      where: {
        workItemId: runIdentity.workItemId,
        status: { in: [...ACTIVE_REPOSITORY_REFRESH_STATUSES] },
      },
      select: { id: true },
    });
    if (activeRepositoryRefresh) {
      return { status: "deferred_repository_refresh" };
    }

    const evidenceIds = request.evidenceItems.map((item) => item.id);
    // Lock every manual Evidence row, including currently excluded rows, before
    // comparing the complete included set. Inclusion changes therefore cannot
    // slip between validation and persistence, while WorkItem-row locking
    // fences newly inserted Evidence and Work Item deletion.
    await tx.$queryRaw`
      SELECT evidence."id"
      FROM "EvidenceItem" AS evidence
      INNER JOIN "Source" AS source ON source."id" = evidence."sourceId"
      WHERE evidence."workItemId" = ${runIdentity.workItemId}
        AND evidence."type" = 'manual_note_excerpt'
        AND source."type" = 'manual_note'
      FOR UPDATE OF evidence
    `;
    const evidenceRows = await loadCompleteManualEvidenceRows(tx, runIdentity.workItemId);
    if (!evidenceMatchesRequest(evidenceRows, request, lockedWorkItem)) {
      return {
        status: "superseded_input",
        terminalOutcome: "superseded_input",
        createdHighlightIds: [],
        replayedHighlightIds: [],
        deduplicatedHighlightIds: [],
        suggestionIds: [],
        suppressedHighlightIds: [],
      };
    }

    const allExistingRows = await tx.highlight.findMany({
      where: { workItemId: runIdentity.workItemId },
      include: {
        evidence: { include: { evidenceItem: { include: { source: true } } } },
        tags: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const allExisting = allExistingRows.map(mapHighlight);
    const relevantExisting = allExisting.filter((highlight) =>
      highlight.lifecycleStatus === "active" ||
      highlight.lifecycleStatus === "needs_validation" ||
      highlight.lifecycleStatus === "quarantined" ||
      (
        managedBy(highlight) === MANUAL_EVIDENCE_HIGHLIGHT_MANAGER &&
        (highlight.lifecycleStatus === "stale" || highlight.lifecycleStatus === "retired")
      )
    );
    const allowedEvidenceIds = new Set(evidenceIds);
    const sourceIdByEvidenceId = new Map(
      evidenceRows.map((item) => [item.id, item.sourceId]),
    );
    const createdHighlightIds: string[] = [];
    const replayedHighlightIds: string[] = [];
    const deduplicatedHighlightIds: string[] = [];
    const suggestionIds: string[] = [];
    const suppressedHighlightIds: string[] = [];
    const processedDrafts: ClaimDraft[] = [];
    const generatedModelId = resolveActiveTextModelIdentity("drafting").modelId;

    for (const rawDraft of input.plan.drafts) {
      if (!draftEvidenceIsScoped(rawDraft, allowedEvidenceIds)) continue;
      const citedEvidenceIds = Array.from(new Set(
        rawDraft.evidence.sourceRefs.flatMap((reference) =>
          reference.evidenceItemId ? [reference.evidenceItemId] : []
        ),
      ));
      const citedSourceIds = Array.from(new Set(
        citedEvidenceIds.flatMap((evidenceId) => {
          const sourceId = sourceIdByEvidenceId.get(evidenceId);
          return sourceId ? [sourceId] : [];
        }),
      )).sort();
      const evidenceContentHashes = Object.fromEntries(
        request.evidenceItems
          .filter((item) => citedEvidenceIds.includes(item.id))
          .map((item) => [item.id, item.contentHash]),
      );
      const draft: ClaimDraft = {
        ...rawDraft,
        metadata: {
          ...(jsonRecord(rawDraft.metadata) ?? {}),
          managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
          originatingAgentRunId: input.runId,
          inputFingerprint: request.inputFingerprint,
          policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
          sourceIds: citedSourceIds,
          evidenceIds: citedEvidenceIds,
          evidenceContentHashes,
        },
      };
      if (processedDrafts.some((processed) =>
        areNearDuplicateHighlights(processed, draft)
      )) {
        continue;
      }
      processedDrafts.push(draft);
      const replayed = allExisting.find((highlight) =>
        managedBy(highlight) === MANUAL_EVIDENCE_HIGHLIGHT_MANAGER &&
        originatingAgentRunId(highlight) === input.runId &&
        areNearDuplicateHighlights(highlight, draft)
      );
      if (replayed) {
        replayedHighlightIds.push(replayed.id);
        deduplicatedHighlightIds.push(replayed.id);
        continue;
      }
      const nearMatches = relevantExisting.filter((highlight) =>
        areNearDuplicateHighlights(highlight, draft)
      );
      const suppressingMatch = nearMatches.find((highlight) =>
        highlight.verificationStatus === "rejected" ||
        highlight.lifecycleStatus === "quarantined"
      );
      if (suppressingMatch) {
        deduplicatedHighlightIds.push(suppressingMatch.id);
        suppressedHighlightIds.push(suppressingMatch.id);
        continue;
      }
      const currentCanonicalMatch = nearMatches.find((highlight) =>
        highlight.lifecycleStatus === "active" ||
        highlight.lifecycleStatus === "needs_validation"
      ) ?? null;
      const staleManualMatch = nearMatches.find((highlight) =>
        managedBy(highlight) === MANUAL_EVIDENCE_HIGHLIGHT_MANAGER &&
        (highlight.lifecycleStatus === "retired" || highlight.lifecycleStatus === "stale")
      ) ?? null;
      // Current canonical knowledge always wins over an older manual history
      // row. A stale manual row is considered only when no live canonical row
      // exists, preventing a successor from duplicating repository memory.
      const match = currentCanonicalMatch ?? staleManualMatch;
      let supersedesManualHighlightId: string | null = null;
      if (match) {
        deduplicatedHighlightIds.push(match.id);
        if (
          managedBy(match) === MANUAL_EVIDENCE_HIGHLIGHT_MANAGER &&
          (match.lifecycleStatus === "retired" || match.lifecycleStatus === "stale")
        ) {
          // Preserve immutable provenance/history. The freshly grounded row is
          // a successor rather than an in-place rewrite of stale manual output.
          supersedesManualHighlightId = match.id;
        } else {
          const existingSuggestion = await tx.highlightSuggestion.findFirst({
            where: {
              sourceHighlightId: match.id,
              status: "pending",
              suggestionType: "manual_evidence_support",
            },
            orderBy: { createdAt: "desc" },
          });
          const suggestionData = {
            workItemId: runIdentity.workItemId,
            sourceHighlightId: match.id,
            suggestionType: "manual_evidence_support",
            currentSnapshot: snapshotHighlight(match) as Prisma.InputJsonValue,
            suggestedDraft: serializeHighlightDraft(draft) as Prisma.InputJsonValue,
            matchReason:
              managedBy(match) === MANUAL_EVIDENCE_HIGHLIGHT_MANAGER
                ? "Current manual Evidence overlaps this existing automatic Highlight; review the revised grounding without rewriting its provenance."
                : "New manual Evidence overlaps this canonical Highlight; review the proposed support without changing repository-managed memory automatically.",
            cosineDistance: null,
            sourceEvidenceIds: citedEvidenceIds as Prisma.InputJsonValue,
            generationRunIds: input.plan.generationRunIds as Prisma.InputJsonValue,
          };
          const suggestion = existingSuggestion
            ? await tx.highlightSuggestion.update({
                where: { id: existingSuggestion.id },
                data: suggestionData,
              })
            : await tx.highlightSuggestion.create({ data: suggestionData });
          suggestionIds.push(suggestion.id);
          continue;
        }
      }

      const quarantined =
        draft.sensitivityFlag ||
        draft.confidence === "low" ||
        draft.verificationStatus !== "approved";
      const created = await createHighlightWithRelations({
        tx,
        workItemId: runIdentity.workItemId,
        draft,
      });
      await tx.highlight.update({
        where: { id: created.id },
        data: {
          lifecycleStatus: quarantined ? "quarantined" : "active",
          reviewState: "pending_review",
          approvalSource: "automation",
          publicSafetyStatus: "not_eligible",
          autoAppliedAt:
            !quarantined && draft.verificationStatus === "approved"
              ? new Date()
              : null,
          supersedesHighlightId: supersedesManualHighlightId,
        },
      });
      const draftMetadata = jsonRecord(draft.metadata);
      const knowledgeChangeModelId =
        draftMetadata?.generationStrategy === "exact_manual_evidence_fallback"
          ? `deterministic/${MANUAL_EVIDENCE_EXTRACTIVE_POLICY_VERSION}`
          : generatedModelId;
      await upsertReviewableKnowledgeChangeInTransaction({
        workItemId: runIdentity.workItemId,
        entityKind: "highlight",
        action: quarantined ? "quarantined" : "created",
        entityId: created.id,
        afterSnapshot: {
          id: created.id,
          text: draft.text,
          summary: draft.summary,
          lifecycleStatus: quarantined ? "quarantined" : "active",
          approvalSource: "automation",
          managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
        },
        reason: quarantined
          ? "Manual Evidence produced a Highlight that requires review before private use."
          : supersedesManualHighlightId
            ? "Current manual Evidence produced a grounded successor while preserving the stale Highlight's history."
            : "Manual Evidence produced an automatically managed Highlight for review.",
        provenance: {
          agentRunId: input.runId,
          evidenceIds: citedEvidenceIds,
          sourceIds: citedSourceIds,
          inputFingerprint: request.inputFingerprint,
          managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
          supersedesHighlightId: supersedesManualHighlightId,
        },
        policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
        modelId: knowledgeChangeModelId,
        idempotencyKey: [
          "manual-evidence-highlight",
          input.runId,
          sha256(normalizeWhitespace(draft.text)).slice(0, 16),
        ].join(":"),
      }, tx);
      createdHighlightIds.push(created.id);
    }

    return {
      status: "persisted",
      terminalOutcome:
        createdHighlightIds.length || replayedHighlightIds.length || suggestionIds.length
        ? "ready"
        : "no_safe_candidates",
      createdHighlightIds,
      replayedHighlightIds: Array.from(new Set(replayedHighlightIds)),
      deduplicatedHighlightIds: Array.from(new Set(deduplicatedHighlightIds)),
      suggestionIds: Array.from(new Set(suggestionIds)),
      suppressedHighlightIds: Array.from(new Set(suppressedHighlightIds)),
    };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 10_000,
  });
}

export async function finalizeManualEvidenceHighlights(input: {
  runId: string;
  plan: ManualEvidenceHighlightPreparedPlan | null;
  result: Exclude<
    ManualEvidenceHighlightPersistenceResult,
    { status: "deferred_repository_refresh" } | { status: "inactive" }
  >;
}) {
  const generationRunIds = input.plan?.generationRunIds ?? [];
  const resultRefs = {
    agentRunId: input.runId,
    originatingAgentRunId: input.runId,
    managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
    inputFingerprint: input.plan?.inputFingerprint ?? null,
    terminalOutcome: input.result.terminalOutcome,
    persistedHighlightIds: Array.from(new Set([
      ...input.result.createdHighlightIds,
      ...input.result.replayedHighlightIds,
    ])),
    replayedHighlightIds: input.result.replayedHighlightIds,
    deduplicatedHighlightIds: input.result.deduplicatedHighlightIds,
    suggestionIds: input.result.suggestionIds,
    suppressedHighlightIds: input.result.suppressedHighlightIds,
  } as Prisma.InputJsonValue;
  await Promise.all(
    generationRunIds.map((generationRunId) =>
      updateGenerationRunResultRefs(generationRunId, resultRefs)
    ),
  );

  const finalized = await prisma.$transaction(async (tx) => {
    const identity = await tx.agentRun.findUnique({
      where: { id: input.runId },
      select: { workItemId: true },
    });
    if (!identity) return { persisted: false as const, status: "missing" };
    const lockedWorkItems = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "WorkItem" WHERE "id" = ${identity.workItemId} FOR UPDATE
    `;
    if (!lockedWorkItems.length) return { persisted: false as const, status: "missing" };
    const runs = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status"
      FROM "AgentRun"
      WHERE "id" = ${input.runId}
      FOR UPDATE
    `;
    if (!runs[0] || !ACTIVE_AGENT_RUN_STATUSES.has(runs[0].status)) {
      return { persisted: false as const, status: runs[0]?.status ?? "missing" };
    }
    const result = {
      terminalOutcome: input.result.terminalOutcome,
      createdHighlightIds: input.result.createdHighlightIds,
      replayedHighlightIds: input.result.replayedHighlightIds,
      deduplicatedHighlightIds: input.result.deduplicatedHighlightIds,
      suggestionIds: input.result.suggestionIds,
      suppressedHighlightIds: input.result.suppressedHighlightIds,
      generationRunIds,
      managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
      inputFingerprint: input.plan?.inputFingerprint ?? null,
    };
    await tx.agentRun.update({
      where: { id: input.runId },
      data: {
        status: "completed",
        result: toInputJson(result),
        error: Prisma.JsonNull,
        finishedAt: new Date(),
      },
    });
    return { persisted: true as const, status: "completed" as const, result };
  }, { timeout: 10_000 });

  if (!finalized.persisted) return finalized;

  // Highlight persistence and AgentRun completion are authoritative. The
  // semantic index is a repairable projection, so a provider outage or a
  // deletion racing this post-commit work must never turn a completed run
  // into a failed one. Repository/chat freshness paths can backfill missing
  // embeddings later.
  const persistedHighlightIds = Array.from(new Set([
    ...input.result.createdHighlightIds,
    ...input.result.replayedHighlightIds,
  ]));
  if (persistedHighlightIds.length) {
    const highlights = await prisma.highlight.findMany({
      where: {
        id: { in: persistedHighlightIds },
        lifecycleStatus: "active",
      },
      include: {
        evidence: { include: { evidenceItem: { include: { source: true } } } },
        tags: true,
      },
    });
    const embeddingResults = await Promise.allSettled(
      highlights.map((highlight) => {
        const snapshot = mapHighlight(highlight);
        return upsertHighlightEmbedding({
          highlightId: snapshot.id,
          inputText: buildHighlightEmbeddingText(snapshot),
        });
      }),
    );
    const failedEmbeddingCount = embeddingResults.filter(
      (result) => result.status === "rejected",
    ).length;
    if (failedEmbeddingCount) {
      console.warn("Manual Highlight embedding backfill deferred.", {
        runId: input.runId,
        failedEmbeddingCount,
      });
    }
  }

  return finalized;
}
