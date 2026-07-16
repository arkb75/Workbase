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
  isKnowledgeRefreshPartial,
  knowledgeRefreshService,
  startKnowledgeRefresh,
} from "../src/services/knowledge-refresh-service";
import { knowledgeReconciliationService } from "../src/services/knowledge-reconciliation-service";
import { knowledgeStalenessService } from "../src/services/knowledge-staleness-service";
import {
  evaluateAccomplishmentAnswerStructure,
  evaluateRuntimeRequirementCoverage,
  isEntityValidationCurrent,
  parseRuntimeAccomplishmentAudit,
} from "../src/services/project-answer-evaluation-service";
import { findUnsupportedOwnershipClaims } from "../src/services/project-answer-grounding-service";
import { explicitSelfReportedOwnershipAuthority } from "../src/services/evidence-ownership-authority";
import { persistResearchAgentEvent } from "../src/services/research-event-persistence-service";
import {
  collectModelTokenUsage,
  collectUnknownModelUsageAttempts,
  estimateBedrockCostUsd,
} from "../src/services/model-usage-service";

const prompt = process.argv.slice(2).join(" ").trim() || "Summarize my strongest accomplishments and make sure your information is up to date";

function records(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function currentRefresh(input: { userId: string; workItemId: string; runId: string }) {
  const refresh = await startKnowledgeRefresh({
    userId: input.userId,
    workItemId: input.workItemId,
    trigger: "chat_freshness",
    idempotencyKey: `evaluation:${input.runId}`,
  });
  try {
    if (refresh.status !== "completed") {
      await knowledgeRefreshService.inventory(refresh.runId);
      let remaining = 1;
      while (remaining > 0) {
        const chunk = await knowledgeRefreshService.analyzeChunk({ runId: refresh.runId, batchSize: 8, maxBatches: 8 });
        remaining = chunk.remaining;
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
  } catch (error) {
    await knowledgeRefreshService.fail(refresh.runId, error).catch(() => null);
    throw error;
  }
  const completed = await prisma.knowledgeRefreshRun.findUniqueOrThrow({ where: { id: refresh.runId } });
  const partial = isKnowledgeRefreshPartial(completed);
  await prisma.agentRun.update({
    where: { id: input.runId },
    data: {
      researchState: {
        kind: "repository_knowledge_refresh",
        refreshRunId: completed.id,
        status: completed.status,
        targetHeads: completed.targetHeads,
        coverage: completed.coverage,
        partial,
        completedAt: completed.finishedAt?.toISOString() ?? completed.updatedAt.toISOString(),
      },
    },
  });
  return completed;
}

async function main() {
  const evaluationStartedAt = new Date();
  const evaluationStartedMs = Date.now();
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
    onAgentEvent: (event) => persistResearchAgentEvent(run.id, event),
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
  const validationTargets = targets.flatMap((target) =>
    typeof target.sourceId === "string" && typeof target.commitSha === "string"
      ? [{ sourceId: target.sourceId, commitSha: target.commitSha }]
      : [],
  );
  const refreshPartial = isKnowledgeRefreshPartial(refresh);
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
  const requiredCapabilityCoverage = {
    product: /career content|resume bullets|linkedin|project summar/i.test(message.content),
    repositoryLifecycle: /knowledge refresh|repository refresh|snapshot|staleness|reconcil/i.test(message.content),
    aiRuntime: /bedrock|structured llm|agent runtime|tool use/i.test(message.content),
    workflows: /durable workflow|workflow orchestrat|approval gate/i.test(message.content),
    retrieval: /retriev|rag|citation|provenance|ground/i.test(message.content),
    github: /github|oauth|repository ingest/i.test(message.content),
    reviewArtifacts: /highlight|artifact|human-in-the-loop|review/i.test(message.content),
    dataModel: /prisma|data model|postgres|schema/i.test(message.content),
    tests: /automated test|test coverage|vitest|workflow test/i.test(message.content),
    ui: /user interface|workspace ui|review ui|chat workspace/i.test(message.content),
  };
  const usedOrdinals = new Set(canonicalOrdinals);
  const citedProjectFactIds = message.citations.flatMap((citation) => citation.projectFactId ? [citation.projectFactId] : []);
  const citedHighlightIds = message.citations.flatMap((citation) => citation.highlightId ? [citation.highlightId] : []);
  const citedEvidenceItemIds = message.citations.flatMap((citation) => citation.evidenceItemId ? [citation.evidenceItemId] : []);
  const [highPriorityLedger, citedProjectFacts, citedHighlights, citedEvidenceItems, completenessEvent, candidateGenerationRuns, runEvents] = await Promise.all([
    prisma.repositoryCapabilityLedger.findMany({
      where: { refreshRunId: refresh.id, priority: { gte: 5 }, status: "semantic_verified" },
      orderBy: [{ priority: "desc" }, { capabilityKey: "asc" }],
    }),
    prisma.projectFact.findMany({
      where: { id: { in: citedProjectFactIds.length ? citedProjectFactIds : [""] } },
      include: { evidence: { include: { evidenceItem: true } } },
    }),
    prisma.highlight.findMany({
      where: { id: { in: citedHighlightIds.length ? citedHighlightIds : [""] } },
      include: { evidence: { include: { evidenceItem: true } } },
    }),
    prisma.evidenceItem.findMany({
      where: { id: { in: citedEvidenceItemIds.length ? citedEvidenceItemIds : [""] } },
      include: { source: true },
    }),
    prisma.agentRunEvent.findFirst({
      where: { agentRunId: run.id, toolName: "audit_answer_completeness" },
      orderBy: { sequence: "desc" },
    }),
    prisma.generationRun.findMany({
      where: {
        workItemId: workItem.id,
        updatedAt: { gte: evaluationStartedAt },
      },
      select: {
        id: true,
        kind: true,
        status: true,
        provider: true,
        modelId: true,
        idempotencyKey: true,
        tokenUsage: true,
        estimatedCostUsd: true,
        resultRefs: true,
      },
    }),
    prisma.agentRunEvent.findMany({
      where: { agentRunId: run.id },
      select: { type: true, toolName: true, message: true, payload: true },
      orderBy: { sequence: "asc" },
    }),
  ]);
  // Attribute provider work to this evaluation's immutable refresh or chat
  // run, rather than every generation that happened to touch the same project
  // during the wall-clock window (for example, a cron refresh).
  const generationRuns = candidateGenerationRuns.filter((entry) =>
    entry.idempotencyKey?.includes(refresh.id) || entry.idempotencyKey?.includes(run.id)
  );
  const generationUsage = collectModelTokenUsage(generationRuns.map((entry) => entry.tokenUsage));
  const conversationUsageValues = runEvents.flatMap((event) => {
    const usage = record(event.payload).usage;
    return usage ? [usage] : [];
  });
  const conversationUsage = collectModelTokenUsage(conversationUsageValues);
  const generationUnknownUsageAttempts = generationRuns.reduce((total, entry) => {
    const refs = record(entry.resultRefs);
    const recorded = refs.unknownUsageAttempts;
    return total + (
      typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0
        ? Math.floor(recorded)
        : entry.tokenUsage == null && entry.provider === "bedrock"
          ? 1
          : collectUnknownModelUsageAttempts(entry.tokenUsage)
    );
  }, 0);
  const usageComplete = generationUnknownUsageAttempts + collectUnknownModelUsageAttempts(conversationUsageValues) === 0;
  const modelId = process.env.WORKBASE_BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";
  const measuredCostUsd = generationRuns.reduce((total, entry) => total + (
    entry.estimatedCostUsd ?? estimateBedrockCostUsd(entry.modelId, collectModelTokenUsage(entry.tokenUsage)) ?? 0
  ), 0) + (estimateBedrockCostUsd(modelId, conversationUsage) ?? 0);
  const elapsedMs = Date.now() - evaluationStartedMs;
  const completenessPayload = record(completenessEvent?.payload);
  const runtimeCompletenessAudit = parseRuntimeAccomplishmentAudit(completenessPayload);
  const countRange = runtimeCompletenessAudit
    ? { minimum: runtimeCompletenessAudit.minimumBlocks, maximum: runtimeCompletenessAudit.maximumBlocks }
    : { minimum: 1, maximum: 10 };
  const structure = evaluateAccomplishmentAnswerStructure({
    content: message.content,
    citations: message.citations.map((citation) => ({ ordinal: citation.ordinal, kind: citation.kind })),
    countRange,
  });
  const citationByProjectFactId = new Map(message.citations.flatMap((citation) =>
    citation.projectFactId ? [[citation.projectFactId, citation] as const] : [],
  ));
  const citationByHighlightId = new Map(message.citations.flatMap((citation) =>
    citation.highlightId ? [[citation.highlightId, citation] as const] : [],
  ));
  const citationByEvidenceItemId = new Map(message.citations.flatMap((citation) =>
    citation.evidenceItemId ? [[citation.evidenceItemId, citation] as const] : [],
  ));
  const citedRuntimeSources = message.citations.flatMap((citation) => {
    const sourceId = citation.projectFactId ?? citation.highlightId ?? citation.evidenceItemId ?? citation.artifactId ?? citation.sourceId;
    return sourceId ? [{ kind: citation.kind, sourceId }] : [];
  });
  const runtimeRequirementCoverage = runtimeCompletenessAudit
    ? evaluateRuntimeRequirementCoverage({ requirements: runtimeCompletenessAudit.requirements, citedSources: citedRuntimeSources })
    : null;
  const ledgerCoverage = highPriorityLedger.map((entry) => {
    const refs = record(entry.producedEntityRefs);
    const projectFactIds = stringArray(refs.projectFactIds);
    const highlightIds = stringArray(refs.highlightIds);
    const cited = projectFactIds.some((id) => {
      const citation = citationByProjectFactId.get(id);
      return Boolean(citation && usedOrdinals.has(citation.ordinal));
    }) || highlightIds.some((id) => {
      const citation = citationByHighlightId.get(id);
      return Boolean(citation && usedOrdinals.has(citation.ordinal));
    });
    return {
      capabilityKey: entry.capabilityKey,
      priority: entry.priority,
      producedProjectFactIds: projectFactIds,
      producedHighlightIds: highlightIds,
      representedByUsedCitation: cited,
    };
  });
  const repositoryDerivedEntities = [...citedProjectFacts, ...citedHighlights].filter((entity) =>
    entity.evidence.some((edge) => edge.evidenceItem.type.startsWith("github_")),
  );
  const latestProvenance = repositoryDerivedEntities.map((entity) => {
    const validationHeads = record(entity.validationHeads);
    const current = isEntityValidationCurrent({
      validationHeads,
      validatedThroughSha: entity.validatedThroughSha,
      targetHeads: validationTargets,
    });
    return { id: entity.id, validatedThroughSha: entity.validatedThroughSha, validationHeads, current };
  });
  const unsupportedOwnershipClaims = findUnsupportedOwnershipClaims({
    answer: message.content,
    entries: [
      ...citedHighlights.flatMap((highlight) => {
        const citation = citationByHighlightId.get(highlight.id);
        if (!citation) return [];
        return [{
          kind: "highlight",
          authority: highlight.verificationStatus === "approved" ? "verified_highlight" : "candidate_highlight",
          title: highlight.text,
          content: highlight.summary,
          currentRun: false,
          citationIndexes: [citation.ordinal],
          ownershipAuthority: highlight.ownershipClarity === "clear" ? 5 : highlight.ownershipClarity === "partial" ? 3 : 1,
          supportingSources: [],
        }];
      }),
      ...citedEvidenceItems.flatMap((evidence) => {
        const citation = citationByEvidenceItemId.get(evidence.id);
        if (!citation) return [];
        const eligible = evidence.included && evidence.lifecycleStatus === "active";
        return [{
          kind: "evidence",
          authority: eligible ? "included_evidence" : "excluded_evidence",
          title: evidence.title,
          content: evidence.content,
          currentRun: false,
          citationIndexes: [citation.ordinal],
          ownershipAuthority: eligible ? explicitSelfReportedOwnershipAuthority(evidence) : 0,
          supportingSources: [],
        }];
      }),
    ],
  });
  const checks = {
    latestCommitPinned: targets.length > 0 && targets.every((target) => typeof target.commitSha === "string" && target.commitSha.length === 40),
    allEligibleFilesMapped: coverage.length > 0 && coverage.every((entry) => Number(entry.analyzedPaths) + Number(entry.excludedPaths) === Number(entry.totalPaths)),
    noDeclaredCoverageGap: !refreshPartial,
    verifiedRefreshQuality: refresh.qualityStatus === "verified",
    semanticCoverageComplete: coverage.every((entry) =>
      entry.semanticCoverageStatus === "complete" || entry.semanticCoverageStatus === "not_required",
    ),
    citationsPersisted: message.citations.length > 0,
    citationRowsMatchMarkers: canonicalOrdinals.length > 0 && canonicalOrdinals.every((ordinal) => message.citations.some((citation) => citation.ordinal === ordinal)) && message.citations.every((citation) => canonicalOrdinals.includes(citation.ordinal)),
    noPlainPseudoCitations: plainPseudoCitations.length === 0,
    runtimeCompletenessManifestAvailable: runtimeCompletenessAudit !== null,
    runtimeRequirementsRepresented: runtimeRequirementCoverage?.complete === true,
    accomplishmentCountInRange: structure.countInRange,
    everyAccomplishmentCited: structure.allBlocksCited,
    noArtifactOnlyAccomplishments: structure.noArtifactOnlyBlocks,
    citedRepositoryKnowledgeAtLatestCommit: latestProvenance.length > 0 && latestProvenance.every((entry) => entry.current),
    ownershipClaimsSupported: unsupportedOwnershipClaims.length === 0,
    durableSourcesOnly: message.citations.every((citation) => citation.kind !== "github_file"),
    usageTelemetryComplete: usageComplete,
  };
  const diagnostics = {
    markdownStructured: headings >= Math.min(4, countRange.minimum),
    broadArchitectureCoverage: coverageAreas >= 6,
    mandatoryKeywordCoverage: Object.values(requiredCapabilityCoverage).every(Boolean),
    accomplishmentsLexicallyNonredundant: structure.nonredundant,
    highPriorityLedgerRepresented: ledgerCoverage.length > 0 && ledgerCoverage.every((entry) => entry.representedByUsedCitation),
  };
  process.stdout.write(`${JSON.stringify({
    workItem: { id: workItem.id, title: workItem.title },
    runId: run.id,
    threadId: thread.id,
    refreshRunId: refresh.id,
    qualityStatus: refresh.qualityStatus,
    partial: refreshPartial,
    targets,
    coverage: coverage.map((entry) => ({
      repository: entry.repository,
      commitSha: entry.commitSha,
      totalPaths: entry.totalPaths,
      analyzedPaths: entry.analyzedPaths,
      excludedPaths: entry.excludedPaths,
      semanticPaths: entry.semanticPaths,
      coverageStatus: entry.coverageStatus,
      semanticCoverageStatus: entry.semanticCoverageStatus,
      capabilityCoverageStatus: entry.capabilityCoverageStatus,
      coverageGaps: entry.coverageGaps,
    })),
    checks,
    diagnostics,
    requiredCapabilityCoverage,
    runtimeCompleteness: runtimeCompletenessAudit ? {
      minimumBlocks: runtimeCompletenessAudit.minimumBlocks,
      maximumBlocks: runtimeCompletenessAudit.maximumBlocks,
      requirements: runtimeCompletenessAudit.requirements,
      missingRequirements: runtimeRequirementCoverage?.missing ?? [],
      missingRequirementMembers: runtimeRequirementCoverage?.missingMembers ?? [],
    } : null,
    structure: {
      accomplishmentCount: structure.accomplishmentCount,
      redundantPairs: structure.redundantPairs,
      uncitedBlocks: structure.uncitedBlocks,
      artifactOnlyBlocks: structure.artifactOnlyBlocks,
    },
    ledgerCoverage,
    latestProvenance,
    unsupportedOwnershipClaims,
    performance: {
      elapsedMs,
      generationRunCount: generationRuns.length,
      generationModelCallCount: generationRuns.reduce((total, entry) => {
        const count = record(entry.resultRefs).auditAttemptCount;
        return total + (typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0);
      }, 0),
      converseModelCallCount: runEvents.filter((event) => record(event.payload).usage != null).length,
      usageComplete,
      generationUsage,
      conversationUsage,
      estimatedCostUsd: Number(measuredCostUsd.toFixed(6)),
      generationRuns: generationRuns.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        modelId: entry.modelId,
        tokenUsage: collectModelTokenUsage(entry.tokenUsage),
        estimatedCostUsd: entry.estimatedCostUsd,
        durationMs: typeof record(entry.resultRefs).durationMs === "number" ? record(entry.resultRefs).durationMs : null,
      })),
    },
    answer: message.content,
    sources: message.citations.map((citation) => ({ ordinal: citation.ordinal, kind: citation.kind, title: citation.label })),
  }, null, 2)}\n`);
  if (
    Object.values(checks).some((passed) => !passed) ||
    Object.values(diagnostics).some((passed) => !passed)
  ) process.exitCode = 2;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
