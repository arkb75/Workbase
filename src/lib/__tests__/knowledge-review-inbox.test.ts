import { describe, expect, it } from "vitest";
import { buildKnowledgeReviewInbox } from "@/src/lib/knowledge-review-inbox";

function change(input: {
  id: string;
  entityId?: string;
  entityKind?: "evidence" | "highlight" | "project_fact" | "artifact";
  action?: string;
  lifecycleStatus?: string;
  createdAt?: string;
}) {
  return {
    entityKind: "project_fact" as const,
    entityId: input.entityId ?? input.id,
    action: input.action ?? "created",
    lifecycleStatus: input.lifecycleStatus ?? "active",
    createdAt: input.createdAt ?? "2026-07-12T00:00:00.000Z",
    ...input,
  };
}

describe("knowledge review inbox policy", () => {
  it("coalesces retries or overlapping transitions to the latest card per canonical entity", () => {
    const queue = buildKnowledgeReviewInbox([
      change({ id: "old", entityId: "fact-1", createdAt: "2026-07-11T00:00:00.000Z" }),
      change({ id: "new", entityId: "fact-1", action: "updated", createdAt: "2026-07-12T00:00:00.000Z" }),
    ]);

    expect(queue.knowledgeChanges.map((entry) => entry.id)).toEqual(["new"]);
    expect(queue.coalescedTransitionCount).toBe(1);
  });

  it("prioritizes unsafe and stale knowledge while bounding knowledge and provenance independently", () => {
    const routine = Array.from({ length: 5 }, (_, index) => change({ id: `routine-${index}` }));
    const evidence = Array.from({ length: 4 }, (_, index) => change({
      id: `evidence-${index}`,
      entityKind: "evidence",
    }));
    const queue = buildKnowledgeReviewInbox([
      ...routine,
      ...evidence,
      change({ id: "quarantined", action: "quarantined", lifecycleStatus: "quarantined" }),
      change({ id: "stale", action: "updated", lifecycleStatus: "needs_validation" }),
    ], { knowledge: 3, provenance: 2 });

    expect(queue.knowledgeChanges.map((entry) => entry.id)).toEqual(["quarantined", "stale", "routine-0"]);
    expect(queue.provenanceChanges).toHaveLength(2);
    expect(queue.deferredKnowledgeCount).toBe(4);
    expect(queue.deferredProvenanceCount).toBe(2);
    expect(queue.needsAttentionCount).toBe(2);
    expect(queue.totalProvenanceCount).toBe(4);
  });

  it("uses exact database counts when the loaded review records are already bounded", () => {
    const queue = buildKnowledgeReviewInbox([
      change({ id: "attention", action: "retired", lifecycleStatus: "stale" }),
      change({ id: "routine" }),
      change({ id: "evidence", entityKind: "evidence" }),
    ], {
      counts: {
        totalKnowledgeCount: 73,
        totalProvenanceCount: 65,
        newOrUpdatedKnowledgeCount: 40,
        needsAttentionCount: 33,
      },
    });

    expect(queue.knowledgeChanges).toHaveLength(2);
    expect(queue.provenanceChanges).toHaveLength(1);
    expect(queue.totalKnowledgeCount).toBe(73);
    expect(queue.totalProvenanceCount).toBe(65);
    expect(queue.newOrUpdatedKnowledgeCount).toBe(40);
    expect(queue.needsAttentionCount).toBe(33);
    expect(queue.deferredKnowledgeCount).toBe(71);
    expect(queue.deferredProvenanceCount).toBe(64);
  });
});
