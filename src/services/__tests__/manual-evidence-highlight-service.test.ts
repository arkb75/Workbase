import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimDraft } from "@/src/domain/types";

const prismaMock = vi.hoisted(() => ({
  agentRun: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  evidenceItem: { findMany: vi.fn() },
  workItem: { findUnique: vi.fn() },
  highlight: { findMany: vi.fn() },
  knowledgeRefreshRun: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
const generateMock = vi.hoisted(() => vi.fn());
const verifyMock = vi.hoisted(() => vi.fn());
const normalizeMock = vi.hoisted(() => vi.fn());
const createHighlightMock = vi.hoisted(() => vi.fn());
const upsertChangeMock = vi.hoisted(() => vi.fn());
const upsertEmbeddingMock = vi.hoisted(() => vi.fn());

vi.mock("@/src/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/src/services/claim-research-service", () => ({
  claimResearchService: { generate: generateMock },
}));
vi.mock("@/src/services/claim-verification-service", () => ({
  claimVerificationService: { verify: verifyMock },
}));
vi.mock("@/src/services/source-ingestion-service", () => ({
  sourceIngestionService: { normalize: normalizeMock },
}));
vi.mock("@/src/lib/evidence-persistence", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/src/lib/evidence-persistence")>();
  return {
    ...original,
    createHighlightWithRelations: createHighlightMock,
  };
});
vi.mock("@/src/services/knowledge-change-service", () => ({
  upsertReviewableKnowledgeChangeInTransaction: upsertChangeMock,
}));
vi.mock("@/src/services/highlight-embedding-service", () => ({
  buildHighlightEmbeddingText: vi.fn(() => "embedding text"),
  upsertHighlightEmbedding: upsertEmbeddingMock,
}));
vi.mock("@/src/lib/llm-config", () => ({
  resolveActiveTextModelIdentity: vi.fn(() => ({ modelId: "test-model" })),
}));
vi.mock("@/src/lib/generation-runs", () => ({
  updateGenerationRunResultRefs: vi.fn(),
}));

import {
  MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
  MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
  MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
  buildManualEvidenceHighlightRequest,
  buildCurrentManualEvidenceHighlightRequest,
  persistManualEvidenceHighlights,
  prepareManualEvidenceHighlights,
  readManualEvidenceHighlightRequest,
  reconcileManualEvidenceHighlightsForInput,
} from "@/src/services/manual-evidence-highlight-service";

const createdAt = new Date("2026-08-09T00:00:00.000Z");
const workItemContext = {
  id: "work-1",
  title: "Workbase",
  type: "project" as const,
  description: "Career knowledge workspace",
};

function runIdentity() {
  return { workItemId: workItemContext.id, workItem: workItemContext };
}

function evidenceRow(id: string, content = `Evidence ${id}`) {
  return {
    id,
    workItemId: "work-1",
    sourceId: `source-${id}`,
    externalId: `external-${id}`,
    type: "manual_note_excerpt" as const,
    title: `Note ${id}`,
    content,
    searchText: content,
    parentKind: "manual_note",
    parentKey: `source-${id}`,
    included: true,
    lifecycleStatus: "active",
    reviewState: "reviewed",
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    source: {
      id: `source-${id}`,
      workItemId: "work-1",
      type: "manual_note" as const,
      label: `Manual ${id}`,
      externalId: null,
      rawContent: content,
      metadata: {},
      createdAt,
      updatedAt: createdAt,
    },
    tags: [],
  };
}

function requestFor(rows: ReturnType<typeof evidenceRow>[]) {
  return buildManualEvidenceHighlightRequest({
    workItem: workItemContext,
    trigger: "manual_source_add",
    evidenceItems: rows,
  });
}

function approvedDraft(evidenceId = "evidence-1"): ClaimDraft {
  return {
    text: "Reduced repository import latency by parallelizing safe API reads.",
    summary: "Faster repository imports",
    confidence: "high",
    ownershipClarity: "clear",
    sensitivityFlag: false,
    verificationStatus: "approved",
    visibility: "private",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: "Supported by the manual note.",
    metadata: null,
    evidence: {
      summary: "Manual evidence",
      verificationNotes: "Supported",
      sourceRefs: [{
        evidenceItemId: evidenceId,
        sourceId: "source-evidence-1",
        sourceType: "manual_note",
        sourceLabel: "Manual evidence-1",
        title: "Note evidence-1",
        excerpt: "Evidence evidence-1",
      }],
    },
    tags: [],
  };
}

function existingHighlight(input: {
  id: string;
  row: ReturnType<typeof evidenceRow>;
  request: ReturnType<typeof requestFor>;
  runId?: string;
  policyVersion?: string;
  lifecycleStatus?: "active" | "needs_validation" | "stale" | "retired" | "quarantined";
  verificationStatus?: "approved" | "draft" | "flagged" | "rejected";
}) {
  const draft = approvedDraft(input.row.id);
  return {
    id: input.id,
    workItemId: "work-1",
    text: draft.text,
    summary: draft.summary,
    searchText: draft.text,
    confidence: draft.confidence,
    ownershipClarity: draft.ownershipClarity,
    sensitivityFlag: false,
    verificationStatus: input.verificationStatus ?? "approved",
    lifecycleStatus: input.lifecycleStatus ?? "active",
    reviewState: "pending_review",
    approvalSource: "automation",
    publicSafetyStatus: "not_eligible",
    validatedThroughSha: null,
    validationHeads: null,
    lastValidatedAt: null,
    autoAppliedAt: createdAt,
    supersedesHighlightId: null,
    visibility: "private",
    risksSummary: null,
    missingInfo: null,
    rejectionReason: null,
    verificationNotes: draft.verificationNotes,
    metadata: {
      managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
      policyVersion:
        input.policyVersion ?? MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
      originatingAgentRunId: input.runId ?? "run-prior",
      inputFingerprint: input.request.inputFingerprint,
      evidenceContentHashes: {
        [input.row.id]: input.request.evidenceItems[0]!.contentHash,
      },
    },
    createdAt,
    updatedAt: createdAt,
    evidence: [{
      evidenceItemId: input.row.id,
      evidenceItem: {
        ...input.row,
        sourceId: input.row.sourceId,
        title: input.row.title,
        content: input.row.content,
        source: input.row.source,
      },
    }],
    tags: [],
  };
}

describe("manual Evidence Highlight input fencing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.workItem.findUnique.mockResolvedValue({
      id: "work-1",
      title: "Workbase",
      type: "project",
      description: "Career knowledge workspace",
    });
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback(prismaMock));
  });

  it("supersedes an old request before provider calls when a new included row appears", async () => {
    const original = evidenceRow("evidence-1");
    const request = requestFor([original]);
    prismaMock.agentRun.findUnique.mockResolvedValue({
      id: "run-1",
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      status: "running",
      workItemId: "work-1",
      request,
      researchState: null,
      workItem: {
        id: "work-1",
        userId: "user-1",
        title: "Workbase",
        type: "project",
        description: "Career knowledge workspace",
        startDate: null,
        endDate: null,
      },
    });
    prismaMock.evidenceItem.findMany.mockResolvedValue([
      original,
      evidenceRow("evidence-2"),
    ]);

    await expect(prepareManualEvidenceHighlights("run-1")).resolves.toEqual({
      status: "superseded_input",
      inputFingerprint: request.inputFingerprint,
    });
    expect(normalizeMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("content-addresses system-owned description Evidence for a description-only Work Item", async () => {
    const description = evidenceRow(
      "description-evidence",
      "Built a durable career knowledge workspace.",
    );
    description.source.metadata = {
      kind: "work_item_description",
      systemOwned: true,
    };
    description.parentKind = "work_item";
    description.parentKey = "work-1";
    prismaMock.evidenceItem.findMany.mockResolvedValueOnce([description]);

    const request = await buildCurrentManualEvidenceHighlightRequest({
      workItemId: "work-1",
      trigger: "work_item_create",
    });

    expect(request).toMatchObject({
      trigger: "work_item_create",
      sourceIds: [description.sourceId],
      evidenceItems: [{
        id: description.id,
        sourceId: description.sourceId,
        externalId: description.externalId,
        included: true,
      }],
      inputFingerprint: expect.any(String),
      executionKey: expect.stringContaining(
        `${MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION}:manual-evidence-highlight-request-v2:work-1:`,
      ),
    });
  });

  it("fingerprints every provider-facing Evidence field and canonical Work Item context", () => {
    const row = evidenceRow("evidence-1", "Led a grounded provider migration.");
    const baseline = requestFor([row]);
    const variants = [
      { ...row, searchText: `${row.searchText} routing` },
      { ...row, metadata: { sourceType: "manual_note", reviewer: "user" } },
      { ...row, source: { ...row.source, label: "Renamed notes" } },
      { ...row, source: { ...row.source, rawContent: `${row.content} Edited.` } },
      { ...row, source: { ...row.source, metadata: { imported: true } } },
    ];
    for (const variant of variants) {
      expect(requestFor([variant]).inputFingerprint).not.toBe(
        baseline.inputFingerprint,
      );
    }
    const renamedWorkItem = buildManualEvidenceHighlightRequest({
      workItem: { ...workItemContext, title: "Renamed Workbase" },
      trigger: "manual_source_add",
      evidenceItems: [row],
    });
    expect(renamedWorkItem.inputFingerprint).not.toBe(
      baseline.inputFingerprint,
    );
  });

  it("rejects prior-policy requests and prepared checkpoints before provider replay", async () => {
    const row = evidenceRow("evidence-1");
    const currentRequest = requestFor([row]);
    const priorPolicyRequest = {
      ...currentRequest,
      policyVersion: "manual-evidence-highlights-v1",
      executionKey: currentRequest.executionKey.replace(
        MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
        "manual-evidence-highlights-v1",
      ),
    };
    expect(readManualEvidenceHighlightRequest(priorPolicyRequest)).toBeNull();
    prismaMock.agentRun.findUnique.mockResolvedValue({
      id: "run-prior-policy",
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      status: "running",
      workItemId: "work-1",
      request: priorPolicyRequest,
      researchState: {
        kind: "manual_evidence_highlight_plan",
        policyVersion: "manual-evidence-highlights-v1",
        inputFingerprint: currentRequest.inputFingerprint,
        drafts: [approvedDraft(row.id)],
        generationRunIds: ["generation-prior-policy"],
      },
      workItem: {
        id: "work-1",
        userId: "user-1",
        title: "Workbase",
        type: "project",
        description: "Career knowledge workspace",
        startDate: null,
        endDate: null,
      },
    });

    await expect(
      prepareManualEvidenceHighlights("run-prior-policy"),
    ).rejects.toThrow("invalid evidence request");
    expect(normalizeMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("regenerates instead of replaying a prior-policy checkpoint on a current run", async () => {
    const row = evidenceRow("evidence-1");
    const currentRequest = requestFor([row]);
    prismaMock.agentRun.findUnique.mockResolvedValue({
      id: "run-current-policy",
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      status: "running",
      workItemId: "work-1",
      request: currentRequest,
      researchState: {
        kind: "manual_evidence_highlight_plan",
        policyVersion: "manual-evidence-highlights-v1",
        inputFingerprint: currentRequest.inputFingerprint,
        drafts: [approvedDraft(row.id)],
        generationRunIds: ["generation-prior-policy"],
      },
      workItem: {
        id: "work-1",
        userId: "user-1",
        title: "Workbase",
        type: "project",
        description: "Career knowledge workspace",
        startDate: null,
        endDate: null,
      },
    });
    prismaMock.evidenceItem.findMany.mockResolvedValue([row]);
    prismaMock.highlight.findMany.mockResolvedValue([]);
    normalizeMock.mockResolvedValue([]);
    generateMock.mockResolvedValue({
      highlights: [],
      generationRunIds: {
        generation: ["generation-current-policy"],
        verification: null,
      },
    });
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      prepareManualEvidenceHighlights("run-current-policy"),
    ).resolves.toEqual({
      status: "prepared",
      plan: {
        inputFingerprint: currentRequest.inputFingerprint,
        drafts: [],
        generationRunIds: ["generation-current-policy"],
      },
    });
    expect(generateMock).toHaveBeenCalledOnce();
    expect(verifyMock).not.toHaveBeenCalled();
    expect(prismaMock.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          researchState: expect.objectContaining({
            policyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
            generationRunIds: ["generation-current-policy"],
          }),
        },
      }),
    );
  });

  it("keeps distinct approved Highlights from the paragraph cited by the exact fallback", async () => {
    const paragraph = evidenceRow(
      "evidence-1",
      [
        "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter.",
        "Implemented profile-specific routing and durable provider cost attribution.",
      ].join(" "),
    );
    paragraph.metadata = {
      kind: "user_authored_manual_note",
      userAuthored: true,
      ownershipPolicyVersion: "user-authored-manual-note-v1",
    };
    paragraph.source.metadata = {
      kind: "user_authored_manual_note_source",
      userAuthored: true,
      ownershipPolicyVersion: "user-authored-manual-note-v1",
    };
    const currentRequest = requestFor([paragraph]);
    prismaMock.agentRun.findUnique.mockResolvedValue({
      id: "run-paragraph",
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      status: "running",
      workItemId: "work-1",
      request: currentRequest,
      researchState: null,
      workItem: {
        id: "work-1",
        userId: "user-1",
        title: "Workbase",
        type: "project",
        description: "Career knowledge workspace",
        startDate: null,
        endDate: null,
      },
    });
    prismaMock.evidenceItem.findMany.mockResolvedValue([paragraph]);
    prismaMock.highlight.findMany.mockResolvedValue([]);
    normalizeMock.mockResolvedValue([]);
    const distinctDraft = {
      ...approvedDraft(paragraph.id),
      text: "Implemented profile-specific routing and durable provider cost attribution.",
      summary: "Implemented profile-specific routing and durable provider cost attribution.",
      evidence: {
        ...approvedDraft(paragraph.id).evidence,
        sourceRefs: [{
          ...approvedDraft(paragraph.id).evidence.sourceRefs[0]!,
          excerpt: paragraph.content,
        }],
      },
    };
    generateMock.mockResolvedValue({
      highlights: [distinctDraft],
      generationRunIds: {
        generation: ["generation-paragraph"],
        verification: null,
      },
    });
    verifyMock.mockResolvedValue([distinctDraft]);
    prismaMock.agentRun.updateMany.mockResolvedValue({ count: 1 });

    const prepared = await prepareManualEvidenceHighlights("run-paragraph");

    expect(prepared).toMatchObject({
      status: "prepared",
      plan: {
        drafts: [
          { text: "Led the Workbase model-runtime migration from AWS Bedrock to OpenRouter." },
          { text: distinctDraft.text },
        ],
      },
    });
  });

  it("supersedes an old request before provider calls when captured content changes", async () => {
    const original = evidenceRow("evidence-1");
    const request = requestFor([original]);
    prismaMock.agentRun.findUnique.mockResolvedValue({
      id: "run-1",
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      status: "running",
      workItemId: "work-1",
      request,
      researchState: null,
      workItem: {
        id: "work-1",
        userId: "user-1",
        title: "Workbase",
        type: "project",
        description: "Career knowledge workspace",
        startDate: null,
        endDate: null,
      },
    });
    prismaMock.evidenceItem.findMany.mockResolvedValue([
      evidenceRow("evidence-1", "Edited after the run was reserved"),
    ]);

    await expect(prepareManualEvidenceHighlights("run-1")).resolves.toMatchObject({
      status: "superseded_input",
    });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("supersedes a reserved request before provider calls when Work Item context changes", async () => {
    const row = evidenceRow("evidence-1");
    const request = requestFor([row]);
    prismaMock.agentRun.findUnique.mockResolvedValue({
      id: "run-context-change",
      kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
      status: "running",
      workItemId: workItemContext.id,
      request,
      researchState: null,
      workItem: {
        ...workItemContext,
        description: "Edited after the run was reserved.",
        userId: "user-1",
        startDate: null,
        endDate: null,
      },
    });
    prismaMock.evidenceItem.findMany.mockResolvedValue([row]);

    await expect(
      prepareManualEvidenceHighlights("run-context-change"),
    ).resolves.toEqual({
      status: "superseded_input",
      inputFingerprint: request.inputFingerprint,
    });
    expect(normalizeMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("retires an active manual Highlight when its supporting content changes", async () => {
    const original = evidenceRow("evidence-1", "Original content");
    const originalRequest = requestFor([original]);
    const editedRequest = requestFor([
      evidenceRow("evidence-1", "Edited content"),
    ]);
    const highlight = existingHighlight({
      id: "highlight-stale-content",
      row: original,
      request: originalRequest,
    });
    const tx = {
      highlight: {
        findMany: vi.fn().mockResolvedValue([highlight]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(reconcileManualEvidenceHighlightsForInput({
      tx: tx as never,
      workItemId: "work-1",
      request: editedRequest,
    })).resolves.toEqual({
      retiredHighlightIds: [highlight.id],
    });
    expect(tx.highlight.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: highlight.id,
        metadata: { equals: highlight.metadata },
        updatedAt: highlight.updatedAt,
      }),
      data: expect.objectContaining({ lifecycleStatus: "retired" }),
    }));
    expect(upsertChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "retired",
      entityId: highlight.id,
    }), tx);
  });

  it("retires quarantined manual output when the last supporting Evidence is excluded", async () => {
    const row = evidenceRow("evidence-1");
    const request = requestFor([row]);
    const highlight = existingHighlight({
      id: "highlight-quarantined",
      row,
      request,
      lifecycleStatus: "quarantined",
      verificationStatus: "flagged",
    });
    const tx = {
      highlight: {
        findMany: vi.fn().mockResolvedValue([highlight]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(reconcileManualEvidenceHighlightsForInput({
      tx: tx as never,
      workItemId: "work-1",
      request: null,
    })).resolves.toEqual({ retiredHighlightIds: [highlight.id] });
    expect(generateMock).not.toHaveBeenCalled();
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("retires a same-input prior-policy draft so the current policy can replace it", async () => {
    const row = evidenceRow("evidence-1");
    const currentRequest = requestFor([row]);
    const priorPolicyDraft = existingHighlight({
      id: "highlight-prior-policy-draft",
      row,
      request: currentRequest,
      policyVersion: "manual-evidence-highlights-v1",
      verificationStatus: "draft",
    });
    const reconciliationTx = {
      highlight: {
        findMany: vi.fn().mockResolvedValue([priorPolicyDraft]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(reconcileManualEvidenceHighlightsForInput({
      tx: reconciliationTx as never,
      workItemId: "work-1",
      request: currentRequest,
    })).resolves.toEqual({
      retiredHighlightIds: [priorPolicyDraft.id],
    });
    expect(reconciliationTx.highlight.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycleStatus: "retired",
          metadata: expect.objectContaining({
            retiredForPolicyVersion: MANUAL_EVIDENCE_HIGHLIGHT_POLICY_VERSION,
          }),
        }),
      }),
    );

    const retiredPriorPolicyDraft = {
      ...priorPolicyDraft,
      lifecycleStatus: "retired" as const,
    };
    const persistenceTx = {
      agentRun: { findUnique: vi.fn().mockResolvedValue(runIdentity()) },
      knowledgeRefreshRun: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceItem: { findMany: vi.fn().mockResolvedValue([row]) },
      highlight: {
        findMany: vi.fn().mockResolvedValue([retiredPriorPolicyDraft]),
        update: vi.fn().mockResolvedValue({ id: "highlight-current-policy" }),
      },
      highlightSuggestion: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([workItemContext])
        .mockResolvedValueOnce([{ locked: 1 }])
        .mockResolvedValueOnce([{
          status: "running",
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          request: currentRequest,
        }])
        .mockResolvedValueOnce([{ id: row.id }]),
    };
    createHighlightMock.mockResolvedValue({ id: "highlight-current-policy" });
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof persistenceTx) => unknown) =>
        callback(persistenceTx),
    );

    await expect(persistManualEvidenceHighlights({
      runId: "run-current-policy",
      plan: {
        inputFingerprint: currentRequest.inputFingerprint,
        drafts: [approvedDraft(row.id)],
        generationRunIds: [],
      },
    })).resolves.toMatchObject({
      status: "persisted",
      terminalOutcome: "ready",
      createdHighlightIds: ["highlight-current-policy"],
      suggestionIds: [],
    });
    expect(persistenceTx.highlight.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "highlight-current-policy" },
        data: expect.objectContaining({
          lifecycleStatus: "active",
          supersedesHighlightId: priorPolicyDraft.id,
        }),
      }),
    );
    expect(persistenceTx.highlightSuggestion.create).not.toHaveBeenCalled();
  });

  it("keeps a replayed run terminal-ready when its Highlight was already created", async () => {
    const row = evidenceRow("evidence-1");
    const request = requestFor([row]);
    const draft = approvedDraft();
    const priorHighlight = {
      id: "highlight-created-before-replay",
      workItemId: "work-1",
      text: draft.text,
      summary: draft.summary,
      confidence: draft.confidence,
      ownershipClarity: draft.ownershipClarity,
      sensitivityFlag: false,
      verificationStatus: "approved",
      lifecycleStatus: "active",
      reviewState: "pending_review",
      approvalSource: "automation",
      publicSafetyStatus: "not_eligible",
      validatedThroughSha: null,
      visibility: "private",
      risksSummary: null,
      missingInfo: null,
      rejectionReason: null,
      verificationNotes: draft.verificationNotes,
      metadata: {
        managedBy: MANUAL_EVIDENCE_HIGHLIGHT_MANAGER,
        originatingAgentRunId: "run-1",
        inputFingerprint: request.inputFingerprint,
      },
      createdAt,
      updatedAt: createdAt,
      evidence: [{
        evidenceItemId: row.id,
        evidenceItem: {
          sourceId: row.sourceId,
          title: row.title,
          content: row.content,
          source: { id: row.source.id, label: row.source.label, type: "manual_note" },
        },
      }],
      tags: [],
    };
    const tx = {
      agentRun: { findUnique: vi.fn().mockResolvedValue(runIdentity()) },
      knowledgeRefreshRun: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceItem: { findMany: vi.fn().mockResolvedValue([row]) },
      highlight: { findMany: vi.fn().mockResolvedValue([priorHighlight]) },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([workItemContext])
        .mockResolvedValueOnce([{ locked: 1 }])
        .mockResolvedValueOnce([{
          status: "running",
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          request,
        }])
        .mockResolvedValueOnce([{ id: row.id }]),
    };
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(persistManualEvidenceHighlights({
      runId: "run-1",
      plan: {
        inputFingerprint: request.inputFingerprint,
        drafts: [draft],
        generationRunIds: ["generation-1"],
      },
    })).resolves.toEqual({
      status: "persisted",
      terminalOutcome: "ready",
      createdHighlightIds: [],
      replayedHighlightIds: [priorHighlight.id],
      deduplicatedHighlightIds: [priorHighlight.id],
      suggestionIds: [],
      suppressedHighlightIds: [],
    });
    expect(createHighlightMock).not.toHaveBeenCalled();
    expect(upsertChangeMock).not.toHaveBeenCalled();
  });

  it("validates persistence against Work Item context returned by the row lock", async () => {
    const row = evidenceRow("evidence-1");
    const request = requestFor([row]);
    const editedContext = {
      ...workItemContext,
      description: "Edited after the run was prepared.",
    };
    const tx = {
      agentRun: { findUnique: vi.fn().mockResolvedValue(runIdentity()) },
      knowledgeRefreshRun: { findFirst: vi.fn() },
      evidenceItem: { findMany: vi.fn() },
      highlight: { findMany: vi.fn() },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([editedContext])
        .mockResolvedValueOnce([{ locked: 1 }])
        .mockResolvedValueOnce([{
          status: "running",
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          request,
        }])
        .mockResolvedValueOnce([{ id: row.id }]),
    };
    tx.evidenceItem.findMany.mockResolvedValue([row]);
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(persistManualEvidenceHighlights({
      runId: "run-edited-context",
      plan: {
        inputFingerprint: request.inputFingerprint,
        drafts: [approvedDraft(row.id)],
        generationRunIds: [],
      },
    })).resolves.toEqual({
      status: "superseded_input",
      terminalOutcome: "superseded_input",
      createdHighlightIds: [],
      replayedHighlightIds: [],
      deduplicatedHighlightIds: [],
      suggestionIds: [],
      suppressedHighlightIds: [],
    });
    expect(tx.highlight.findMany).not.toHaveBeenCalled();
    expect(createHighlightMock).not.toHaveBeenCalled();
  });

  it("suppresses a later AgentRun against an existing quarantined manual near-match", async () => {
    const original = evidenceRow("evidence-1");
    const added = evidenceRow("evidence-2");
    const originalRequest = requestFor([original]);
    const currentRequest = requestFor([original, added]);
    const quarantined = existingHighlight({
      id: "highlight-quarantined-prior-run",
      row: original,
      request: originalRequest,
      runId: "run-prior",
      lifecycleStatus: "quarantined",
      verificationStatus: "flagged",
    });
    const tx = {
      agentRun: { findUnique: vi.fn().mockResolvedValue(runIdentity()) },
      knowledgeRefreshRun: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceItem: { findMany: vi.fn().mockResolvedValue([original, added]) },
      highlight: { findMany: vi.fn().mockResolvedValue([quarantined]) },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([workItemContext])
        .mockResolvedValueOnce([{ locked: 1 }])
        .mockResolvedValueOnce([{
          status: "running",
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          request: currentRequest,
        }])
        .mockResolvedValueOnce([{ id: original.id }, { id: added.id }]),
    };
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(persistManualEvidenceHighlights({
      runId: "run-current",
      plan: {
        inputFingerprint: currentRequest.inputFingerprint,
        drafts: [approvedDraft(original.id)],
        generationRunIds: [],
      },
    })).resolves.toEqual({
      status: "persisted",
      terminalOutcome: "no_safe_candidates",
      createdHighlightIds: [],
      replayedHighlightIds: [],
      deduplicatedHighlightIds: [quarantined.id],
      suggestionIds: [],
      suppressedHighlightIds: [quarantined.id],
    });
    expect(createHighlightMock).not.toHaveBeenCalled();
  });

  it("persists only one row when verification returns two near-duplicate drafts", async () => {
    const row = evidenceRow("evidence-1");
    const uncitedRow = evidenceRow("evidence-2");
    const request = requestFor([row, uncitedRow]);
    const first = approvedDraft(row.id);
    first.evidence.sourceRefs[0]!.sourceId = "stale-provider-source-id";
    const second = {
      ...approvedDraft(row.id),
      text: `${first.text} `,
      summary: "The same grounded accomplishment",
    };
    const tx = {
      agentRun: { findUnique: vi.fn().mockResolvedValue(runIdentity()) },
      knowledgeRefreshRun: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceItem: { findMany: vi.fn().mockResolvedValue([row, uncitedRow]) },
      highlight: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({ id: "highlight-created" }),
      },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([workItemContext])
        .mockResolvedValueOnce([{ locked: 1 }])
        .mockResolvedValueOnce([{
          status: "running",
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          request,
        }])
        .mockResolvedValueOnce([{ id: row.id }, { id: uncitedRow.id }]),
    };
    createHighlightMock.mockResolvedValue({ id: "highlight-created" });
    upsertChangeMock.mockResolvedValue({ id: "change-1" });
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(persistManualEvidenceHighlights({
      runId: "run-1",
      plan: {
        inputFingerprint: request.inputFingerprint,
        drafts: [first, second],
        generationRunIds: [],
      },
    })).resolves.toMatchObject({
      status: "persisted",
      terminalOutcome: "ready",
      createdHighlightIds: ["highlight-created"],
    });
    expect(createHighlightMock).toHaveBeenCalledTimes(1);
    expect(createHighlightMock).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({
        metadata: expect.objectContaining({
          evidenceIds: [row.id],
          sourceIds: [row.sourceId],
        }),
      }),
    }));
    expect(upsertChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      provenance: expect.objectContaining({
        evidenceIds: [row.id],
        sourceIds: [row.sourceId],
      }),
    }), tx);
    expect(tx.highlight.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ supersedesHighlightId: null }),
    }));
  });

  it("prefers a current repository canonical match over older retired manual history", async () => {
    const row = evidenceRow("evidence-1");
    const request = requestFor([row]);
    const retiredManual = existingHighlight({
      id: "highlight-manual-retired",
      row,
      request,
      lifecycleStatus: "retired",
    });
    const repositoryCanonical = {
      ...existingHighlight({
        id: "highlight-repository-active",
        row,
        request,
      }),
      metadata: {
        managedBy: "repository_knowledge_sync",
        subsystemKey: "repository-import",
      },
    };
    const tx = {
      agentRun: { findUnique: vi.fn().mockResolvedValue(runIdentity()) },
      knowledgeRefreshRun: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceItem: { findMany: vi.fn().mockResolvedValue([row]) },
      highlight: {
        findMany: vi.fn().mockResolvedValue([retiredManual, repositoryCanonical]),
      },
      highlightSuggestion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "suggestion-repository" }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([workItemContext])
        .mockResolvedValueOnce([{ locked: 1 }])
        .mockResolvedValueOnce([{
          status: "running",
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          request,
        }])
        .mockResolvedValueOnce([{ id: row.id }]),
    };
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await expect(persistManualEvidenceHighlights({
      runId: "run-current",
      plan: {
        inputFingerprint: request.inputFingerprint,
        drafts: [approvedDraft(row.id)],
        generationRunIds: [],
      },
    })).resolves.toMatchObject({
      status: "persisted",
      terminalOutcome: "ready",
      createdHighlightIds: [],
      deduplicatedHighlightIds: [repositoryCanonical.id],
      suggestionIds: ["suggestion-repository"],
    });
    expect(tx.highlightSuggestion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceHighlightId: repositoryCanonical.id,
        suggestionType: "manual_evidence_support",
      }),
    });
    expect(createHighlightMock).not.toHaveBeenCalled();
  });

  it("creates a provenance-preserving successor for a stale manual near-match", async () => {
    const row = evidenceRow("evidence-1", "Revised grounding");
    const request = requestFor([row]);
    const staleManual = existingHighlight({
      id: "highlight-manual-stale",
      row,
      request,
      lifecycleStatus: "retired",
      verificationStatus: "draft",
    });
    const tx = {
      agentRun: { findUnique: vi.fn().mockResolvedValue(runIdentity()) },
      knowledgeRefreshRun: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceItem: { findMany: vi.fn().mockResolvedValue([row]) },
      highlight: {
        findMany: vi.fn().mockResolvedValue([staleManual]),
        update: vi.fn().mockResolvedValue({ id: "highlight-successor" }),
      },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([workItemContext])
        .mockResolvedValueOnce([{ locked: 1 }])
        .mockResolvedValueOnce([{
          status: "running",
          kind: MANUAL_EVIDENCE_HIGHLIGHT_AGENT_KIND,
          request,
        }])
        .mockResolvedValueOnce([{ id: row.id }]),
    };
    createHighlightMock.mockResolvedValue({ id: "highlight-successor" });
    prismaMock.$transaction.mockImplementationOnce(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    await persistManualEvidenceHighlights({
      runId: "run-current",
      plan: {
        inputFingerprint: request.inputFingerprint,
        drafts: [approvedDraft(row.id)],
        generationRunIds: [],
      },
    });

    expect(tx.highlight.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "highlight-successor" },
      data: expect.objectContaining({
        lifecycleStatus: "active",
        supersedesHighlightId: staleManual.id,
      }),
    }));
  });
});
