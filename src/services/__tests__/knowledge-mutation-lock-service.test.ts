import { describe, expect, it, vi } from "vitest";
import { lockKnowledgeWorkItemMutation } from "@/src/services/knowledge-mutation-lock-service";

function renderedQuery(call: unknown[]) {
  const strings = call[0] as TemplateStringsArray;
  return Array.from(strings).join("?").replace(/\s+/g, " ").trim();
}

describe("lockKnowledgeWorkItemMutation", () => {
  it("locks the Work Item row before entering the shared advisory-lock namespace", async () => {
    const calls: unknown[][] = [];
    const queryRaw = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return [{ locked: 1 }];
    });

    await lockKnowledgeWorkItemMutation(
      { $queryRaw: queryRaw as never },
      "work-1",
    );

    expect(queryRaw).toHaveBeenCalledOnce();
    const query = renderedQuery(calls[0]!);
    expect(query).toContain('WITH "lockedWorkItem" AS MATERIALIZED');
    expect(query).toContain('FROM "WorkItem" WHERE "id" = ? FOR UPDATE');
    expect(query.indexOf("FOR UPDATE"))
      .toBeLessThan(query.indexOf("pg_advisory_xact_lock"));
    expect(calls[0]![1]).toBe("work-1");
    expect(calls[0]![2]).toBe("work-1");
  });

  it("uses the same advisory-lock key when deletion already removed the parent", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ locked: 1 }]);

    await lockKnowledgeWorkItemMutation(
      { $queryRaw: queryRaw as never },
      "work-deleted",
    );

    const call = queryRaw.mock.calls[0]!;
    expect(renderedQuery(call)).toContain(
      'COALESCE((SELECT "id" FROM "lockedWorkItem"), ?)',
    );
    expect(call.slice(1)).toEqual(["work-deleted", "work-deleted"]);
  });
});
