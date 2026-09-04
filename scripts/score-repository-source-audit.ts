import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  aggregateRepositorySourceAuditOutcome,
  computeRepositorySourceAuditSourceDigest,
  parseRepositorySourceAuditManifest,
  repositorySourceAuditRepositoryDigest,
} from "@/src/evals/repository-source-audit";
import {
  REPOSITORY_SOURCE_AUDIT_PACKET_SCHEMA_VERSION,
  repositorySourceAuditLiveRunBindingSchema,
} from "@/src/evals/repository-source-audit-packet";

export const REPOSITORY_SOURCE_AUDIT_SCORE_SCHEMA_VERSION =
  "repository-source-audit-score-v1" as const;

const nonEmptyString = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/iu);
const commitSha = z.string().regex(/^[a-f0-9]{40}$/iu);

const executionIntegritySchema = z.object({
  passed: z.boolean(),
  issues: z.array(nonEmptyString),
  modelIdentities: z.array(nonEmptyString),
  policyVersions: z.array(nonEmptyString),
}).strict();

const savedEvidenceSchema = z.object({
  path: nonEmptyString,
  lineStart: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  quote: z.string().nullable(),
  hasExactRangeAndQuote: z.boolean(),
}).strict();

const savedOutputSchema = z.object({
  id: nonEmptyString.max(300),
  kind: z.enum(["fact", "highlight"]),
  text: nonEmptyString,
  summary: z.string().nullable(),
  claimState: z.string().nullable(),
  domain: z.string().nullable(),
  evidence: z.array(savedEvidenceSchema),
}).strict();

const savedOutputCountsSchema = z.object({
  highlights: z.number().int().nonnegative(),
  facts: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  evidenceReferences: z.number().int().nonnegative(),
  exactRangeAndQuoteReferences: z.number().int().nonnegative(),
  outputsWithoutEvidence: z.number().int().nonnegative(),
}).strict();

const packetSchema = z.object({
  schemaVersion: z.literal(REPOSITORY_SOURCE_AUDIT_PACKET_SCHEMA_VERSION),
  manifestDigest: digest,
  auditDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  method: nonEmptyString,
  workItemId: nonEmptyString,
  liveRunProvenance: z.unknown().optional(),
  sourceAudit: z.unknown(),
  observation: z.object({
    fixtureId: nonEmptyString,
    repository: nonEmptyString,
    commitSha,
    refreshRunId: nonEmptyString.optional(),
    executionIntegrity: executionIntegritySchema,
    adjudicationEligible: z.boolean(),
    inventory: z.unknown(),
    coverage: z.unknown(),
    performance: z.unknown(),
    savedOutputCounts: savedOutputCountsSchema,
    savedOutputs: z.array(savedOutputSchema),
  }).strict(),
  adjudicationTemplate: z.unknown(),
}).strict();

const adjudicationSchema = z.object({
  unitAdjudications: z.array(z.unknown()),
  highlightAdjudications: z.array(z.unknown()),
  questionAdjudications: z.array(z.unknown()),
}).strict();

type AggregateInput = Parameters<typeof aggregateRepositorySourceAuditOutcome>[0];
type ParsedPacket = z.infer<typeof packetSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
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

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameRepository(left: string, right: string) {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function exactEvidence(reference: z.infer<typeof savedEvidenceSchema>) {
  return reference.lineStart !== null &&
    reference.lineEnd !== null &&
    reference.lineEnd >= reference.lineStart &&
    Boolean(reference.quote?.trim());
}

function assertPacketConsistency(packet: z.infer<typeof packetSchema>) {
  const outputs = packet.observation.savedOutputs;
  const outputIds = outputs.map((output) => output.id);
  if (new Set(outputIds).size !== outputIds.length) {
    throw new Error("Repository source-audit packet has duplicate saved output ids.");
  }
  for (const output of outputs) {
    for (const reference of output.evidence) {
      if (reference.hasExactRangeAndQuote !== exactEvidence(reference)) {
        throw new Error(
          `Saved output ${output.id} has an inconsistent exact-evidence marker.`,
        );
      }
    }
  }
  const references = outputs.flatMap((output) => output.evidence);
  const actualCounts = {
    highlights: outputs.filter((output) => output.kind === "highlight").length,
    facts: outputs.filter((output) => output.kind === "fact").length,
    total: outputs.length,
    evidenceReferences: references.length,
    exactRangeAndQuoteReferences: references.filter(exactEvidence).length,
    outputsWithoutEvidence: outputs.filter((output) => output.evidence.length === 0)
      .length,
  };
  for (const [key, value] of Object.entries(actualCounts)) {
    if (packet.observation.savedOutputCounts[
      key as keyof typeof actualCounts
    ] !== value) {
      throw new Error(
        `Repository source-audit packet savedOutputCounts.${key} does not match its saved outputs.`,
      );
    }
  }
  if (
    packet.observation.adjudicationEligible !==
      packet.observation.executionIntegrity.passed
  ) {
    throw new Error(
      "Repository source-audit packet eligibility disagrees with execution integrity.",
    );
  }
}

function sourceAuditRepositoryFromPacket(packet: ParsedPacket) {
  const manifest = parseRepositorySourceAuditManifest({
    schemaVersion: "repository-source-audit-v1",
    auditDate: packet.auditDate,
    method: packet.method,
    repositories: [packet.sourceAudit],
  });
  return manifest.repositories[0]!;
}

export function scoreRepositorySourceAudit(input: {
  packet: unknown;
  adjudication: unknown;
  historicalControl?: boolean;
}) {
  const packet = packetSchema.parse(input.packet);
  const adjudication = adjudicationSchema.parse(input.adjudication);
  assertPacketConsistency(packet);

  const repository = sourceAuditRepositoryFromPacket(packet);
  const liveRunProvenance = packet.liveRunProvenance === undefined
    ? null
    : repositorySourceAuditLiveRunBindingSchema.parse(packet.liveRunProvenance);
  if (
    packet.observation.fixtureId !== repository.fixtureId ||
    !sameRepository(packet.observation.repository, repository.repository) ||
    packet.observation.commitSha.toLocaleLowerCase() !==
      repository.commitSha.toLocaleLowerCase()
  ) {
    throw new Error(
      "Repository source-audit packet observation does not match its source-audit identity.",
    );
  }

  const historicalControlOverrideUsed =
    !packet.observation.adjudicationEligible && input.historicalControl === true;
  if (
    !packet.observation.adjudicationEligible &&
    !historicalControlOverrideUsed
  ) {
    throw new Error(
      "Repository source-audit packet is not adjudication-eligible. Supply --historical-control only for an explicitly labeled historical control.",
    );
  }
  if (packet.observation.adjudicationEligible) {
    const fixture = liveRunProvenance?.fixture;
    if (
      !liveRunProvenance ||
      !fixture ||
      fixture.fixtureId !== repository.fixtureId ||
      !sameRepository(fixture.repository, repository.repository) ||
      fixture.snapshotCommit.toLocaleLowerCase() !==
        repository.commitSha.toLocaleLowerCase() ||
      fixture.workItemId !== packet.workItemId ||
      fixture.refreshRunId !== packet.observation.refreshRunId
    ) {
      throw new Error(
        "Current source-audit score lacks an exact verified live-run binding.",
      );
    }
  }

  const observedHighlightIds = packet.observation.savedOutputs
    .filter((output) => output.kind === "highlight")
    .map((output) => output.id);
  const outcome = aggregateRepositorySourceAuditOutcome({
    repository,
    unitAdjudications:
      adjudication.unitAdjudications as AggregateInput["unitAdjudications"],
    observedHighlightIds,
    highlightAdjudications:
      adjudication.highlightAdjudications as AggregateInput["highlightAdjudications"],
    questionAdjudications:
      adjudication.questionAdjudications as AggregateInput["questionAdjudications"],
  });

  const unitsByState = Object.fromEntries(
    ["implemented", "partial", "planned", "absent"].map((state) => [
      state,
      repository.knowledgeUnits.filter((unit) => unit.state === state).length,
    ]),
  );
  const unitsByImportance = Object.fromEntries(
    ["major", "supporting"].map((importance) => [
      importance,
      repository.knowledgeUnits.filter((unit) => unit.importance === importance)
        .length,
    ]),
  );
  const unitsByHighlightRelevance = Object.fromEntries(
    ["must", "should", "not_expected"].map((relevance) => [
      relevance,
      repository.knowledgeUnits.filter((unit) =>
        unit.highlightRelevance === relevance
      ).length,
    ]),
  );
  const unitAdjudications =
    adjudication.unitAdjudications as AggregateInput["unitAdjudications"];
  const highlightAdjudications =
    adjudication.highlightAdjudications as AggregateInput["highlightAdjudications"];
  const questionAdjudications =
    adjudication.questionAdjudications as AggregateInput["questionAdjudications"];

  return {
    schemaVersion: REPOSITORY_SOURCE_AUDIT_SCORE_SCHEMA_VERSION,
    provenance: {
      packetSchemaVersion: packet.schemaVersion,
      packetDigest: sha256(packet),
      adjudicationDigest: sha256(adjudication),
      manifestDigest: packet.manifestDigest,
      sourceAuditDigest: repositorySourceAuditRepositoryDigest(repository),
      auditDate: packet.auditDate,
      workItemId: packet.workItemId,
      fixtureId: repository.fixtureId,
      repository: repository.repository,
      commitSha: repository.commitSha,
      sourceScope: repository.sourceScope,
      sourceDigest: repository.sourceDigest,
      ...(liveRunProvenance ? {
        liveRun: {
          artifactDigest: liveRunProvenance.artifactDigest,
          variant: liveRunProvenance.variant,
          implementationCommitSha:
            liveRunProvenance.implementation.commitSha,
          implementationBranch: liveRunProvenance.implementation.branch,
          refreshRunId: liveRunProvenance.fixture.refreshRunId,
        },
      } : {}),
    },
    certification: {
      status: historicalControlOverrideUsed
        ? "historical_control"
        : "current_run_eligible",
      currentRunEligible: packet.observation.adjudicationEligible,
      historicalControlOverrideUsed,
      executionIntegrity: {
        ...packet.observation.executionIntegrity,
        issues: [...packet.observation.executionIntegrity.issues].sort(),
        modelIdentities: [
          ...packet.observation.executionIntegrity.modelIdentities,
        ].sort(),
        policyVersions: [
          ...packet.observation.executionIntegrity.policyVersions,
        ].sort(),
      },
      sourceTreeVerification: {
        status: "not_verified",
        repositoryRoot: null,
        computedSourceDigest: null,
      },
      ...(liveRunProvenance ? {
        liveRunBinding: {
          status: "verified" as const,
          artifactDigest: liveRunProvenance.artifactDigest,
          implementationCommitSha:
            liveRunProvenance.implementation.commitSha,
          implementationBranch: liveRunProvenance.implementation.branch,
          refreshRunId: liveRunProvenance.fixture.refreshRunId,
        },
      } : {}),
    },
    diagnostics: {
      scoringUniverse: {
        knowledgeUnits: repository.knowledgeUnits.length,
        unitsByState,
        unitsByImportance,
        unitsByHighlightRelevance,
        userQuestions: repository.userQuestions.length,
        observedHighlights: observedHighlightIds.length,
      },
      savedOutputs: packet.observation.savedOutputCounts,
      adjudication: {
        unitAdjudications: unitAdjudications.length,
        highlightAdjudications: highlightAdjudications.length,
        questionAdjudications: questionAdjudications.length,
        contradictedUnitIds: unitAdjudications
          .filter((entry) => entry.contradictsAudit)
          .map((entry) => entry.unitId)
          .sort(),
        duplicateHighlightIds: highlightAdjudications
          .filter((entry) => entry.semanticDuplicateOf !== null)
          .map((entry) => entry.highlightId)
          .sort(),
        lowValueHighlightIds: highlightAdjudications
          .filter((entry) => entry.salience === "low_value")
          .map((entry) => entry.highlightId)
          .sort(),
        lessThanFullyAnswerableQuestions: questionAdjudications
          .filter((entry) => entry.answerability !== "full")
          .map((entry) => entry.question)
          .sort(),
      },
      countNeutral: true,
    },
    semanticDetails: {
      units: repository.knowledgeUnits
        .map((unit) => ({
          ...unitAdjudications.find((entry) => entry.unitId === unit.id)!,
          claim: unit.claim,
          state: unit.state,
          importance: unit.importance,
          highlightRelevance: unit.highlightRelevance,
          domain: unit.domain,
          kind: unit.kind,
          uncertainty: unit.uncertainty ?? null,
        }))
        .sort((left, right) => left.unitId.localeCompare(right.unitId)),
      highlights: [...highlightAdjudications]
        .sort((left, right) => left.highlightId.localeCompare(right.highlightId)),
      questions: [...questionAdjudications]
        .sort((left, right) => left.question.localeCompare(right.question)),
    },
    outcome,
  } as const;
}

export async function scoreRepositorySourceAuditAtRepositoryRoot(input: {
  packet: unknown;
  adjudication: unknown;
  repositoryRoot: string;
  historicalControl?: boolean;
}) {
  const packet = packetSchema.parse(input.packet);
  const repository = sourceAuditRepositoryFromPacket(packet);
  const computed = await computeRepositorySourceAuditSourceDigest({
    repository,
    repositoryRoot: input.repositoryRoot,
  });
  if (
    computed.sourceDigest.toLocaleLowerCase() !==
      repository.sourceDigest.toLocaleLowerCase()
  ) {
    throw new Error(
      `Source digest mismatch for ${repository.fixtureId}: computed ${computed.sourceDigest}, expected ${repository.sourceDigest}.`,
    );
  }
  const report = scoreRepositorySourceAudit(input);
  return {
    ...report,
    certification: {
      ...report.certification,
      sourceTreeVerification: {
        status: "verified",
        repositoryRoot: computed.repositoryRoot,
        computedSourceDigest: computed.sourceDigest,
      },
    },
  } as const;
}

type Options = {
  adjudicationPath: string | null;
  compact: boolean;
  help: boolean;
  historicalControl: boolean;
  packetPath: string | null;
  repositoryRoot: string | null;
};

function usage() {
  return `Score a filled semantic adjudication against its complete source-audit packet.

Usage:
  npx tsx scripts/score-repository-source-audit.ts \\
    --packet <packet.json> \\
    --adjudication <filled-adjudication.json> \\
    --repository-root <clean-pinned-checkout> \\
    [--historical-control] [--compact]

The adjudication JSON must contain exactly unitAdjudications,
highlightAdjudications, and questionAdjudications. Ineligible current runs are
rejected. --historical-control permits scoring an older run while preserving an
explicit non-certified label in the report. The repository root must be a clean
checkout at the audited commit; its anchored source digest is verified before a
score is emitted. Counts are diagnostic only.`;
}

function optionValue(args: readonly string[], index: number, name: string) {
  const argument = args[index]!;
  const inline = argument.startsWith(`${name}=`)
    ? argument.slice(name.length + 1)
    : null;
  const value = inline ?? args[index + 1];
  if (!value?.trim() || (inline === null && value.startsWith("--"))) {
    throw new Error(`${name} requires a value.\n\n${usage()}`);
  }
  return { consumed: inline === null ? 1 : 0, value: value.trim() };
}

export function parseRepositorySourceAuditScoreOptions(
  args: readonly string[],
): Options {
  const options: Options = {
    adjudicationPath: null,
    compact: false,
    help: false,
    historicalControl: false,
    packetPath: null,
    repositoryRoot: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--compact") {
      options.compact = true;
      continue;
    }
    if (argument === "--historical-control") {
      options.historicalControl = true;
      continue;
    }
    if (argument === "--packet" || argument.startsWith("--packet=")) {
      const resolved = optionValue(args, index, "--packet");
      options.packetPath = resolve(resolved.value);
      index += resolved.consumed;
      continue;
    }
    if (
      argument === "--adjudication" ||
      argument.startsWith("--adjudication=")
    ) {
      const resolved = optionValue(args, index, "--adjudication");
      options.adjudicationPath = resolve(resolved.value);
      index += resolved.consumed;
      continue;
    }
    if (
      argument === "--repository-root" ||
      argument.startsWith("--repository-root=")
    ) {
      const resolved = optionValue(args, index, "--repository-root");
      options.repositoryRoot = resolve(resolved.value);
      index += resolved.consumed;
      continue;
    }
    throw new Error(`Unknown option: ${argument}.\n\n${usage()}`);
  }
  return options;
}

async function main() {
  const options = parseRepositorySourceAuditScoreOptions(
    process.argv.slice(2),
  );
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.packetPath || !options.adjudicationPath || !options.repositoryRoot) {
    throw new Error(
      `--packet, --adjudication, and --repository-root are required.\n\n${usage()}`,
    );
  }
  const [packetJson, adjudicationJson] = await Promise.all([
    readFile(options.packetPath, "utf8"),
    readFile(options.adjudicationPath, "utf8"),
  ]);
  const report = await scoreRepositorySourceAuditAtRepositoryRoot({
    packet: JSON.parse(packetJson) as unknown,
    adjudication: JSON.parse(adjudicationJson) as unknown,
    historicalControl: options.historicalControl,
    repositoryRoot: options.repositoryRoot,
  });
  process.stdout.write(
    `${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`,
  );
}

const executablePath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (executablePath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
