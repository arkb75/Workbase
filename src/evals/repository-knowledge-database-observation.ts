import { prisma } from "@/src/lib/prisma";
import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryKnowledgeEvaluationRun,
  type RepositoryKnowledgeEvidenceReference,
  type RepositoryKnowledgeFixture,
} from "@/src/evals/repository-knowledge-quality";
import {
  collectUnknownModelUsageAttempts,
} from "@/src/services/model-usage-service";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function repositoryFromMetadata(value: unknown) {
  const metadata = record(value);
  return stringValue(record(metadata?.repository)?.fullName) ??
    stringValue(metadata?.repositoryFullName);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + tokenCount(entry), 0);
  }
  const data = record(value);
  if (!data) return 0;
  const direct = numberValue(data.totalTokens) ?? numberValue(data.total_tokens);
  if (direct !== null) return direct;
  const input = numberValue(data.inputTokens) ?? numberValue(data.input_tokens);
  const output = numberValue(data.outputTokens) ?? numberValue(data.output_tokens);
  if (input !== null || output !== null) return (input ?? 0) + (output ?? 0);
  return Object.values(data).reduce<number>(
    (sum, entry) => sum + tokenCount(entry),
    0,
  );
}

function maximumBudgetModelCalls(value: unknown) {
  let maximum = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const data = current as Record<string, unknown>;
    const modelCalls = numberValue(data.modelCalls);
    if (modelCalls !== null) maximum = Math.max(maximum, Math.floor(Math.max(0, modelCalls)));
    Object.values(data).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return maximum;
}

function countedProviderAttempts(value: unknown) {
  let total = 0;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number) => {
    if (!current || typeof current !== "object" || depth > 6 || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const data = current as Record<string, unknown>;
    const explicitAttempts = numberValue(data.providerAttemptCount);
    if (explicitAttempts !== null && explicitAttempts > 0) {
      total += Math.floor(explicitAttempts);
      return;
    }
    const budgetCalls = numberValue(data.modelCalls);
    if (budgetCalls !== null && budgetCalls > 0) {
      // Budget snapshots commonly repeat aggregate input/output token totals.
      // They are not another provider attempt leaf.
      return;
    }
    if ([
      "inputTokens",
      "input_tokens",
      "outputTokens",
      "output_tokens",
      "totalTokens",
      "total_tokens",
    ].some((key) => numberValue(data[key]) !== null)) {
      total += 1;
      return;
    }
    Object.values(data).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return total;
}

/**
 * A GenerationRun is a logical audited operation, not necessarily one paid
 * model dispatch. Prefer its provider-attempt envelope, with legacy budget and
 * unknown-usage counters as floors. Taking the maximum prevents an aggregate
 * wrapper and its nested attempt leaves from counting the same dispatch twice.
 */
export function modelCallsFromGenerationTelemetry(value: unknown) {
  return Math.max(
    countedProviderAttempts(value),
    collectUnknownModelUsageAttempts(value),
    maximumBudgetModelCalls(value),
  );
}

export function repositoryGenerationModelCalls(
  generationRuns: ReadonlyArray<{ tokenUsage: unknown }>,
  refreshBudgetUsage?: unknown,
) {
  const generationAttempts = generationRuns.reduce(
    (total, generation) => total + modelCallsFromGenerationTelemetry(generation.tokenUsage),
    0,
  );
  // Refresh budget telemetry is cumulative and overlaps the per-generation
  // evidence, so it is an aggregate floor rather than an additive source.
  return Math.max(
    generationAttempts,
    modelCallsFromGenerationTelemetry(refreshBudgetUsage),
  );
}

function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function evidenceReference(evidence: {
  title: string;
  content: string;
  metadata: unknown;
}): RepositoryKnowledgeEvidenceReference | null {
  const metadata = record(evidence.metadata);
  const path = stringValue(metadata?.path) ??
    evidence.title.match(/^(.+?):\d+(?:-\d+)?$/u)?.[1] ?? null;
  if (!path) return null;
  return {
    path,
    lineStart: numberValue(metadata?.startLine),
    lineEnd: numberValue(metadata?.endLine),
    quote: evidence.content.slice(0, 2_000) || null,
  };
}

/**
 * Converts the latest completed repository snapshot and its durable knowledge
 * into the neutral observation contract. It does not trigger a refresh; run a
 * normal branch import/refresh first so both implementations are compared at
 * the same product boundary.
 */
export async function repositoryKnowledgeObservationFromDatabase(
  fixture: RepositoryKnowledgeFixture,
  input: { workItemId?: string } = {},
): Promise<RepositoryKnowledgeEvaluationRun> {
  if (!fixture.repository) {
    throw new Error(`Fixture ${fixture.id} is not backed by a real repository.`);
  }
  const sources = await prisma.source.findMany({
    where: {
      type: "github_repo",
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: {
      id: true,
      workItemId: true,
      metadata: true,
    },
  });
  const source = sources.find((candidate) =>
    repositoryFromMetadata(candidate.metadata)?.toLocaleLowerCase() ===
      fixture.repository!.toLocaleLowerCase()
  );
  if (!source) {
    throw new Error(
      input.workItemId
        ? `Work item ${input.workItemId} has no GitHub source matching ${fixture.repository}.`
        : `No imported GitHub source matched ${fixture.repository}; import and refresh it before evaluation.`,
    );
  }
  const snapshot = await prisma.repositorySnapshot.findFirst({
    where: { sourceId: source.id, analysisComplete: true },
    orderBy: { resolvedAt: "desc" },
    select: {
      id: true,
      commitSha: true,
      refreshRunId: true,
      files: {
        select: {
          id: true,
          path: true,
          disposition: true,
          semanticStatus: true,
        },
      },
      capabilityLedger: {
        orderBy: [{ priority: "desc" }, { capabilityKey: "asc" }],
        select: {
          capabilityKey: true,
          label: true,
          status: true,
          representativeFileIds: true,
        },
      },
      refreshRun: {
        select: {
          startedAt: true,
          finishedAt: true,
          budgetUsage: true,
        },
      },
    },
  });
  if (!snapshot) {
    throw new Error(
      `No analyzed repository snapshot exists for ${fixture.repository}; wait for its refresh to finish.`,
    );
  }
  const [highlights, facts, generationRuns] = await Promise.all([
    prisma.highlight.findMany({
      where: {
        workItemId: source.workItemId,
        lifecycleStatus: "active",
        validatedThroughSha: snapshot.commitSha,
        evidence: { some: { evidenceItem: { sourceId: source.id } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        text: true,
        summary: true,
        metadata: true,
        evidence: {
          where: { evidenceItem: { sourceId: source.id } },
          select: {
            evidenceItem: {
              select: { title: true, content: true, metadata: true },
            },
          },
        },
      },
    }),
    prisma.projectFact.findMany({
      where: {
        workItemId: source.workItemId,
        lifecycleStatus: "active",
        validatedThroughSha: snapshot.commitSha,
        evidence: { some: { evidenceItem: { sourceId: source.id } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        statement: true,
        subsystemKey: true,
        evidence: {
          where: { evidenceItem: { sourceId: source.id } },
          select: {
            evidenceItem: {
              select: { title: true, content: true, metadata: true },
            },
          },
        },
      },
    }),
    snapshot.refreshRun?.startedAt
      ? prisma.generationRun.findMany({
          where: {
            workItemId: source.workItemId,
            kind: {
              in: [
                "semantic_extraction",
                "semantic_repair",
                "capability_synthesis",
                "coverage_audit",
              ],
            },
            createdAt: {
              gte: snapshot.refreshRun.startedAt,
              ...(snapshot.refreshRun.finishedAt
                ? { lte: snapshot.refreshRun.finishedAt }
                : {}),
            },
          },
          select: { tokenUsage: true, estimatedCostUsd: true },
        })
      : Promise.resolve([]),
  ]);

  const evidence = (rows: Array<{ evidenceItem: { title: string; content: string; metadata: unknown } }>) =>
    rows.flatMap((row) => {
      const reference = evidenceReference(row.evidenceItem);
      return reference ? [reference] : [];
    });
  const filePathById = new Map(snapshot.files.map((file) => [file.id, file.path]));
  const scannablePaths = snapshot.files
    .filter((file) => file.disposition === "eligible" || file.disposition === "analyzed")
    .map((file) => file.path);
  const analyzedPaths = snapshot.files
    .filter((file) => file.disposition === "analyzed")
    .map((file) => file.path);
  const semanticSelectedPaths = snapshot.files
    .filter((file) => file.semanticStatus !== "not_selected")
    .map((file) => file.path);
  const semanticAnalyzedPaths = snapshot.files
    .filter((file) => file.semanticStatus === "succeeded")
    .map((file) => file.path);
  const applicableCapabilities = snapshot.capabilityLedger.filter((entry) =>
    entry.status !== "not_applicable"
  );
  const verifiedCapabilities = applicableCapabilities.filter((entry) =>
    entry.status === "semantic_verified"
  );
  const startedAt = snapshot.refreshRun?.startedAt;
  const finishedAt = snapshot.refreshRun?.finishedAt;

  return {
    schemaVersion: REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
    fixtureId: fixture.id,
    repository: fixture.repository,
    commitSha: snapshot.commitSha,
    items: [
      ...highlights.map((highlight) => ({
        id: highlight.id,
        kind: "highlight" as const,
        text: highlight.text,
        summary: highlight.summary,
        claimState: "implemented" as const,
        domain: stringValue(record(highlight.metadata)?.subsystemKey),
        evidence: evidence(highlight.evidence),
      })),
      ...facts.map((fact) => ({
        id: fact.id,
        kind: "fact" as const,
        text: fact.statement,
        summary: null,
        claimState: "implemented" as const,
        domain: fact.subsystemKey,
        evidence: evidence(fact.evidence),
      })),
    ],
    domains: applicableCapabilities.map((entry) => ({
      key: entry.capabilityKey,
      label: entry.label,
    })),
    discoveredCapabilities: applicableCapabilities.map((entry) => ({
      key: entry.capabilityKey,
      label: entry.label,
      evidencePaths: jsonStringArray(entry.representativeFileIds).flatMap((id) => {
        const path = filePathById.get(id);
        return path ? [path] : [];
      }),
    })),
    inventory: {
      scannableFiles: scannablePaths.length,
      analyzedFiles: analyzedPaths.length,
      semanticEligibleFiles: semanticSelectedPaths.length,
      semanticAnalyzedFiles: semanticAnalyzedPaths.length,
      analyzedPaths,
      semanticAnalyzedPaths,
    },
    coverage: {
      static: scannablePaths.length
        ? analyzedPaths.length / scannablePaths.length
        : null,
      semantic: semanticSelectedPaths.length
        ? semanticAnalyzedPaths.length / semanticSelectedPaths.length
        : null,
      knowledge: applicableCapabilities.length
        ? verifiedCapabilities.length / applicableCapabilities.length
        : null,
    },
    performance: {
      durationMs: startedAt && finishedAt
        ? Math.max(0, finishedAt.getTime() - startedAt.getTime())
        : null,
      modelCalls: repositoryGenerationModelCalls(
        generationRuns,
        snapshot.refreshRun?.budgetUsage,
      ),
      totalTokens: generationRuns.reduce(
        (sum, generation) => sum + tokenCount(generation.tokenUsage),
        0,
      ),
      estimatedCostUsd: generationRuns.reduce(
        (sum, generation) => sum + (generation.estimatedCostUsd ?? 0),
        0,
      ),
    },
  };
}
