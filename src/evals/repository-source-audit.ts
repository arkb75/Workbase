import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { z } from "zod";

export const REPOSITORY_SOURCE_AUDIT_SCHEMA_VERSION =
  "repository-source-audit-v1" as const;

const maximumGitManifestBytes = 128 * 1024 * 1024;
const maximumAnchoredFileBytes = 2 * 1024 * 1024;
const maximumTotalAnchoredBytes = 32 * 1024 * 1024;

function safeRepositoryPath(path: string) {
  return !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const repositorySourceAnchorSchema = z.object({
  path: z.string().trim().min(1).max(2_000).refine(
    safeRepositoryPath,
    "Anchor path must be a normalized repository-relative path.",
  ),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
}).strict().superRefine((anchor, context) => {
  if (anchor.lineEnd < anchor.lineStart) {
    context.addIssue({
      code: "custom",
      message: "Anchor lineEnd must be greater than or equal to lineStart.",
      path: ["lineEnd"],
    });
  }
});

const repositorySourceKnowledgeUnitSchema = z.object({
  id: z.string().trim().min(1).max(300),
  claim: z.string().trim().min(1).max(5_000),
  state: z.enum(["implemented", "partial", "planned", "absent"]),
  importance: z.enum(["major", "supporting"]),
  highlightRelevance: z.enum(["must", "should", "not_expected"]),
  domain: z.string().trim().min(1).max(300),
  kind: z.enum([
    "workflow",
    "capability",
    "architecture",
    "integration",
    "data",
    "constraint",
  ]),
  anchors: z.array(repositorySourceAnchorSchema).min(1).max(50),
  uncertainty: z.string().trim().min(1).max(5_000).optional(),
}).strict();

const repositorySourceAuditRepositorySchema = z.object({
  fixtureId: z.string().trim().min(1).max(200),
  repository: z.string().trim().min(1).max(300),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/iu),
  sourceScope: z.literal("tracked_git_tree"),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/iu),
  knowledgeUnits: z.array(repositorySourceKnowledgeUnitSchema).min(1).max(1_000),
  userQuestions: z.array(z.string().trim().min(1).max(2_000)).min(1).max(200),
}).strict().superRefine((repository, context) => {
  const unitIds = new Set<string>();
  repository.knowledgeUnits.forEach((unit, index) => {
    if (unitIds.has(unit.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate knowledge unit id: ${unit.id}.`,
        path: ["knowledgeUnits", index, "id"],
      });
    }
    unitIds.add(unit.id);
    if (unit.state !== "implemented" && unit.highlightRelevance !== "not_expected") {
      context.addIssue({
        code: "custom",
        message: "Only implemented units may be expected in Highlights.",
        path: ["knowledgeUnits", index, "highlightRelevance"],
      });
    }
  });
});

const repositorySourceAuditManifestSchema = z.object({
  schemaVersion: z.literal(REPOSITORY_SOURCE_AUDIT_SCHEMA_VERSION),
  auditDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  method: z.string().trim().min(1).max(10_000),
  repositories: z.array(repositorySourceAuditRepositorySchema).min(1).max(100),
}).strict().superRefine((manifest, context) => {
  const fixtureIds = new Set<string>();
  const repositoryCommits = new Set<string>();
  const unitIds = new Set<string>();
  manifest.repositories.forEach((repository, repositoryIndex) => {
    if (fixtureIds.has(repository.fixtureId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate fixture id: ${repository.fixtureId}.`,
        path: ["repositories", repositoryIndex, "fixtureId"],
      });
    }
    fixtureIds.add(repository.fixtureId);
    const repositoryCommit = `${repository.repository.toLocaleLowerCase()}@${repository.commitSha.toLocaleLowerCase()}`;
    if (repositoryCommits.has(repositoryCommit)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate repository commit: ${repository.repository}@${repository.commitSha}.`,
        path: ["repositories", repositoryIndex, "commitSha"],
      });
    }
    repositoryCommits.add(repositoryCommit);
    repository.knowledgeUnits.forEach((unit, unitIndex) => {
      if (unitIds.has(unit.id)) {
        context.addIssue({
          code: "custom",
          message: `Knowledge unit ids must be globally unique: ${unit.id}.`,
          path: ["repositories", repositoryIndex, "knowledgeUnits", unitIndex, "id"],
        });
      }
      unitIds.add(unit.id);
    });
  });
});

export type RepositorySourceAnchor = z.infer<typeof repositorySourceAnchorSchema>;
export type RepositorySourceKnowledgeUnit = z.infer<
  typeof repositorySourceKnowledgeUnitSchema
>;
export type RepositorySourceAuditRepository = z.infer<
  typeof repositorySourceAuditRepositorySchema
>;
export type RepositorySourceAuditManifest = z.infer<
  typeof repositorySourceAuditManifestSchema
>;

export function parseRepositorySourceAuditManifest(
  input: unknown,
): RepositorySourceAuditManifest {
  return repositorySourceAuditManifestSchema.parse(input);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) =>
      `${JSON.stringify(key)}:${canonicalJson(child)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function repositorySourceAuditManifestDigest(
  manifest: RepositorySourceAuditManifest,
) {
  return sha256(canonicalJson(manifest));
}

/**
 * Binds a score to the complete frozen repository audit, including exact
 * source anchors. The manifest digest binds the suite; this narrower digest
 * lets a comparator verify each independently scored repository entry.
 */
export function repositorySourceAuditRepositoryDigest(
  repository: RepositorySourceAuditRepository,
) {
  return sha256(canonicalJson(repository));
}

export interface HydratedRepositorySourceAnchor extends RepositorySourceAnchor {
  content: string;
  contentDigest: string;
}

export function repositorySourceAuditSourceDigest(
  anchors: readonly HydratedRepositorySourceAnchor[],
) {
  const uniqueAnchors = new Map<string, HydratedRepositorySourceAnchor>();
  for (const anchor of anchors) {
    const key = `${anchor.path}:${anchor.lineStart}-${anchor.lineEnd}`;
    if (anchor.contentDigest !== sha256(anchor.content)) {
      throw new Error(`Hydrated content digest mismatch for source anchor ${key}.`);
    }
    const existing = uniqueAnchors.get(key);
    if (existing && existing.content !== anchor.content) {
      throw new Error(`Conflicting hydrated content for source anchor ${key}.`);
    }
    uniqueAnchors.set(key, anchor);
  }
  const canonicalAnchors = Array.from(uniqueAnchors.values())
    .sort((left, right) =>
      left.path.localeCompare(right.path) ||
      left.lineStart - right.lineStart ||
      left.lineEnd - right.lineEnd
    )
    .map(({ path, lineStart, lineEnd, content, contentDigest }) => ({
      path,
      lineStart,
      lineEnd,
      content,
      contentDigest,
    }));
  return sha256(canonicalJson(canonicalAnchors));
}

function gitOutput(
  root: string,
  args: string[],
  maxBuffer = 1024 * 1024,
) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: null, maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `Unable to inspect repository ${root}: ${stderr.toString().trim() || error.message}`,
          ));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function assertPinnedCleanCheckout(
  repository: RepositorySourceAuditRepository,
  root: string,
) {
  const [checkoutRoot, requestedRoot, head, trackedChanges] = await Promise.all([
    gitOutput(root, ["rev-parse", "--show-toplevel"]).then((value) =>
      realpath(value.toString("utf8").trim())
    ),
    realpath(root),
    gitOutput(root, ["rev-parse", "HEAD"]).then((value) =>
      value.toString("utf8").trim()
    ),
    gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=no"]),
  ]);
  if (checkoutRoot !== requestedRoot) {
    throw new Error(
      `Repository root ${root} resolves to ${checkoutRoot}; pass the checkout root itself.`,
    );
  }
  if (head.toLocaleLowerCase() !== repository.commitSha.toLocaleLowerCase()) {
    throw new Error(
      `Repository ${repository.fixtureId} is at ${head}; expected ${repository.commitSha}.`,
    );
  }
  if (trackedChanges.length) {
    throw new Error(
      `Repository ${repository.fixtureId} has tracked working-tree changes.`,
    );
  }
  return requestedRoot;
}

async function pinnedBlobIds(root: string, commitSha: string) {
  const output = await gitOutput(
    root,
    ["ls-tree", "-r", "-z", commitSha],
    maximumGitManifestBytes,
  );
  const blobs = new Map<string, string>();
  for (const entry of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^\d+ (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error(`Unable to parse pinned Git tree entry: ${entry}.`);
    if (match[1] === "blob") blobs.set(match[3]!, match[2]!);
  }
  return blobs;
}

function anchorContent(
  fileContent: string,
  anchor: RepositorySourceAnchor,
) {
  const lines = fileContent.split("\n");
  if (anchor.lineEnd > lines.length) {
    throw new Error(
      `Source anchor ${anchor.path}:${anchor.lineStart}-${anchor.lineEnd} exceeds the ${lines.length}-line pinned blob.`,
    );
  }
  return lines.slice(anchor.lineStart - 1, anchor.lineEnd).join("\n");
}

export async function computeRepositorySourceAuditSourceDigest(input: {
  repository: RepositorySourceAuditRepository;
  repositoryRoot: string;
}) {
  const root = await assertPinnedCleanCheckout(
    input.repository,
    input.repositoryRoot,
  );
  const blobIds = await pinnedBlobIds(root, input.repository.commitSha);
  const anchors = input.repository.knowledgeUnits.flatMap((unit) => unit.anchors);
  const distinctPaths = Array.from(new Set(anchors.map((anchor) => anchor.path)));
  const contentByPath = new Map<string, string>();
  let totalBytes = 0;
  for (const path of distinctPaths) {
    const blobId = blobIds.get(path);
    if (!blobId) {
      throw new Error(
        `Source anchor path ${path} is not a tracked blob at ${input.repository.commitSha}.`,
      );
    }
    const content = await gitOutput(
      root,
      ["cat-file", "blob", blobId],
      maximumAnchoredFileBytes + 1,
    );
    if (content.length > maximumAnchoredFileBytes) {
      throw new Error(
        `Anchored source file ${path} exceeds ${maximumAnchoredFileBytes} bytes.`,
      );
    }
    if (content.includes(0)) {
      throw new Error(`Anchored source file ${path} is binary.`);
    }
    totalBytes += content.length;
    if (totalBytes > maximumTotalAnchoredBytes) {
      throw new Error(
        `Anchored source content exceeds ${maximumTotalAnchoredBytes} bytes.`,
      );
    }
    contentByPath.set(path, content.toString("utf8"));
  }
  const hydratedAnchors = anchors.map((anchor) => {
    const content = anchorContent(contentByPath.get(anchor.path)!, anchor);
    return {
      ...anchor,
      content,
      contentDigest: sha256(content),
    } satisfies HydratedRepositorySourceAnchor;
  });
  return {
    repositoryRoot: root,
    sourceDigest: repositorySourceAuditSourceDigest(hydratedAnchors),
    hydratedAnchors,
  };
}

export async function hydrateRepositorySourceAuditManifest(input: {
  manifest: RepositorySourceAuditManifest;
  repositoryRoots: ReadonlyMap<string, string>;
}) {
  const repositories = await Promise.all(input.manifest.repositories.map(
    async (repository) => {
      const repositoryRoot = input.repositoryRoots.get(repository.fixtureId);
      if (!repositoryRoot) {
        throw new Error(
          `Missing repository root for source audit fixture ${repository.fixtureId}.`,
        );
      }
      const computed = await computeRepositorySourceAuditSourceDigest({
        repository,
        repositoryRoot,
      });
      if (
        computed.sourceDigest.toLocaleLowerCase() !==
          repository.sourceDigest.toLocaleLowerCase()
      ) {
        throw new Error(
          `Source digest mismatch for ${repository.fixtureId}: computed ${computed.sourceDigest}, expected ${repository.sourceDigest}.`,
        );
      }
      const hydratedByKey = new Map(computed.hydratedAnchors.map((anchor) => [
        `${anchor.path}:${anchor.lineStart}-${anchor.lineEnd}`,
        anchor,
      ]));
      return {
        ...repository,
        repositoryRoot: computed.repositoryRoot,
        knowledgeUnits: repository.knowledgeUnits.map((unit) => ({
          ...unit,
          anchors: unit.anchors.map((anchor) =>
            hydratedByKey.get(
              `${anchor.path}:${anchor.lineStart}-${anchor.lineEnd}`,
            )!
          ),
        })),
      };
    },
  ));
  return {
    ...input.manifest,
    manifestDigest: repositorySourceAuditManifestDigest(input.manifest),
    repositories,
  };
}

const repositorySourceCoverageSchema = z.enum([
  "full",
  "substantial",
  "partial",
  "tangential",
  "none",
]);

const repositorySourceUnitAdjudicationSchema = z.object({
  unitId: z.string().trim().min(1).max(300),
  knowledgeCoverage: repositorySourceCoverageSchema,
  highlightCoverage: repositorySourceCoverageSchema,
  evidenceSupported: z.boolean(),
  stateCorrect: z.boolean(),
  qualifierCoverage: repositorySourceCoverageSchema.nullable(),
  contradictsAudit: z.boolean(),
}).strict();

export type RepositorySourceUnitAdjudication = z.infer<
  typeof repositorySourceUnitAdjudicationSchema
>;

function coverageValue(value: z.infer<typeof repositorySourceCoverageSchema>) {
  switch (value) {
    case "full":
      return 1;
    case "substantial":
      return 0.75;
    case "partial":
      return 0.5;
    case "tangential":
      return 0.25;
    case "none":
      return 0;
  }
}

function ratioOrNull(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

function rounded(value: number | null) {
  return value === null ? null : Number(value.toFixed(6));
}

export function aggregateRepositorySourceAuditAdjudications(input: {
  repository: RepositorySourceAuditRepository;
  adjudications: readonly RepositorySourceUnitAdjudication[];
}) {
  const adjudications = z.array(repositorySourceUnitAdjudicationSchema)
    .parse(input.adjudications);
  const knownUnitIds = new Set(input.repository.knowledgeUnits.map((unit) => unit.id));
  const adjudicationById = new Map<string, RepositorySourceUnitAdjudication>();
  for (const adjudication of adjudications) {
    if (!knownUnitIds.has(adjudication.unitId)) {
      throw new Error(`Unknown source-audit unit adjudication: ${adjudication.unitId}.`);
    }
    if (adjudicationById.has(adjudication.unitId)) {
      throw new Error(`Duplicate source-audit unit adjudication: ${adjudication.unitId}.`);
    }
    adjudicationById.set(adjudication.unitId, adjudication);
  }
  const missing = input.repository.knowledgeUnits.filter((unit) =>
    !adjudicationById.has(unit.id)
  );
  if (missing.length) {
    throw new Error(
      `Missing source-audit adjudications: ${missing.map((unit) => unit.id).join(", ")}.`,
    );
  }
  for (const unit of input.repository.knowledgeUnits) {
    const qualifierCoverage = adjudicationById.get(unit.id)!.qualifierCoverage;
    if (unit.uncertainty && qualifierCoverage === null) {
      throw new Error(
        `Missing qualifier adjudication for source-audit unit ${unit.id}.`,
      );
    }
    if (!unit.uncertainty && qualifierCoverage !== null) {
      throw new Error(
        `Unexpected qualifier adjudication for source-audit unit ${unit.id}.`,
      );
    }
  }

  const implemented = input.repository.knowledgeUnits.filter((unit) =>
    unit.state === "implemented" || unit.state === "partial"
  );
  const implementedScore = (unit: RepositorySourceKnowledgeUnit) =>
    coverageValue(adjudicationById.get(unit.id)!.knowledgeCoverage);
  const weightedKnowledgeDenominator = implemented.reduce(
    (sum, unit) => sum + (unit.importance === "major" ? 2 : 1),
    0,
  );
  const weightedKnowledgeNumerator = implemented.reduce(
    (sum, unit) =>
      sum + implementedScore(unit) * (unit.importance === "major" ? 2 : 1),
    0,
  );
  const major = implemented.filter((unit) => unit.importance === "major");
  const supporting = implemented.filter((unit) => unit.importance === "supporting");
  const highlightExpected = implemented.filter((unit) =>
    unit.highlightRelevance !== "not_expected"
  );
  const mustHighlight = highlightExpected.filter((unit) =>
    unit.highlightRelevance === "must"
  );
  const highlightWeight = (unit: RepositorySourceKnowledgeUnit) =>
    unit.highlightRelevance === "must" ? 2 : 1;
  const weightedHighlightDenominator = highlightExpected.reduce(
    (sum, unit) => sum + highlightWeight(unit),
    0,
  );
  const weightedHighlightNumerator = highlightExpected.reduce(
    (sum, unit) =>
      sum + coverageValue(adjudicationById.get(unit.id)!.highlightCoverage) *
        highlightWeight(unit),
    0,
  );
  const matched = input.repository.knowledgeUnits.filter((unit) =>
    coverageValue(adjudicationById.get(unit.id)!.knowledgeCoverage) > 0 ||
    coverageValue(adjudicationById.get(unit.id)!.highlightCoverage) > 0
  );
  const qualified = input.repository.knowledgeUnits.filter((unit) => unit.uncertainty);
  const constraints = input.repository.knowledgeUnits.filter((unit) =>
    unit.state === "planned" || unit.state === "absent"
  );
  const addressed = input.repository.knowledgeUnits.filter((unit) =>
    coverageValue(adjudicationById.get(unit.id)!.knowledgeCoverage) > 0 ||
    coverageValue(adjudicationById.get(unit.id)!.highlightCoverage) > 0 ||
    adjudicationById.get(unit.id)!.contradictsAudit
  );
  const addressedConstraints = constraints.filter((unit) =>
    coverageValue(adjudicationById.get(unit.id)!.knowledgeCoverage) > 0 ||
    coverageValue(adjudicationById.get(unit.id)!.highlightCoverage) > 0 ||
    adjudicationById.get(unit.id)!.contradictsAudit
  );
  const contradictionCount = input.repository.knowledgeUnits.filter((unit) =>
    adjudicationById.get(unit.id)!.contradictsAudit
  ).length;
  const fullMajorUnitIds = major.filter((unit) => implementedScore(unit) === 1)
    .map((unit) => unit.id);
  return {
    weightedKnowledgeRecall: rounded(ratioOrNull(
      weightedKnowledgeNumerator,
      weightedKnowledgeDenominator,
    )),
    majorKnowledgeRecall: rounded(ratioOrNull(
      major.reduce((sum, unit) => sum + implementedScore(unit), 0),
      major.length,
    )),
    supportingKnowledgeRecall: rounded(ratioOrNull(
      supporting.reduce((sum, unit) => sum + implementedScore(unit), 0),
      supporting.length,
    )),
    mustHighlightRecall: rounded(ratioOrNull(
      mustHighlight.reduce((sum, unit) =>
        sum + coverageValue(adjudicationById.get(unit.id)!.highlightCoverage), 0),
      mustHighlight.length,
    )),
    weightedHighlightRecall: rounded(ratioOrNull(
      weightedHighlightNumerator,
      weightedHighlightDenominator,
    )),
    matchedUnitGrounding: rounded(ratioOrNull(
      matched.filter((unit) => adjudicationById.get(unit.id)!.evidenceSupported)
        .length,
      matched.length,
    )),
    stateCorrectness: rounded(ratioOrNull(
      addressed.filter((unit) => {
        const adjudication = adjudicationById.get(unit.id)!;
        return adjudication.stateCorrect && !adjudication.contradictsAudit;
      }).length,
      addressed.length,
    )),
    qualifierPreservation: rounded(ratioOrNull(
      qualified.reduce((sum, unit) => {
        const coverage = adjudicationById.get(unit.id)!.qualifierCoverage;
        return sum + (coverage === null ? 0 : coverageValue(coverage));
      }, 0),
      qualified.length,
    )),
    constraintRecall: rounded(ratioOrNull(
      constraints.reduce((sum, unit) => {
        const adjudication = adjudicationById.get(unit.id)!;
        return sum + (
          adjudication.stateCorrect && !adjudication.contradictsAudit
            ? coverageValue(adjudication.knowledgeCoverage)
            : 0
        );
      }, 0),
      constraints.length,
    )),
    constraintCorrectness: rounded(ratioOrNull(
      addressedConstraints.filter((unit) => {
        const adjudication = adjudicationById.get(unit.id)!;
        return adjudication.stateCorrect && !adjudication.contradictsAudit;
      }).length,
      addressedConstraints.length,
    )),
    contradictionRate: rounded(ratioOrNull(
      contradictionCount,
      input.repository.knowledgeUnits.length,
    )),
    fullMajorUnitIds,
    missedMajorUnitIds: major.filter((unit) => implementedScore(unit) < 1)
      .map((unit) => unit.id),
  };
}

const repositorySourceQuestionAdjudicationSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  answerability: repositorySourceCoverageSchema,
  supportingUnitIds: z.array(z.string().trim().min(1).max(300)).max(100),
  evidenceSupported: z.boolean(),
  stateCorrect: z.boolean(),
  contradictsAudit: z.boolean(),
}).strict();

const repositorySourceHighlightAdjudicationSchema = z.object({
  highlightId: z.string().trim().min(1).max(300),
  matchedUnitIds: z.array(z.string().trim().min(1).max(300)).max(100),
  salience: z.enum(["major_operation", "supporting_insight", "low_value"]),
  semanticDuplicateOf: z.string().trim().min(1).max(300).nullable(),
}).strict();

export type RepositorySourceQuestionAdjudication = z.infer<
  typeof repositorySourceQuestionAdjudicationSchema
>;
export type RepositorySourceHighlightAdjudication = z.infer<
  typeof repositorySourceHighlightAdjudicationSchema
>;

function exactStringSet(input: {
  expected: readonly string[];
  actual: readonly string[];
  label: string;
}) {
  const expected = new Set(input.expected);
  const actual = new Set(input.actual);
  if (expected.size !== input.expected.length) {
    throw new Error(`Expected ${input.label} set contains duplicates.`);
  }
  if (actual.size !== input.actual.length) {
    throw new Error(`Duplicate ${input.label} adjudication.`);
  }
  const unknown = input.actual.filter((value) => !expected.has(value));
  if (unknown.length) {
    throw new Error(`Unknown ${input.label} adjudication: ${unknown.join(", ")}.`);
  }
  const missing = input.expected.filter((value) => !actual.has(value));
  if (missing.length) {
    throw new Error(`Missing ${input.label} adjudications: ${missing.join(", ")}.`);
  }
}

function salienceValue(
  value: z.infer<typeof repositorySourceHighlightAdjudicationSchema>["salience"],
) {
  return value === "major_operation" ? 1 : value === "supporting_insight" ? 0.5 : 0;
}

/**
 * Adds two output-level measures that unit recall cannot express:
 *
 * - question answerability asks whether the saved Facts and Highlights, by
 *   themselves, contain enough correct and grounded knowledge to answer every
 *   independently authored user question; and
 * - Highlight salience asks whether the finite Highlight surface is allocated
 *   to central operations rather than low-value or duplicate observations.
 *
 * This remains a semantic adjudication. It validates that the grader covers
 * the complete, fixture-defined question set and every actually saved
 * Highlight, while leaving the grader free to recognize paraphrases rather
 * than hard-coding repository-specific text patterns.
 */
export function aggregateRepositorySourceAuditOutcome(input: {
  repository: RepositorySourceAuditRepository;
  unitAdjudications: readonly RepositorySourceUnitAdjudication[];
  observedHighlightIds: readonly string[];
  highlightAdjudications: readonly RepositorySourceHighlightAdjudication[];
  questionAdjudications: readonly RepositorySourceQuestionAdjudication[];
}) {
  const unitAdjudications = z.array(repositorySourceUnitAdjudicationSchema)
    .parse(input.unitAdjudications);
  const unitMetrics = aggregateRepositorySourceAuditAdjudications({
    repository: input.repository,
    adjudications: unitAdjudications,
  });
  const highlights = z.array(repositorySourceHighlightAdjudicationSchema)
    .parse(input.highlightAdjudications);
  const questions = z.array(repositorySourceQuestionAdjudicationSchema)
    .parse(input.questionAdjudications);
  const observedHighlightIds = z.array(z.string().trim().min(1).max(300))
    .parse(input.observedHighlightIds);

  exactStringSet({
    expected: observedHighlightIds,
    actual: highlights.map((highlight) => highlight.highlightId),
    label: "Highlight",
  });
  exactStringSet({
    expected: input.repository.userQuestions,
    actual: questions.map((question) => question.question),
    label: "user-question",
  });

  const knownUnitIds = new Set(
    input.repository.knowledgeUnits.map((unit) => unit.id),
  );
  const unitAdjudicationById = new Map(
    unitAdjudications.map((unit) => [unit.unitId, unit]),
  );
  const assertKnownDistinctUnits = (
    unitIds: readonly string[],
    label: string,
  ) => {
    if (new Set(unitIds).size !== unitIds.length) {
      throw new Error(`${label} contains duplicate source-audit unit ids.`);
    }
    const unknownUnitIds = unitIds.filter((unitId) => !knownUnitIds.has(unitId));
    if (unknownUnitIds.length) {
      throw new Error(
        `${label} references unknown source-audit units: ${unknownUnitIds.join(", ")}.`,
      );
    }
  };
  for (const highlight of highlights) {
    assertKnownDistinctUnits(
      highlight.matchedUnitIds,
      `Highlight ${highlight.highlightId}`,
    );
    if (
      highlight.semanticDuplicateOf === highlight.highlightId ||
      (highlight.semanticDuplicateOf !== null &&
        !observedHighlightIds.includes(highlight.semanticDuplicateOf))
    ) {
      throw new Error(
        `Highlight ${highlight.highlightId} has an invalid semantic duplicate target.`,
      );
    }
  }
  for (const question of questions) {
    assertKnownDistinctUnits(
      question.supportingUnitIds,
      `Question ${question.question}`,
    );
    if (
      coverageValue(question.answerability) > 0 &&
      question.supportingUnitIds.length === 0
    ) {
      throw new Error(
        `Answerable question ${question.question} must identify its supporting source-audit units.`,
      );
    }
    if (
      coverageValue(question.answerability) > 0 &&
      question.evidenceSupported &&
      question.stateCorrect &&
      !question.contradictsAudit &&
      !question.supportingUnitIds.some((unitId) => {
        const unit = unitAdjudicationById.get(unitId)!;
        return coverageValue(unit.knowledgeCoverage) > 0 ||
          coverageValue(unit.highlightCoverage) > 0;
      })
    ) {
      throw new Error(
        `Answerable question ${question.question} has no supporting unit represented in saved knowledge.`,
      );
    }
  }

  const groundedAnswerability = (question: RepositorySourceQuestionAdjudication) =>
    question.evidenceSupported &&
      question.stateCorrect &&
      !question.contradictsAudit
      ? coverageValue(question.answerability)
      : 0;
  const effectiveSalience = (highlight: RepositorySourceHighlightAdjudication) =>
    highlight.semanticDuplicateOf === null ? salienceValue(highlight.salience) : 0;

  return {
    ...unitMetrics,
    questionAnswerability: rounded(ratioOrNull(
      questions.reduce(
        (sum, question) => sum + groundedAnswerability(question),
        0,
      ),
      questions.length,
    )),
    fullyAnswerableQuestionRate: rounded(ratioOrNull(
      questions.filter((question) => groundedAnswerability(question) === 1).length,
      questions.length,
    )),
    highlightSalience: rounded(ratioOrNull(
      highlights.reduce(
        (sum, highlight) => sum + effectiveSalience(highlight),
        0,
      ),
      highlights.length,
    )),
    majorHighlightAllocationRate: rounded(ratioOrNull(
      highlights.filter((highlight) =>
        highlight.salience === "major_operation" &&
        highlight.semanticDuplicateOf === null
      ).length,
      highlights.length,
    )),
    duplicateHighlightRate: rounded(ratioOrNull(
      highlights.filter((highlight) => highlight.semanticDuplicateOf !== null)
        .length,
      highlights.length,
    )),
  };
}
