import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@/src/domain/types";
import {
  buildManualEvidenceItemsFromSource,
  USER_AUTHORED_MANUAL_NOTE_KIND,
  USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
  USER_AUTHORED_MANUAL_NOTE_SOURCE_KIND,
} from "@/src/lib/evidence-items";
import {
  backfillTrustedLegacyManualEvidenceOwnership,
  LEGACY_MANUAL_EVIDENCE_OWNERSHIP_CUTOFF,
} from "@/src/services/manual-evidence-ownership-backfill-service";

const now = new Date("2026-08-11T00:00:00.000Z");

function source(input: {
  id: string;
  externalId?: string | null;
  metadata?: unknown;
  content?: string;
  malformed?: boolean;
  explicitlyMarked?: boolean;
}) {
  const row = {
    id: input.id,
    workItemId: "work-1",
    type: "manual_note" as const,
    label: `Notes ${input.id}`,
    externalId: input.externalId ?? null,
    rawContent:
      input.content ?? "Led the Workbase migration from Bedrock to OpenRouter.",
    metadata: (input.explicitlyMarked
      ? {
          kind: USER_AUTHORED_MANUAL_NOTE_SOURCE_KIND,
          userAuthored: true,
          ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
        }
      : input.metadata ?? null) as JsonValue | null,
    createdAt: now,
    updatedAt: now,
  };
  const expected = buildManualEvidenceItemsFromSource(row)[0]!;
  return {
    ...row,
    evidenceItems: [{
      id: `evidence-${input.id}`,
      sourceId: row.id,
      externalId: expected.externalId,
      type: "manual_note_excerpt" as const,
      title: input.malformed ? "Unrelated imported note" : expected.title,
      content: expected.content,
      searchText: expected.searchText,
      parentKind: expected.parentKind,
      parentKey: expected.parentKey,
      included: true,
      lifecycleStatus: "active",
      reviewState: "reviewed",
      metadata: input.explicitlyMarked
        ? expected.metadata
        : { lineIndex: 0, sourceType: "manual_note" },
      createdAt: now,
      updatedAt: now,
    }],
  };
}

describe("trusted legacy manual Evidence ownership backfill", () => {
  it("marks only an exact legacy UI excerpt and fails closed for system, imported, and malformed rows", async () => {
    const trusted = source({ id: "trusted" });
    const systemDescription = source({
      id: "description",
      externalId: "work-1:work-item-description-source",
      metadata: { kind: "work_item_description", systemOwned: true },
    });
    const imported = source({
      id: "imported",
      externalId: "legacy-import:42",
    });
    const malformed = source({ id: "malformed", malformed: true });
    const alreadyMarked = source({ id: "current", explicitlyMarked: true });
    const db = {
      source: {
        findMany: vi.fn().mockResolvedValue([
          trusted,
          systemDescription,
          imported,
          malformed,
          alreadyMarked,
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      evidenceItem: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(backfillTrustedLegacyManualEvidenceOwnership({
      db: db as never,
      workItemId: "work-1",
    })).resolves.toEqual({
      updatedSourceIds: ["trusted"],
      updatedEvidenceItemIds: ["evidence-trusted"],
    });
    expect(db.source.updateMany).toHaveBeenCalledOnce();
    expect(db.source.updateMany).toHaveBeenCalledWith({
      where: {
        id: "trusted",
        workItemId: "work-1",
        externalId: null,
        updatedAt: now,
      },
      data: {
        metadata: {
          kind: USER_AUTHORED_MANUAL_NOTE_SOURCE_KIND,
          userAuthored: true,
          ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
        },
      },
    });
    expect(db.evidenceItem.updateMany).toHaveBeenCalledOnce();
    expect(db.evidenceItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: "evidence-trusted",
        sourceId: "trusted",
        updatedAt: now,
      },
      data: {
        metadata: expect.objectContaining({
          kind: USER_AUTHORED_MANUAL_NOTE_KIND,
          userAuthored: true,
          ownershipPolicyVersion: USER_AUTHORED_MANUAL_NOTE_POLICY_VERSION,
          lineIndex: 0,
          sourceType: "manual_note",
        }),
      },
    });
  });

  it("does not claim a marker when the optimistic metadata write loses a race", async () => {
    const trusted = source({ id: "trusted" });
    const db = {
      source: {
        findMany: vi.fn().mockResolvedValue([trusted]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      evidenceItem: { updateMany: vi.fn() },
    };

    await expect(backfillTrustedLegacyManualEvidenceOwnership({
      db: db as never,
      workItemId: "work-1",
    })).resolves.toEqual({
      updatedSourceIds: [],
      updatedEvidenceItemIds: [],
    });
    expect(db.evidenceItem.updateMany).not.toHaveBeenCalled();
  });

  it("does not upgrade an unmarked source created after the rollout cutoff", async () => {
    const future = source({ id: "future" });
    future.createdAt = new Date(
      LEGACY_MANUAL_EVIDENCE_OWNERSHIP_CUTOFF.getTime() + 1,
    );
    future.evidenceItems[0]!.createdAt = future.createdAt;
    const db = {
      source: {
        findMany: vi.fn().mockResolvedValue([future]),
        updateMany: vi.fn(),
      },
      evidenceItem: { updateMany: vi.fn() },
    };

    await expect(backfillTrustedLegacyManualEvidenceOwnership({
      db: db as never,
      workItemId: "work-1",
    })).resolves.toEqual({
      updatedSourceIds: [],
      updatedEvidenceItemIds: [],
    });
    expect(db.source.updateMany).not.toHaveBeenCalled();
    expect(db.evidenceItem.updateMany).not.toHaveBeenCalled();
  });
});
