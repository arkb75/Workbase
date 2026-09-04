import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import sourceAuditFixture from "@/src/evals/fixtures/repository-source-audits-v1.json";
import {
  aggregateRepositorySourceAuditAdjudications,
  aggregateRepositorySourceAuditOutcome,
  computeRepositorySourceAuditSourceDigest,
  hydrateRepositorySourceAuditManifest,
  parseRepositorySourceAuditManifest,
  repositorySourceAuditManifestDigest,
  type RepositorySourceAuditRepository,
} from "@/src/evals/repository-source-audit";

const exec = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(root: string, ...args: string[]) {
  const result = await exec("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function temporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), "workbase-source-audit-"));
  temporaryRoots.push(root);
  await git(root, "init");
  await git(root, "config", "user.name", "Repository Audit Test");
  await git(root, "config", "user.email", "repository-audit@example.invalid");
  await writeFile(
    join(root, "example.ts"),
    ["export const first = 1;", "export const second = 2;", "export const third = 3;", ""].join("\n"),
  );
  await git(root, "add", "example.ts");
  await git(root, "commit", "-m", "fixture");
  return { root, commitSha: await git(root, "rev-parse", "HEAD") };
}

function repositoryAt(commitSha: string, sourceDigest = "0".repeat(64)) {
  return {
    fixtureId: "temporary-library",
    repository: "example/temporary-library",
    commitSha,
    sourceScope: "tracked_git_tree" as const,
    sourceDigest,
    knowledgeUnits: [
      {
        id: "temporary.exports",
        claim: "Exports the second and third values.",
        state: "implemented" as const,
        importance: "major" as const,
        highlightRelevance: "must" as const,
        domain: "library-api",
        kind: "capability" as const,
        anchors: [{ path: "example.ts", lineStart: 2, lineEnd: 3 }],
      },
    ],
    userQuestions: ["Which values does the library export?"],
  } satisfies RepositorySourceAuditRepository;
}

function manifest(repository: RepositorySourceAuditRepository) {
  return parseRepositorySourceAuditManifest({
    schemaVersion: "repository-source-audit-v1",
    auditDate: "2026-09-01",
    method: "Inspect executable source and retain exact anchors.",
    repositories: [repository],
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("repository source-audit manifests", () => {
  it("parses the four-project independent audit without project-specific scorer rules", () => {
    const parsed = parseRepositorySourceAuditManifest(sourceAuditFixture);
    const units = parsed.repositories.flatMap((repository) =>
      repository.knowledgeUnits
    );

    expect(parsed.repositories.map((repository) => repository.fixtureId)).toEqual([
      "solopilot-agent-documents",
      "backer-marketplace",
      "circlefund-fintech",
      "otto-marketing-platform",
    ]);
    expect(units).toHaveLength(84);
    expect(units.filter((unit) => unit.state === "implemented")).toHaveLength(53);
    expect(units.filter((unit) => unit.state === "partial")).toHaveLength(3);
    expect(units.filter((unit) => unit.state === "planned")).toHaveLength(2);
    expect(units.filter((unit) => unit.state === "absent")).toHaveLength(26);
    expect(units.filter((unit) => unit.highlightRelevance === "must"))
      .toHaveLength(30);
    expect(units.filter((unit) => unit.highlightRelevance === "should"))
      .toHaveLength(21);
    expect(units.filter((unit) => unit.highlightRelevance === "not_expected"))
      .toHaveLength(33);
    expect(units.flatMap((unit) => unit.anchors)).toHaveLength(304);
    expect(parsed.repositories.flatMap((repository) => repository.userQuestions))
      .toHaveLength(52);
    expect(parsed.repositories.every((repository) =>
      repository.sourceScope === "tracked_git_tree" &&
      !/^0+$/u.test(repository.sourceDigest)
    )).toBe(true);
  });

  it("rejects unknown fields, duplicate ids, unsafe anchors, and non-implemented Highlight expectations", () => {
    const valid = structuredClone(sourceAuditFixture);
    expect(() => parseRepositorySourceAuditManifest({
      ...valid,
      unexpected: true,
    })).toThrow();

    const duplicate = structuredClone(sourceAuditFixture);
    duplicate.repositories[0]!.knowledgeUnits[1]!.id =
      duplicate.repositories[0]!.knowledgeUnits[0]!.id;
    expect(() => parseRepositorySourceAuditManifest(duplicate))
      .toThrow(/Duplicate knowledge unit id|globally unique/u);

    const unsafe = structuredClone(sourceAuditFixture);
    unsafe.repositories[0]!.knowledgeUnits[0]!.anchors[0]!.path = "../secret";
    expect(() => parseRepositorySourceAuditManifest(unsafe))
      .toThrow(/normalized repository-relative path/u);

    const absentHighlight = structuredClone(sourceAuditFixture);
    const absent = absentHighlight.repositories.flatMap((repository) =>
      repository.knowledgeUnits
    ).find((unit) => unit.state === "absent")!;
    absent.highlightRelevance = "must";
    expect(() => parseRepositorySourceAuditManifest(absentHighlight))
      .toThrow(/Only implemented units/u);

    const noQuestions = structuredClone(sourceAuditFixture);
    noQuestions.repositories[0]!.userQuestions = [];
    expect(() => parseRepositorySourceAuditManifest(noQuestions)).toThrow();
  });

  it("hydrates exact pinned line ranges and verifies the declared source digest", async () => {
    const checkout = await temporaryRepository();
    const provisional = repositoryAt(checkout.commitSha);
    const computed = await computeRepositorySourceAuditSourceDigest({
      repository: provisional,
      repositoryRoot: checkout.root,
    });
    const audited = repositoryAt(checkout.commitSha, computed.sourceDigest);
    const parsed = manifest(audited);
    const hydrated = await hydrateRepositorySourceAuditManifest({
      manifest: parsed,
      repositoryRoots: new Map([[audited.fixtureId, checkout.root]]),
    });

    expect(hydrated.repositories[0]!.knowledgeUnits[0]!.anchors[0]).toMatchObject({
      path: "example.ts",
      lineStart: 2,
      lineEnd: 3,
      content: "export const second = 2;\nexport const third = 3;",
      contentDigest: createHash("sha256")
        .update("export const second = 2;\nexport const third = 3;")
        .digest("hex"),
    });
    expect(hydrated.manifestDigest).toBe(
      repositorySourceAuditManifestDigest(parsed),
    );
    expect(hydrated.repositories[0]!.sourceDigest).toBe(computed.sourceDigest);
  });

  it("fails closed on source digest drift, out-of-bounds ranges, and tracked checkout changes", async () => {
    const checkout = await temporaryRepository();
    const provisional = repositoryAt(checkout.commitSha);
    const computed = await computeRepositorySourceAuditSourceDigest({
      repository: provisional,
      repositoryRoot: checkout.root,
    });

    await expect(hydrateRepositorySourceAuditManifest({
      manifest: manifest(repositoryAt(checkout.commitSha, "f".repeat(64))),
      repositoryRoots: new Map([[provisional.fixtureId, checkout.root]]),
    })).rejects.toThrow(/Source digest mismatch/u);

    const invalidRange = repositoryAt(checkout.commitSha, computed.sourceDigest);
    invalidRange.knowledgeUnits[0]!.anchors[0]!.lineEnd = 99;
    await expect(computeRepositorySourceAuditSourceDigest({
      repository: invalidRange,
      repositoryRoot: checkout.root,
    })).rejects.toThrow(/exceeds the/u);

    await writeFile(join(checkout.root, "example.ts"), "changed\n");
    await expect(computeRepositorySourceAuditSourceDigest({
      repository: provisional,
      repositoryRoot: checkout.root,
    })).rejects.toThrow(/tracked working-tree changes/u);
  });
});

describe("source-audit adjudication aggregation", () => {
  const repository = {
    fixtureId: "aggregation",
    repository: "example/aggregation",
    commitSha: "a".repeat(40),
    sourceScope: "tracked_git_tree" as const,
    sourceDigest: "b".repeat(64),
    knowledgeUnits: [
      {
        id: "major",
        claim: "Major workflow.",
        state: "implemented" as const,
        importance: "major" as const,
        highlightRelevance: "must" as const,
        domain: "core",
        kind: "workflow" as const,
        anchors: [{ path: "core.ts", lineStart: 1, lineEnd: 2 }],
        uncertainty: "It emits a draft, not a completed artifact.",
      },
      {
        id: "supporting",
        claim: "Supporting workflow.",
        state: "implemented" as const,
        importance: "supporting" as const,
        highlightRelevance: "should" as const,
        domain: "support",
        kind: "capability" as const,
        anchors: [{ path: "support.ts", lineStart: 1, lineEnd: 1 }],
      },
      {
        id: "absent",
        claim: "Processes payments.",
        state: "absent" as const,
        importance: "major" as const,
        highlightRelevance: "not_expected" as const,
        domain: "payments",
        kind: "constraint" as const,
        anchors: [{ path: "core.ts", lineStart: 3, lineEnd: 3 }],
      },
      {
        id: "planned",
        claim: "Adds a planned export.",
        state: "planned" as const,
        importance: "supporting" as const,
        highlightRelevance: "not_expected" as const,
        domain: "exports",
        kind: "constraint" as const,
        anchors: [{ path: "roadmap.md", lineStart: 1, lineEnd: 1 }],
        uncertainty: "It has no reachable implementation.",
      },
    ],
    userQuestions: [],
  } satisfies RepositorySourceAuditRepository;

  const adjudications = [
    {
      unitId: "major",
      knowledgeCoverage: "full" as const,
      highlightCoverage: "full" as const,
      evidenceSupported: true,
      stateCorrect: true,
      qualifierCoverage: "partial" as const,
      contradictsAudit: false,
    },
    {
      unitId: "supporting",
      knowledgeCoverage: "partial" as const,
      highlightCoverage: "none" as const,
      evidenceSupported: true,
      stateCorrect: true,
      qualifierCoverage: null,
      contradictsAudit: false,
    },
    {
      unitId: "absent",
      knowledgeCoverage: "none" as const,
      highlightCoverage: "none" as const,
      evidenceSupported: false,
      stateCorrect: false,
      qualifierCoverage: null,
      contradictsAudit: true,
    },
    {
      unitId: "planned",
      knowledgeCoverage: "none" as const,
      highlightCoverage: "none" as const,
      evidenceSupported: false,
      stateCorrect: true,
      qualifierCoverage: "full" as const,
      contradictsAudit: false,
    },
  ];

  it("computes weighted coverage, grounding, qualifier, and constraint metrics", () => {
    expect(aggregateRepositorySourceAuditAdjudications({
      repository,
      adjudications,
    })).toEqual({
      weightedKnowledgeRecall: 0.833333,
      majorKnowledgeRecall: 1,
      supportingKnowledgeRecall: 0.5,
      mustHighlightRecall: 1,
      weightedHighlightRecall: 0.666667,
      matchedUnitGrounding: 1,
      stateCorrectness: 0.666667,
      qualifierPreservation: 0.75,
      constraintRecall: 0,
      constraintCorrectness: 0,
      contradictionRate: 0.25,
      fullMajorUnitIds: ["major"],
      missedMajorUnitIds: [],
    });
  });

  it("preserves the quarter-step semantic fidelity scale used by the source-audited baseline", () => {
    expect(aggregateRepositorySourceAuditAdjudications({
      repository,
      adjudications: adjudications.map((adjudication) => {
        if (adjudication.unitId === "major") {
          return {
            ...adjudication,
            knowledgeCoverage: "substantial" as const,
            highlightCoverage: "tangential" as const,
          };
        }
        return adjudication;
      }),
    })).toMatchObject({
      weightedKnowledgeRecall: 0.666667,
      majorKnowledgeRecall: 0.75,
      mustHighlightRecall: 0.25,
      weightedHighlightRecall: 0.166667,
    });
  });

  it("does not credit silence as correct constraint coverage", () => {
    expect(aggregateRepositorySourceAuditAdjudications({
      repository,
      adjudications: adjudications.map((adjudication) =>
        adjudication.unitId === "planned"
          ? {
              ...adjudication,
              knowledgeCoverage: "tangential" as const,
              evidenceSupported: true,
            }
          : adjudication
      ),
    })).toMatchObject({
      stateCorrectness: 0.75,
      constraintRecall: 0.125,
      constraintCorrectness: 0.5,
    });
  });

  it("scores grounded question answerability and non-duplicate Highlight salience", () => {
    const repositoryWithQuestions = {
      ...repository,
      userQuestions: [
        "What does the major workflow do?",
        "Does it process payments?",
        "How does the planned export run?",
      ],
    };
    expect(aggregateRepositorySourceAuditOutcome({
      repository: repositoryWithQuestions,
      unitAdjudications: adjudications.map((adjudication) =>
        adjudication.unitId === "absent"
          ? {
              ...adjudication,
              knowledgeCoverage: "tangential" as const,
              evidenceSupported: true,
              stateCorrect: true,
              contradictsAudit: false,
            }
          : adjudication
      ),
      observedHighlightIds: ["major-highlight", "support-highlight", "duplicate"],
      highlightAdjudications: [
        {
          highlightId: "major-highlight",
          matchedUnitIds: ["major"],
          salience: "major_operation",
          semanticDuplicateOf: null,
        },
        {
          highlightId: "support-highlight",
          matchedUnitIds: ["supporting"],
          salience: "supporting_insight",
          semanticDuplicateOf: null,
        },
        {
          highlightId: "duplicate",
          matchedUnitIds: ["major"],
          salience: "major_operation",
          semanticDuplicateOf: "major-highlight",
        },
      ],
      questionAdjudications: [
        {
          question: "What does the major workflow do?",
          answerability: "full",
          supportingUnitIds: ["major"],
          evidenceSupported: true,
          stateCorrect: true,
          contradictsAudit: false,
        },
        {
          question: "Does it process payments?",
          answerability: "substantial",
          supportingUnitIds: ["absent"],
          evidenceSupported: true,
          stateCorrect: true,
          contradictsAudit: false,
        },
        {
          question: "How does the planned export run?",
          answerability: "partial",
          supportingUnitIds: ["planned"],
          evidenceSupported: false,
          stateCorrect: true,
          contradictsAudit: false,
        },
      ],
    })).toMatchObject({
      questionAnswerability: 0.583333,
      fullyAnswerableQuestionRate: 0.333333,
      highlightSalience: 0.5,
      majorHighlightAllocationRate: 0.333333,
      duplicateHighlightRate: 0.333333,
    });
  });

  it("requires complete output adjudication without unknown units or duplicate targets", () => {
    const input = {
      repository,
      unitAdjudications: adjudications,
      observedHighlightIds: ["saved-highlight"],
      highlightAdjudications: [{
        highlightId: "saved-highlight",
        matchedUnitIds: ["major"],
        salience: "major_operation" as const,
        semanticDuplicateOf: null,
      }],
      questionAdjudications: [],
    };
    expect(() => aggregateRepositorySourceAuditOutcome({
      ...input,
      observedHighlightIds: ["saved-highlight", "ungraded-highlight"],
    })).toThrow(/Missing Highlight adjudications: ungraded-highlight/u);
    expect(() => aggregateRepositorySourceAuditOutcome({
      ...input,
      highlightAdjudications: [{
        ...input.highlightAdjudications[0]!,
        matchedUnitIds: ["unknown"],
      }],
    })).toThrow(/unknown source-audit units: unknown/u);
    expect(() => aggregateRepositorySourceAuditOutcome({
      ...input,
      highlightAdjudications: [{
        ...input.highlightAdjudications[0]!,
        semanticDuplicateOf: "saved-highlight",
      }],
    })).toThrow(/invalid semantic duplicate target/u);

    expect(() => aggregateRepositorySourceAuditOutcome({
      ...input,
      repository: {
        ...repository,
        userQuestions: ["Does the planned export exist?"],
      },
      questionAdjudications: [{
        question: "Does the planned export exist?",
        answerability: "full",
        supportingUnitIds: ["planned"],
        evidenceSupported: true,
        stateCorrect: true,
        contradictsAudit: false,
      }],
    })).toThrow(/no supporting unit represented in saved knowledge/u);
  });

  it("requires one adjudication for every known unit", () => {
    expect(() => aggregateRepositorySourceAuditAdjudications({
      repository,
      adjudications: adjudications.slice(1),
    })).toThrow(/Missing source-audit adjudications: major/u);
    expect(() => aggregateRepositorySourceAuditAdjudications({
      repository,
      adjudications: [...adjudications, adjudications[0]!],
    })).toThrow(/Duplicate source-audit unit adjudication: major/u);
    expect(() => aggregateRepositorySourceAuditAdjudications({
      repository,
      adjudications: [{ ...adjudications[0]!, unitId: "unknown" }],
    })).toThrow(/Unknown source-audit unit adjudication: unknown/u);
    expect(() => aggregateRepositorySourceAuditAdjudications({
      repository,
      adjudications: adjudications.map((adjudication) =>
        adjudication.unitId === "major"
          ? { ...adjudication, qualifierCoverage: null }
          : adjudication
      ),
    })).toThrow(/Missing qualifier adjudication/u);
  });
});
