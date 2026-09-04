import { z } from "zod";
import {
  REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION,
  type RepositoryKnowledgeEvaluationRun,
} from "@/src/evals/repository-knowledge-quality";

const nullableNonnegativeNumber = z.number().finite().nonnegative().nullable();
const nullableCoverage = z.number().finite().min(0).max(1).nullable();

const repositoryKnowledgeEvaluationRunSchema = z.object({
  schemaVersion: z.literal(REPOSITORY_KNOWLEDGE_EVALUATION_SCHEMA_VERSION),
  fixtureId: z.string().trim().min(1).max(200),
  repository: z.string().trim().min(1).max(300).nullable(),
  commitSha: z.string().trim().min(1).max(100).nullable().optional(),
  items: z.array(z.object({
    id: z.string().trim().min(1).max(300),
    kind: z.enum(["highlight", "fact"]),
    text: z.string().trim().min(1).max(5_000),
    summary: z.string().max(10_000).nullable().optional(),
    claimState: z.enum([
      "implemented",
      "partial",
      "planned",
      "bounded_absence",
      "unknown",
    ]).optional(),
    domain: z.string().max(300).nullable().optional(),
    evidence: z.array(z.object({
      path: z.string().trim().min(1).max(2_000),
      lineStart: z.number().int().positive().nullable().optional(),
      lineEnd: z.number().int().positive().nullable().optional(),
      quote: z.string().max(20_000).nullable().optional(),
    }).strict()).max(50),
  }).strict()).max(500),
  domains: z.array(z.object({
    key: z.string().max(300).nullable().optional(),
    label: z.string().trim().min(1).max(300),
  }).strict()).max(300).optional(),
  discoveredCapabilities: z.array(z.object({
    key: z.string().max(300).nullable().optional(),
    label: z.string().trim().min(1).max(500),
    evidencePaths: z.array(z.string().trim().min(1).max(2_000)).max(500),
  }).strict()).max(500).optional(),
  inventory: z.object({
    scannableFiles: z.number().int().nonnegative(),
    analyzedFiles: z.number().int().nonnegative(),
    semanticCoverageBasis: z.enum([
      "legacy_semantic_universe",
      "agentic_snapshot_read_set",
    ]).optional(),
    semanticEligibleFiles: z.number().int().nonnegative().nullable().optional(),
    semanticInspectedFiles: z.number().int().nonnegative().optional(),
    semanticVerifierInspectedFiles: z.number().int().nonnegative().optional(),
    semanticAnalyzedFiles: z.number().int().nonnegative(),
    semanticCitedFiles: z.number().int().nonnegative().optional(),
    analyzedPaths: z.array(z.string().trim().min(1).max(2_000)).max(100_000).optional(),
    semanticInspectedPaths: z.array(z.string().trim().min(1).max(2_000)).max(100_000).optional(),
    semanticVerifierInspectedPaths: z.array(z.string().trim().min(1).max(2_000)).max(100_000).optional(),
    semanticAnalyzedPaths: z.array(z.string().trim().min(1).max(2_000)).max(100_000).optional(),
    semanticCitedPaths: z.array(z.string().trim().min(1).max(2_000)).max(100_000).optional(),
  }).strict().superRefine((inventory, context) => {
    if (inventory.semanticCoverageBasis !== "agentic_snapshot_read_set") return;
    const required = [
      ["semanticInspectedFiles", inventory.semanticInspectedFiles],
      ["semanticVerifierInspectedFiles", inventory.semanticVerifierInspectedFiles],
      ["semanticCitedFiles", inventory.semanticCitedFiles],
      ["semanticInspectedPaths", inventory.semanticInspectedPaths],
      ["semanticVerifierInspectedPaths", inventory.semanticVerifierInspectedPaths],
      ["semanticCitedPaths", inventory.semanticCitedPaths],
    ] as const;
    for (const [key, value] of required) {
      if (value === undefined) {
        context.addIssue({
          code: "custom",
          message: `Agentic observations must report ${key}.`,
          path: [key],
        });
      }
    }
    const unique = (paths: readonly string[] | undefined) => new Set(paths ?? []);
    const inspected = unique(inventory.semanticInspectedPaths);
    const analyzed = unique(inventory.semanticAnalyzedPaths);
    const verifierInspected = unique(inventory.semanticVerifierInspectedPaths);
    const cited = unique(inventory.semanticCitedPaths);
    if (
      inventory.semanticInspectedPaths &&
      inspected.size !== inventory.semanticInspectedPaths.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Agentic inspected paths must be unique.",
        path: ["semanticInspectedPaths"],
      });
    }
    if (
      inventory.semanticCitedPaths &&
      cited.size !== inventory.semanticCitedPaths.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Agentic cited paths must be unique.",
        path: ["semanticCitedPaths"],
      });
    }
    if (
      inventory.semanticVerifierInspectedPaths &&
      verifierInspected.size !== inventory.semanticVerifierInspectedPaths.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Agentic verifier-inspected paths must be unique.",
        path: ["semanticVerifierInspectedPaths"],
      });
    }
    if (inventory.semanticInspectedFiles !== undefined &&
        inventory.semanticInspectedFiles !== inspected.size) {
      context.addIssue({
        code: "custom",
        message: "Agentic inspected file count must match its exact path set.",
        path: ["semanticInspectedFiles"],
      });
    }
    if (inventory.semanticAnalyzedFiles !== analyzed.size) {
      context.addIssue({
        code: "custom",
        message: "Agentic analyzed file count must match its exact path set.",
        path: ["semanticAnalyzedFiles"],
      });
    }
    if (inventory.semanticVerifierInspectedFiles !== undefined &&
        inventory.semanticVerifierInspectedFiles !== verifierInspected.size) {
      context.addIssue({
        code: "custom",
        message: "Agentic verifier-inspected file count must match its exact path set.",
        path: ["semanticVerifierInspectedFiles"],
      });
    }
    if (inventory.semanticCitedFiles !== undefined &&
        inventory.semanticCitedFiles !== cited.size) {
      context.addIssue({
        code: "custom",
        message: "Agentic cited file count must match its exact path set.",
        path: ["semanticCitedFiles"],
      });
    }
    if ([...analyzed].some((path) => !inspected.has(path))) {
      context.addIssue({
        code: "custom",
        message: "Agentic analyzed paths must be a subset of inspected paths.",
        path: ["semanticAnalyzedPaths"],
      });
    }
    if ([...cited].some((path) => !analyzed.has(path))) {
      context.addIssue({
        code: "custom",
        message: "Agentic cited paths must be a subset of analyzed paths.",
        path: ["semanticCitedPaths"],
      });
    }
  }),
  coverage: z.object({
    static: nullableCoverage,
    semantic: nullableCoverage,
    knowledge: nullableCoverage,
  }).strict(),
  performance: z.object({
    durationMs: nullableNonnegativeNumber,
    modelCalls: nullableNonnegativeNumber,
    totalTokens: nullableNonnegativeNumber,
    estimatedCostUsd: nullableNonnegativeNumber,
  }).strict(),
  executionIntegrity: z.object({
    passed: z.boolean(),
    issues: z.array(z.string().trim().min(1).max(2_000)).max(100),
    modelIdentities: z.array(z.string().trim().min(1).max(500)).max(100),
    policyVersions: z.array(z.string().trim().min(1).max(500)).max(100),
  }).strict().optional(),
}).strict();

export function parseRepositoryKnowledgeEvaluationRun(
  input: unknown,
): RepositoryKnowledgeEvaluationRun {
  const parsed = repositoryKnowledgeEvaluationRunSchema.parse(input);
  return {
    ...parsed,
    executionIntegrity: {
      passed: false,
      issues: [
        "Serialized observations are self-attested and cannot certify production execution integrity; use the database adapter.",
      ],
      modelIdentities: [],
      policyVersions: [],
    },
  };
}

export function parseRepositoryKnowledgeEvaluationRuns(input: unknown) {
  if (Array.isArray(input)) {
    return input.map(parseRepositoryKnowledgeEvaluationRun);
  }
  if (
    input && typeof input === "object" &&
    ("runs" in input || "observations" in input)
  ) {
    const value = input as { runs?: unknown; observations?: unknown };
    const runs = value.runs ?? value.observations;
    if (!Array.isArray(runs)) {
      throw new Error("Serialized repository knowledge observations must contain a runs array.");
    }
    return runs.map(parseRepositoryKnowledgeEvaluationRun);
  }
  return [parseRepositoryKnowledgeEvaluationRun(input)];
}
