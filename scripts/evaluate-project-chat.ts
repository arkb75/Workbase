import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { ensureDemoUser } from "../src/lib/demo-user";
import {
  completeAgentRun,
  createProjectChatRun,
  createProjectChatThread,
  markAgentRunRunning,
} from "../src/services/project-chat-store";
import { runProjectChatAgent } from "../src/services/project-chat-agent-service";
import {
  knowledgeRefreshService,
  startKnowledgeRefresh,
} from "../src/services/knowledge-refresh-service";
import { knowledgeReconciliationService } from "../src/services/knowledge-reconciliation-service";
import { knowledgeStalenessService } from "../src/services/knowledge-staleness-service";

const prompt = process.argv.slice(2).join(" ").trim() || "Summarize my strongest accomplishments and make sure your information is up to date";

function records(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
}

async function currentRefresh(input: { userId: string; workItemId: string; runId: string }) {
  const refresh = await startKnowledgeRefresh({
    userId: input.userId,
    workItemId: input.workItemId,
    trigger: "chat_freshness",
    idempotencyKey: `evaluation:${input.runId}`,
  });
  if (refresh.status !== "completed") {
    await knowledgeRefreshService.inventory(refresh.runId);
    let remaining = 1;
    while (remaining > 0) {
      const batch = await knowledgeRefreshService.analyzeBatch({ runId: refresh.runId, batchSize: 4 });
      remaining = batch.remaining;
    }
    await knowledgeRefreshService.repairCoverage(refresh.runId);
    await knowledgeRefreshService.finalizeCoverage(refresh.runId);
    const reconciled = await knowledgeReconciliationService.reconcile(refresh.runId);
    await knowledgeStalenessService.reconcile({
      runId: refresh.runId,
      appliedFactIds: reconciled.appliedFactIds,
      appliedHighlightIds: reconciled.appliedHighlightIds,
    });
    await knowledgeRefreshService.complete(refresh.runId);
  }
  const completed = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: refresh.runId } });
  await prisma.agentRun.update({
    where: { id: input.runId },
    data: {
      researchState: {
        kind: "repository_knowledge_refresh",
        refreshRunId: completed.id,
        status: completed.status,
        targetHeads: completed.targetHeads,
        coverage: completed.coverage,
        partial: records(completed.coverage).some((entry) => entry.coverageStatus === "partial"),
        completedAt: completed.finishedAt?.toISOString() ?? completed.updatedAt.toISOString(),
      },
    },
  });
  return completed;
}

async function main() {
  const user = await ensureDemoUser();
  const workItem = await prisma.workItem.findFirst({
    where: { userId: user.id, title: { equals: process.env.EVAL_WORK_ITEM_TITLE ?? "Workbase", mode: "insensitive" }, sources: { some: { type: "github_repo" } } },
    orderBy: { updatedAt: "desc" },
  }) ?? await prisma.workItem.findFirstOrThrow({
    where: { userId: user.id, sources: { some: { type: "github_repo" } } },
    orderBy: { updatedAt: "desc" },
  });
  const thread = await createProjectChatThread({ userId: user.id, workItemId: workItem.id, title: "Citation and coverage evaluation" });
  const run = await createProjectChatRun({
    userId: user.id,
    workItemId: workItem.id,
    threadId: thread.id,
    message: prompt,
    kind: "chat_turn",
    idempotencyKey: `evaluation:${randomUUID()}`,
  });
  await markAgentRunRunning(run.id);
  const refresh = await currentRefresh({ userId: user.id, workItemId: workItem.id, runId: run.id });
  const userMessage = await prisma.chatMessage.findFirstOrThrow({ where: { agentRunId: run.id, role: "user" } });
  const result = await runProjectChatAgent({
    runId: run.id,
    userId: user.id,
    workItemId: workItem.id,
    threadId: thread.id,
    messageId: userMessage.id,
    question: prompt,
    history: [],
    rollingSummary: null,
    allowResearch: false,
  });
  if (result.status !== "answered") throw new Error(`Evaluation did not produce a final answer: ${result.status}`);
  await completeAgentRun({
    runId: run.id,
    content: result.answer,
    citations: result.citations,
    citationPolicy: result.citationPolicy,
    groundedClaims: result.groundedClaims,
    freshness: result.freshness,
    result: {
      status: result.research.status,
      findings: result.research.findings,
      coverageGaps: result.research.coverageGaps,
      warnings: result.research.warnings,
      citationCount: result.citations.length,
      groundedClaims: result.groundedClaims,
      evaluation: true,
    },
  });
  const message = await prisma.chatMessage.findFirstOrThrow({
    where: { agentRunId: run.id, role: "assistant" },
    include: { citations: { orderBy: { ordinal: "asc" } } },
  });
  const targets = records(refresh.targetHeads);
  const coverage = records(refresh.coverage);
  const canonicalOrdinals = Array.from(message.content.matchAll(/\[citation:(\d+)\]/g)).map((match) => Number(match[1]));
  const plainPseudoCitations = Array.from(message.content.matchAll(/\[(\d+)\](?:\s*\[(\d+)\])*/g));
  const headings = Array.from(message.content.matchAll(/^#{2,4}\s+.+$/gm)).length;
  const coverageAreas = [
    /knowledge|refresh|repository/i,
    /agent|bedrock|ai|llm/i,
    /workflow|durable/i,
    /retriev|citation|provenance|ground/i,
    /github|oauth|ingest/i,
    /highlight|artifact|review|verification/i,
    /data model|prisma|postgres/i,
    /test|ui|workspace/i,
  ].filter((pattern) => pattern.test(message.content)).length;
  const checks = {
    latestCommitPinned: targets.length > 0 && targets.every((target) => typeof target.commitSha === "string" && target.commitSha.length === 40),
    allEligibleFilesMapped: coverage.length > 0 && coverage.every((entry) => Number(entry.analyzedPaths) + Number(entry.excludedPaths) === Number(entry.totalPaths)),
    noDeclaredCoverageGap: coverage.every((entry) => entry.coverageStatus === "complete"),
    citationsPersisted: message.citations.length > 0,
    citationRowsMatchMarkers: canonicalOrdinals.length > 0 && canonicalOrdinals.every((ordinal) => message.citations.some((citation) => citation.ordinal === ordinal)) && message.citations.every((citation) => canonicalOrdinals.includes(citation.ordinal)),
    noPlainPseudoCitations: plainPseudoCitations.length === 0,
    markdownStructured: headings >= 4,
    broadArchitectureCoverage: coverageAreas >= 6,
    durableSourcesOnly: message.citations.every((citation) => citation.kind !== "github_file"),
  };
  process.stdout.write(`${JSON.stringify({
    workItem: { id: workItem.id, title: workItem.title },
    runId: run.id,
    threadId: thread.id,
    refreshRunId: refresh.id,
    targets,
    coverage: coverage.map((entry) => ({
      repository: entry.repository,
      commitSha: entry.commitSha,
      totalPaths: entry.totalPaths,
      analyzedPaths: entry.analyzedPaths,
      excludedPaths: entry.excludedPaths,
      semanticPaths: entry.semanticPaths,
      coverageStatus: entry.coverageStatus,
      coverageGaps: entry.coverageGaps,
    })),
    checks,
    answer: message.content,
    sources: message.citations.map((citation) => ({ ordinal: citation.ordinal, kind: citation.kind, title: citation.label })),
  }, null, 2)}\n`);
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 2;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
