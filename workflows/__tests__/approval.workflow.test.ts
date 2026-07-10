import { resumeHook, start } from "workflow/api";
import { waitForHook } from "@workflow/vitest";
import { describe, expect, it } from "vitest";
import { approvalProbe } from "@/workflows/__tests__/fixtures/approval-probe";

describe("durable approval hooks", () => {
  it("pauses and resumes a workflow with a deterministic review token", async () => {
    const runKey = crypto.randomUUID();
    const run = await start(approvalProbe, [runKey]);
    const reader = run.getReadable<{ stage: string; runKey: string }>().getReader();

    await waitForHook(run, { token: `workbase-test:${runKey}` });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { stage: "awaiting_review", runKey },
    });

    await resumeHook(`workbase-test:${runKey}`, { reviewed: true });

    await expect(run.returnValue).resolves.toEqual({ runKey, reviewed: true });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { stage: "completed", runKey },
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("cancels a run that is durably awaiting review", async () => {
    const runKey = crypto.randomUUID();
    const run = await start(approvalProbe, [runKey]);

    await waitForHook(run, { token: `workbase-test:${runKey}` });
    await run.cancel();

    await expect(run.status).resolves.toBe("cancelled");
  });
});
