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
    claimState: z.enum(["implemented", "planned", "unknown"]).optional(),
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
    semanticEligibleFiles: z.number().int().nonnegative().nullable().optional(),
    semanticAnalyzedFiles: z.number().int().nonnegative(),
    analyzedPaths: z.array(z.string().trim().min(1).max(2_000)).max(100_000).optional(),
    semanticAnalyzedPaths: z.array(z.string().trim().min(1).max(2_000)).max(100_000).optional(),
  }).strict(),
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
  return repositoryKnowledgeEvaluationRunSchema.parse(input);
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
