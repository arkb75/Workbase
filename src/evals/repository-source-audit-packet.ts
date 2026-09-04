import { createHash } from "node:crypto";
import { z } from "zod";
import {
  repositorySourceAuditManifestDigest,
  repositorySourceAuditRepositoryDigest,
  type RepositorySourceAuditManifest,
  type RepositorySourceAuditRepository,
} from "@/src/evals/repository-source-audit";
import type {
  RepositoryKnowledgeEvaluationRun,
  RepositoryKnowledgeEvidenceReference,
} from "@/src/evals/repository-knowledge-quality";

export const REPOSITORY_SOURCE_AUDIT_PACKET_SCHEMA_VERSION =
  "repository-source-audit-adjudication-packet-v1" as const;
export const REPOSITORY_SOURCE_AUDIT_LIVE_RUN_BINDING_SCHEMA_VERSION =
  "repository-source-audit-live-run-binding-v1" as const;

const liveRunCommitSha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu);
const liveRunFixtureSchema = z.object({
  id: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  snapshotCommit: liveRunCommitSha,
}).strict();
const liveRunImplementationSchema = z.object({
  repositoryRoot: z.string().trim().min(1),
  commitSha: liveRunCommitSha,
  branch: z.string().trim().min(1).nullable(),
  trackedWorkingTreeClean: z.literal(true),
  untrackedPolicy: z.literal("allowlisted_inert_only"),
  allowedInertUntrackedPaths: z.array(z.string().trim().min(1)),
}).strict();
const liveRunSchema = z.object({
  schemaVersion: z.literal("repository-knowledge-live-run-v3"),
  variant: z.string().trim().min(1),
  runStartedAt: z.string().datetime({ offset: true }),
  runFinishedAt: z.string().datetime({ offset: true }),
  implementation: liveRunImplementationSchema,
  fixtures: z.array(liveRunFixtureSchema).min(1),
  results: z.array(z.record(z.string(), z.unknown())).min(1),
}).strict();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) =>
      `${JSON.stringify(key)}:${canonicalJson(child)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function repositoryKnowledgeLiveRunArtifactDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function isAllowedInertLiveRunUntrackedPath(path: string) {
  return path === "skills-lock.json" ||
    [".agents/", ".claude/", ".windsurf/"].some((prefix) =>
      path.startsWith(prefix)
    );
}

function exactDistinctStrings(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`Live-run artifact has duplicate ${label}.`);
  }
}

export function repositorySourceAuditLiveRunBinding(input: {
  liveRun: unknown;
  repository: RepositorySourceAuditRepository;
  workItemId: string;
  refreshRunId: string;
}) {
  const liveRun = liveRunSchema.parse(input.liveRun);
  if (Date.parse(liveRun.runFinishedAt) < Date.parse(liveRun.runStartedAt)) {
    throw new Error("Live-run artifact finishes before it starts.");
  }
  exactDistinctStrings(
    liveRun.fixtures.map((fixture) => fixture.id),
    "fixture ids",
  );
  const resultFixtureIds = liveRun.results.map((result) => {
    const fixtureId = result.fixtureId;
    if (typeof fixtureId !== "string" || !fixtureId.trim()) {
      throw new Error("Live-run artifact has a result without a fixture id.");
    }
    return fixtureId;
  });
  exactDistinctStrings(resultFixtureIds, "result fixture ids");
  const inertPaths = liveRun.implementation.allowedInertUntrackedPaths;
  exactDistinctStrings(inertPaths, "allowed inert untracked paths");
  if (
    inertPaths.some((path) => !isAllowedInertLiveRunUntrackedPath(path)) ||
    JSON.stringify(inertPaths) !== JSON.stringify([...inertPaths].sort())
  ) {
    throw new Error(
      "Live-run artifact contains a non-allowlisted or unsorted untracked path.",
    );
  }
  const fixtures = liveRun.fixtures.filter((fixture) =>
    fixture.id === input.repository.fixtureId
  );
  if (
    fixtures.length !== 1 ||
    repositoryIdentity(fixtures[0]!.repository) !==
      repositoryIdentity(input.repository.repository) ||
    fixtures[0]!.snapshotCommit.toLocaleLowerCase() !==
      input.repository.commitSha.toLocaleLowerCase()
  ) {
    throw new Error(
      `Live-run artifact does not contain the exact audited fixture ${input.repository.fixtureId}.`,
    );
  }
  const results = liveRun.results.filter((result) =>
    result.fixtureId === input.repository.fixtureId
  );
  const result = results[0];
  const mainPathIntegrity = result && typeof result.mainPathIntegrity === "object" &&
      result.mainPathIntegrity !== null && !Array.isArray(result.mainPathIntegrity)
    ? result.mainPathIntegrity as Record<string, unknown>
    : null;
  if (
    results.length !== 1 ||
    !result ||
    result.status !== "completed" ||
    repositoryIdentity(String(result.repository ?? "")) !==
      repositoryIdentity(input.repository.repository) ||
    result.workItemId !== input.workItemId ||
    result.refreshRunId !== input.refreshRunId ||
    mainPathIntegrity?.passed !== true ||
    !Array.isArray(mainPathIntegrity.issues) ||
    mainPathIntegrity.issues.length !== 0 ||
    "error" in result
  ) {
    throw new Error(
      `Live-run result for ${input.repository.fixtureId} does not exactly match the completed, integrity-passing database observation.`,
    );
  }
  return {
    schemaVersion: REPOSITORY_SOURCE_AUDIT_LIVE_RUN_BINDING_SCHEMA_VERSION,
    artifactSchemaVersion: liveRun.schemaVersion,
    artifactDigest: repositoryKnowledgeLiveRunArtifactDigest(liveRun),
    variant: liveRun.variant,
    runStartedAt: liveRun.runStartedAt,
    runFinishedAt: liveRun.runFinishedAt,
    implementation: {
      commitSha: liveRun.implementation.commitSha,
      branch: liveRun.implementation.branch,
      trackedWorkingTreeClean: true as const,
      untrackedPolicy: liveRun.implementation.untrackedPolicy,
      allowedInertUntrackedPaths: [...inertPaths],
    },
    fixture: {
      fixtureId: input.repository.fixtureId,
      repository: input.repository.repository,
      snapshotCommit: input.repository.commitSha,
      workItemId: input.workItemId,
      refreshRunId: input.refreshRunId,
    },
  } as const;
}

export const repositorySourceAuditLiveRunBindingSchema = z.object({
  schemaVersion: z.literal(REPOSITORY_SOURCE_AUDIT_LIVE_RUN_BINDING_SCHEMA_VERSION),
  artifactSchemaVersion: z.literal("repository-knowledge-live-run-v3"),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
  variant: z.string().trim().min(1),
  runStartedAt: z.string().datetime({ offset: true }),
  runFinishedAt: z.string().datetime({ offset: true }),
  implementation: liveRunImplementationSchema.omit({ repositoryRoot: true }),
  fixture: z.object({
    fixtureId: z.string().trim().min(1),
    repository: z.string().trim().min(1),
    snapshotCommit: liveRunCommitSha,
    workItemId: z.string().trim().min(1),
    refreshRunId: z.string().trim().min(1),
  }).strict(),
}).strict();

function repositoryIdentity(value: string) {
  return value.trim().toLocaleLowerCase();
}

function exactRange(reference: RepositoryKnowledgeEvidenceReference) {
  return Number.isInteger(reference.lineStart) &&
    reference.lineStart! > 0 &&
    Number.isInteger(reference.lineEnd) &&
    reference.lineEnd! >= reference.lineStart! &&
    Boolean(reference.quote?.trim());
}

function assertDistinct(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`Repository source-audit packet has duplicate ${label}.`);
  }
}

export function sourceAuditRepository(
  manifest: RepositorySourceAuditManifest,
  fixtureId: string,
) {
  const matches = manifest.repositories.filter((repository) =>
    repository.fixtureId === fixtureId
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `Repository source-audit fixture ${fixtureId} is ambiguous.`
        : `Unknown repository source-audit fixture: ${fixtureId}.`,
    );
  }
  return matches[0]!;
}

/**
 * Produces the complete, deterministic input for human semantic adjudication.
 * It deliberately performs no repository-specific matching or quality scoring.
 */
export function buildRepositorySourceAuditAdjudicationPacket(input: {
  manifest: RepositorySourceAuditManifest;
  repository: RepositorySourceAuditRepository;
  observation: RepositoryKnowledgeEvaluationRun;
  workItemId: string;
  liveRun?: unknown;
}) {
  const frozenRepository = sourceAuditRepository(
    input.manifest,
    input.repository.fixtureId,
  );
  if (
    repositorySourceAuditRepositoryDigest(frozenRepository) !==
      repositorySourceAuditRepositoryDigest(input.repository)
  ) {
    throw new Error(
      `Source-audit repository ${input.repository.fixtureId} does not match the supplied frozen manifest.`,
    );
  }
  const observationRepository = input.observation.repository;
  if (
    !observationRepository ||
    repositoryIdentity(observationRepository) !==
      repositoryIdentity(input.repository.repository)
  ) {
    throw new Error(
      `Observation repository ${observationRepository ?? "missing"} does not match audited repository ${input.repository.repository}.`,
    );
  }
  if (
    input.observation.fixtureId !== input.repository.fixtureId ||
    input.observation.commitSha?.toLocaleLowerCase() !==
      input.repository.commitSha.toLocaleLowerCase()
  ) {
    throw new Error(
      `Observation identity does not match audited fixture ${input.repository.fixtureId}@${input.repository.commitSha}.`,
    );
  }
  assertDistinct(
    input.observation.items.map((item) => item.id),
    "saved output ids",
  );
  assertDistinct(
    input.repository.knowledgeUnits.map((unit) => unit.id),
    "source-audit unit ids",
  );
  assertDistinct(input.repository.userQuestions, "source-audit questions");

  const savedOutputs = [...input.observation.items]
    .sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
    )
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      summary: item.summary ?? null,
      claimState: item.claimState ?? null,
      domain: item.domain ?? null,
      evidence: [...item.evidence]
        .sort((left, right) =>
          left.path.localeCompare(right.path) ||
          (left.lineStart ?? 0) - (right.lineStart ?? 0) ||
          (left.lineEnd ?? 0) - (right.lineEnd ?? 0)
        )
        .map((reference) => ({
          path: reference.path,
          lineStart: reference.lineStart ?? null,
          lineEnd: reference.lineEnd ?? null,
          quote: reference.quote ?? null,
          hasExactRangeAndQuote: exactRange(reference),
        })),
    }));
  const evidenceReferences = savedOutputs.flatMap((item) => item.evidence);
  const highlights = savedOutputs.filter((item) => item.kind === "highlight");
  const executionIntegrity = input.observation.executionIntegrity ?? {
    passed: false,
    issues: ["Database observation did not report execution integrity."],
    modelIdentities: [],
    policyVersions: [],
  };
  let liveRunProvenance;
  if (executionIntegrity.passed) {
    if (!input.liveRun || !input.observation.refreshRunId) {
      throw new Error(
        "Current source-audit packets require a saved live-run artifact and exact refresh-run identity.",
      );
    }
    liveRunProvenance = repositorySourceAuditLiveRunBinding({
      liveRun: input.liveRun,
      repository: input.repository,
      workItemId: input.workItemId,
      refreshRunId: input.observation.refreshRunId,
    });
  }

  return {
    schemaVersion: REPOSITORY_SOURCE_AUDIT_PACKET_SCHEMA_VERSION,
    manifestDigest: repositorySourceAuditManifestDigest(input.manifest),
    auditDate: input.manifest.auditDate,
    method: input.manifest.method,
    workItemId: input.workItemId,
    ...(liveRunProvenance ? { liveRunProvenance } : {}),
    sourceAudit: {
      fixtureId: input.repository.fixtureId,
      repository: input.repository.repository,
      commitSha: input.repository.commitSha,
      sourceScope: input.repository.sourceScope,
      sourceDigest: input.repository.sourceDigest,
      knowledgeUnits: input.repository.knowledgeUnits,
      userQuestions: input.repository.userQuestions,
    },
    observation: {
      fixtureId: input.observation.fixtureId,
      repository: input.observation.repository,
      commitSha: input.observation.commitSha ?? null,
      ...(liveRunProvenance
        ? { refreshRunId: liveRunProvenance.fixture.refreshRunId }
        : {}),
      executionIntegrity,
      adjudicationEligible: executionIntegrity.passed,
      inventory: input.observation.inventory,
      coverage: input.observation.coverage,
      performance: input.observation.performance,
      savedOutputCounts: {
        highlights: highlights.length,
        facts: savedOutputs.length - highlights.length,
        total: savedOutputs.length,
        evidenceReferences: evidenceReferences.length,
        exactRangeAndQuoteReferences: evidenceReferences.filter((reference) =>
          reference.hasExactRangeAndQuote
        ).length,
        outputsWithoutEvidence: savedOutputs.filter((item) =>
          item.evidence.length === 0
        ).length,
      },
      savedOutputs,
    },
    adjudicationTemplate: {
      unitAdjudications: input.repository.knowledgeUnits.map((unit) => ({
        unitId: unit.id,
        knowledgeCoverage: null,
        highlightCoverage: null,
        evidenceSupported: null,
        stateCorrect: null,
        qualifierCoverage: null,
        contradictsAudit: null,
      })),
      highlightAdjudications: highlights.map((highlight) => ({
        highlightId: highlight.id,
        matchedUnitIds: [],
        salience: null,
        semanticDuplicateOf: null,
      })),
      questionAdjudications: input.repository.userQuestions.map((question) => ({
        question,
        answerability: null,
        supportingUnitIds: [],
        evidenceSupported: null,
        stateCorrect: null,
        contradictsAudit: null,
      })),
    },
  };
}
