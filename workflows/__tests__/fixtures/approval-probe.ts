import { createHook, getWritable } from "workflow";

async function writeStage(stage: string, runKey: string, close = false) {
  "use step";
  const writable = getWritable<{ stage: string; runKey: string }>();
  const writer = writable.getWriter();
  await writer.write({ stage, runKey });
  writer.releaseLock();
  if (close) await writable.close();
}

export async function approvalProbe(runKey: string) {
  "use workflow";

  await writeStage("awaiting_review", runKey);

  using review = createHook<{ reviewed: boolean }>({
    token: `workbase-test:${runKey}`,
  });
  const result = await review;
  await writeStage("completed", runKey, true);
  return { runKey, reviewed: result.reviewed };
}
