import { Prisma } from "@/src/generated/prisma/client";
import { z } from "zod";
import type {
  ProjectFactCategory,
  ProjectFactDraft,
  ProjectKnowledgeCitation,
} from "@/src/domain/project-chat";
import type { JsonSchemaObject, StructuredOutputTransportMode } from "@/src/lib/llm-json-schemas";
import {
  createStructuredGenerationBudget,
  StructuredGenerationBudgetError,
  StructuredOutputError,
} from "@/src/lib/bedrock-structured-llm-client";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import {
  buildProjectFactEmbeddingText,
  upsertProjectFactEmbedding,
} from "@/src/services/knowledge-embedding-service";
import { promoteRepositoryCitations } from "@/src/services/repository-evidence-promotion-service";
import { recordChange } from "@/src/services/knowledge-reconciliation-service";

const categorySchema = z.enum([
  "architecture",
  "behavior",
  "data_flow",
  "code_location",
  "dependency",
  "configuration",
]);
const factExtractionSchema = z.object({
  facts: z.array(z.object({
    statement: z.string().trim().min(10).max(500),
    category: categorySchema,
    confidence: z.enum(["low", "medium", "high"]),
    sensitivityFlag: z.boolean(),
    reviewNotes: z.string().trim().max(1_000).nullable(),
    citationIndexes: z.array(z.number().int().min(1)).min(1).max(4),
  })).max(8),
  coverageGaps: z.array(z.string().trim().min(2).max(500)).max(6),
});

const factExtractionJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["facts", "coverageGaps"],
  properties: {
    facts: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "statement",
          "category",
          "confidence",
          "sensitivityFlag",
          "reviewNotes",
          "citationIndexes",
        ],
        properties: {
          statement: { type: "string", minLength: 10, maxLength: 500 },
          category: { type: "string", enum: categorySchema.options },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          sensitivityFlag: { type: "boolean" },
          reviewNotes: { anyOf: [{ type: "string", maxLength: 1_000 }, { type: "null" }] },
          citationIndexes: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    coverageGaps: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 2, maxLength: 500 },
    },
  },
};

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function tokens(value: string) {
  return new Set(
    normalizeWhitespace(value.toLowerCase())
      .split(/[^a-z0-9_./-]+/)
      .filter((token) => token.length > 2),
  );
}

function similarity(left: string, right: string) {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

const deterministicFactStopWords = new Set([
  "about", "and", "are", "attached", "code", "does", "enforced", "file", "from",
  "how", "implementation", "inspect", "into", "its", "project", "repository", "that",
  "the", "this", "what", "where", "which", "with", "work", "works",
]);

const controlFlowQuestionPattern = /\b(?:retry|retries|backoff|attempts?|loops?|iterations?|terminat(?:e|es|ed|ing|ion)?|break|exit|stop reason|timeout|limits?|budget)\b/i;
const boundQuestionPattern = /\b(?:bounded?|limits?|maximum|max(?:imum)? attempts?|iterations?|budget)\b/i;
const exitQuestionPattern = /\b(?:terminat(?:e|es|ed|ing|ion)?|break|exit|stop reason|when does|what stops)\b/i;
const boundIdentifierPattern = /\b(?:max[A-Z][A-Za-z0-9_$]*|[A-Za-z_$][\w$]*(?:Limit|Budget|Attempts|Iterations|Retries)|MAX_[A-Z0-9_]*(?:LIMIT|BUDGET|ATTEMPTS|ITERATIONS|RETRIES)[A-Z0-9_]*)\b/g;
const MAX_FACT_EXTRACTION_EXCERPT_CHARS = 2_800;

export function compactProjectFactExtractionExcerpt(value: string, question: string) {
  if (value.length <= MAX_FACT_EXTRACTION_EXCERPT_CHARS) return value;
  const lower = value.toLowerCase();
  const focusTerms = Array.from(new Set([
    ...Array.from(tokens(question)).filter((term) => !deterministicFactStopWords.has(term)),
    ...(controlFlowQuestionPattern.test(question)
      ? ["maxiterations", "stopreason", "retry", "backoff", "while", "throw", "return", "break"]
      : []),
  ])).sort((left, right) => right.length - left.length);
  const focusIndex = focusTerms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const halfWindow = Math.floor((MAX_FACT_EXTRACTION_EXCERPT_CHARS - 120) / 2);
  const start = Math.max(0, Math.min(
    value.length - MAX_FACT_EXTRACTION_EXCERPT_CHARS,
    focusIndex - halfWindow,
  ));
  const end = Math.min(value.length, start + MAX_FACT_EXTRACTION_EXCERPT_CHARS);
  return [
    start > 0 ? "[earlier excerpt text omitted]" : "",
    value.slice(start, end),
    end < value.length ? "[later excerpt text omitted]" : "",
  ].filter(Boolean).join("\n");
}

function citationLine(citation: ProjectKnowledgeCitation, excerpt: string, matchIndex: number) {
  if (!citation.startLine) return null;
  return citation.startLine + excerpt.slice(0, matchIndex).split("\n").length - 1;
}

function compactCode(value: string) {
  return normalizeWhitespace(value).replace(/`/g, "'").slice(0, 180);
}

function uniqueMatches(value: string, pattern: RegExp) {
  return Array.from(value.matchAll(pattern))
    .map((match) => match[0])
    .filter((entry, index, all) => all.indexOf(entry) === index);
}

function relevantControlBounds(condition: string, question: string) {
  const identifiers = uniqueMatches(condition, new RegExp(boundIdentifierPattern.source, "g"));
  return identifiers.filter((identifier) => {
    if (/(?:attempt|iteration|retr|loop|turn|step|tool.?call)/i.test(identifier)) return true;
    if (/\b(?:timeout|deadline|time limit)\b/i.test(question) && /(?:time|deadline)/i.test(identifier)) return true;
    if (/\b(?:token|budget)\b/i.test(question) && /(?:token|budget)/i.test(identifier)) return true;
    return false;
  });
}

export function deterministicFactRecoveryFromCitations(input: {
  question: string;
  citations: readonly ProjectKnowledgeCitation[];
  maxFacts: number;
}): { facts: ProjectFactDraft[]; coverageGaps: string[] } {
  const questionTerms = Array.from(tokens(input.question)).filter((term) =>
    !deterministicFactStopWords.has(term)
  );
  const asksAboutControlFlow = controlFlowQuestionPattern.test(input.question);
  const asksAboutBounds = boundQuestionPattern.test(input.question);
  const asksAboutExit = exitQuestionPattern.test(input.question);
  const asksAboutRetry = /\b(?:retry|retries|backoff)\b/i.test(input.question);
  const facts: ProjectFactDraft[] = [];
  let foundExplicitBound = false;
  let foundExplicitExit = false;
  let foundExplicitRetry = false;

  const addFact = (fact: ProjectFactDraft) => {
    if (facts.length >= input.maxFacts || facts.some((existing) => existing.statement === fact.statement)) return;
    facts.push(fact);
  };

  for (const [index, citation] of input.citations.entries()) {
    if (facts.length >= input.maxFacts || citation.kind !== "github_file" || !citation.path) continue;
    const excerpt = citation.excerpt ?? "";
    const lineLabel = citation.startLine && citation.endLine
      ? `lines ${citation.startLine}-${citation.endLine}`
      : "the cited excerpt";

    if (asksAboutControlFlow) {
      const loopMatches = [
        ...Array.from(excerpt.matchAll(/\bwhile\s*\(([^)\n]{1,180})\)/g)).map((match) => ({
          match,
          condition: match[1] ?? "",
          kind: "while" as const,
        })),
        ...Array.from(excerpt.matchAll(/\bfor\s*\([^;\n]*;([^;\n]{1,180});[^)\n]*\)/g)).map((match) => ({
          match,
          condition: match[1] ?? "",
          kind: "for" as const,
        })),
      ];
      for (const { match, condition, kind } of loopMatches) {
        const identifiers = relevantControlBounds(condition, input.question);
        if (!identifiers.length) continue;
        if (/\b(?:retry|retries|backoff)\b/i.test(condition)) foundExplicitRetry = true;
        foundExplicitBound = true;
        const line = citationLine(citation, excerpt, match.index ?? 0);
        addFact({
          statement: `${citation.path} uses the explicit ${kind}-loop condition \`${compactCode(condition)}\`${line ? ` at line ${line}` : ` in ${lineLabel}`}; the condition directly references ${identifiers.map((identifier) => `\`${identifier}\``).join(", ")}.`.slice(0, 500),
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          reviewNotes: "Deterministic recovery preserved only the loop condition visible in the immutable excerpt; it did not infer runtime behavior beyond that condition.",
          citationIndexes: [index + 1],
        });
      }

      for (const match of excerpt.matchAll(/\bif\s*\(([^)\n]{1,180})\)\s*\{?/g)) {
        const condition = match[1] ?? "";
        const following = excerpt.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 120);
        const exitKeyword = /^[\t \n]*(break\b|return\b|throw\b)/.exec(following)?.[1] ?? "";
        const exitStatement = exitKeyword === "break" ? "break;" : exitKeyword;
        if (!condition || !exitStatement) continue;
        const boundIdentifiers = relevantControlBounds(condition, input.question);
        const conditionSupportsRequestedControlFlow = boundIdentifiers.length > 0 ||
          /\b(?:stopReason|retry|retries|attempts?|iterations?|timeout|backoff|budget)\b/i.test(condition);
        if (!conditionSupportsRequestedControlFlow) continue;
        if (/\b(?:retry|retries|backoff)\b/i.test(condition)) foundExplicitRetry = true;
        if (boundIdentifiers.length) foundExplicitBound = true;
        foundExplicitExit = true;
        const line = citationLine(citation, excerpt, match.index ?? 0);
        addFact({
          statement: `${citation.path} contains the explicit conditional exit \`${exitStatement}\` under \`${compactCode(condition)}\`${line ? ` at line ${line}` : ` in ${lineLabel}`}.`.slice(0, 500),
          category: "behavior",
          confidence: "high",
          sensitivityFlag: false,
          reviewNotes: "Deterministic recovery preserved the condition and immediately associated exit statement from the immutable excerpt.",
          citationIndexes: [index + 1],
        });
      }
    }

    const declarations = Array.from(excerpt.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g));
    const pathLower = citation.path.toLowerCase();
    for (const declaration of declarations) {
      const symbol = declaration[1]!;
      const symbolLower = symbol.toLowerCase();
      const relevant = questionTerms.some((term) =>
        symbolLower.includes(term) || pathLower.includes(term)
      );
      if (!relevant) continue;
      if (/\b(?:retry|retries|backoff)\b/i.test(symbol)) foundExplicitRetry = true;
      const line = citationLine(citation, excerpt, declaration.index ?? 0);
      addFact({
        statement: `${citation.path} defines \`${symbol}\`${line ? ` at line ${line}` : ` in ${lineLabel}`} in the inspected repository revision.`,
        category: "code_location",
        confidence: "high",
        sensitivityFlag: false,
        reviewNotes: "Deterministic recovery records only the symbol declaration visible in the immutable repository excerpt.",
        citationIndexes: [index + 1],
      });
    }
  }

  const coverageGaps: string[] = [];
  if (asksAboutBounds && !foundExplicitBound) {
    coverageGaps.push("The inspected excerpts did not show a loop condition that directly referenced a bound identifier, so no retry or iteration-bound claim was inferred.");
  }
  if (asksAboutExit && !foundExplicitExit) {
    coverageGaps.push("The inspected excerpts did not show an explicit conditional break, return, or throw, so no loop-termination path was inferred.");
  }
  if (asksAboutRetry && !foundExplicitRetry) {
    coverageGaps.push("The inspected excerpts did not establish a retry or backoff policy; an iteration guard must not be reported as a retry count.");
  }
  return { facts, coverageGaps };
}

export function deterministicFactsFromCitations(input: {
  question: string;
  citations: readonly ProjectKnowledgeCitation[];
  maxFacts: number;
}): ProjectFactDraft[] {
  return deterministicFactRecoveryFromCitations(input).facts;
}

async function extractFacts(input: {
  question: string;
  workItemTitle: string;
  citations: readonly ProjectKnowledgeCitation[];
  partial: boolean;
  maxFacts: number;
}) {
  const exactRecovery = deterministicFactRecoveryFromCitations(input);
  const exactBoundedControlFlow = controlFlowQuestionPattern.test(input.question) &&
    (boundQuestionPattern.test(input.question) || exitQuestionPattern.test(input.question)) &&
    exactRecovery.facts.length > 0;
  if (resolveWorkbaseLlmProvider() === "mock" || exactBoundedControlFlow) {
    return {
      ...exactRecovery,
      tokenUsage: null,
    };
  }

  const result = await getBedrockStructuredLlmClient().generateStructured({
    systemPrompt: [
      "You extract reviewable technical project facts from immutable repository excerpts.",
      "Each fact must be directly supported by its cited excerpts and must not claim user ownership or production impact.",
      "Prefer reusable architecture, behavior, data-flow, code-location, dependency, or configuration facts.",
      "Return no fact when the excerpt does not support a useful statement.",
    ].join(" "),
    userPrompt: JSON.stringify({
      project: input.workItemTitle,
      question: input.question,
      partialResearch: input.partial,
      maximumFacts: input.maxFacts,
      excerpts: input.citations.map((citation, index) => ({
        citationIndex: index + 1,
        repository: citation.repository,
        commitSha: citation.commitSha,
        path: citation.path,
        lines: citation.startLine && citation.endLine
          ? `${citation.startLine}-${citation.endLine}`
          : null,
        // The research notebook keeps the full immutable excerpt. Extraction
        // receives only a question-focused window so it does not pay to replay
        // five large snippets that were already narrowed during file research.
        excerpt: compactProjectFactExtractionExcerpt(citation.excerpt ?? "", input.question),
      })),
    }),
    schema: factExtractionSchema,
    schemaName: "project_fact_candidates",
    schemaDescription: "Grounded technical project facts and remaining coverage gaps.",
    jsonSchema: factExtractionJsonSchema,
    maxTokens: 4_000,
    temperature: 0,
    effort: "medium",
    transportPreference: ["bedrock_json_schema"] as StructuredOutputTransportMode[],
    budget: createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 32_000,
    }),
  });
  const facts = controlFlowQuestionPattern.test(input.question)
    ? [...exactRecovery.facts, ...result.data.facts]
        .filter((fact, index, all) => all.findIndex((candidate) => candidate.statement === fact.statement) === index)
        .slice(0, input.maxFacts)
    : result.data.facts;
  return {
    ...result.data,
    facts,
    coverageGaps: Array.from(new Set([
      ...result.data.coverageGaps,
      ...exactRecovery.coverageGaps,
    ])),
    tokenUsage: result.tokenUsage,
  };
}

function failedExtractionAttemptUsage(error: unknown, phase: string) {
  const usage = error instanceof StructuredOutputError ? error.tokenUsage : null;
  return {
    phase,
    usage,
    status: error instanceof StructuredOutputError
      ? error.status
      : error instanceof StructuredGenerationBudgetError
        ? error.code
        : "failed",
    // Budget admission failures happen before a provider request. Every other
    // failure without usage is conservatively treated as a charged attempt so
    // performance reports cannot present an unknown call as $0.
    unknownUsageAttempts: usage || error instanceof StructuredGenerationBudgetError ? 0 : 1,
  };
}

export async function extractFactsWithRecovery(input: Parameters<typeof extractFacts>[0]) {
  try {
    return await extractFacts(input);
  } catch (error) {
    const recoveryMode = process.env.WORKBASE_PROJECT_FACT_RECOVERY_MODE ?? "deterministic_notebook";
    if (recoveryMode !== "batched_model_retry") {
      const recovered = deterministicFactRecoveryFromCitations(input);
      if (!recovered.facts.length) throw error;
      return {
        facts: recovered.facts,
        coverageGaps: [
          "Semantic Project Fact extraction did not complete; Workbase preserved only exact code-location facts recoverable from the saved repository notebook.",
          ...recovered.coverageGaps,
        ],
        tokenUsage: [{
          ...failedExtractionAttemptUsage(error, "full_extraction"),
          fallback: "deterministic_notebook",
        }],
      };
    }
    if (!(error instanceof StructuredOutputError) || error.status === "provider_error") {
      const recovered = deterministicFactRecoveryFromCitations(input);
      if (!recovered.facts.length) throw error;
      return {
        facts: recovered.facts,
        coverageGaps: [
          "Model retry was unavailable; exact code-location facts were recovered from the saved repository notebook.",
          ...recovered.coverageGaps,
        ],
        tokenUsage: [{
          ...failedExtractionAttemptUsage(error, "full_extraction"),
          fallback: "deterministic_notebook",
        }],
      };
    }

    const recoveredFacts: z.infer<typeof factExtractionSchema>["facts"] = [];
    const coverageGaps = [
      "The full fact-extraction response exceeded or failed its structured-output contract; Workbase retried smaller excerpt batches.",
    ];
    const recoveryUsage: unknown[] = [failedExtractionAttemptUsage(error, "full_extraction")];
    for (let offset = 0; offset < input.citations.length && recoveredFacts.length < input.maxFacts; offset += 4) {
      const citations = input.citations.slice(offset, offset + 4);
      try {
        const recovered = await extractFacts({
          ...input,
          citations,
          partial: true,
          maxFacts: input.maxFacts - recoveredFacts.length,
        });
        recoveredFacts.push(...recovered.facts.map((fact) => ({
          ...fact,
          reviewNotes: fact.reviewNotes ?? null,
          citationIndexes: fact.citationIndexes.map((index) => index + offset),
        })));
        coverageGaps.push(...recovered.coverageGaps);
        recoveryUsage.push({ phase: `batch_${Math.floor(offset / 4) + 1}`, usage: recovered.tokenUsage, status: "success" });
      } catch (batchError) {
        recoveryUsage.push(failedExtractionAttemptUsage(
          batchError,
          `batch_${Math.floor(offset / 4) + 1}`,
        ));
      }
    }
    if (!recoveredFacts.length) throw error;
    return {
      facts: recoveredFacts.slice(0, input.maxFacts),
      coverageGaps: Array.from(new Set(coverageGaps)),
      tokenUsage: recoveryUsage,
    };
  }
}

export async function createProjectFactCandidates(input: {
  runId: string;
  userId: string;
  workItemId: string;
  question: string;
  citations: readonly ProjectKnowledgeCitation[];
  partial: boolean;
  batchNumber?: number;
  maxFacts?: number;
}) {
  const existingCandidates = await prisma.agentRunCandidate.findMany({
    where: {
      agentRunId: input.runId,
      kind: { in: ["new_project_fact", "project_fact_revision"] },
    },
    select: { id: true, projectFactId: true, status: true },
  });
  if (existingCandidates.length) {
    return {
      candidateIds: existingCandidates.map((candidate) => candidate.id),
      activeProjectFactIds: existingCandidates.flatMap((candidate) =>
        candidate.status === "approved" && candidate.projectFactId ? [candidate.projectFactId] : [],
      ),
      coverageGaps: [],
      tokenUsage: null,
    };
  }

  const workItem = await prisma.workItem.findFirstOrThrow({
    where: { id: input.workItemId, userId: input.userId },
    select: { title: true },
  });
  const repositoryCitations = input.citations.filter((citation) => citation.kind === "github_file");
  if (!repositoryCitations.length) return { candidateIds: [], activeProjectFactIds: [], coverageGaps: [], tokenUsage: null };
  const extracted = await extractFactsWithRecovery({
    question: input.question,
    workItemTitle: workItem.title,
    citations: repositoryCitations,
    partial: input.partial,
    maxFacts: Math.min(8, Math.max(1, input.maxFacts ?? 4)),
  });
  const validFacts = extracted.facts.flatMap((fact) => {
    const citationIndexes = Array.from(new Set(fact.citationIndexes))
      .filter((index) => index >= 1 && index <= repositoryCitations.length);
    return citationIndexes.length ? [{ ...fact, citationIndexes }] : [];
  }).slice(0, Math.min(8, Math.max(1, input.maxFacts ?? 4)));
  if (!validFacts.length) {
    return { candidateIds: [], activeProjectFactIds: [], coverageGaps: extracted.coverageGaps, tokenUsage: extracted.tokenUsage };
  }

  const selectedOriginalIndexes = Array.from(
    new Set(validFacts.flatMap((fact) => fact.citationIndexes.map((index) => index - 1))),
  );
  const selectedCitations = selectedOriginalIndexes.map((index) => repositoryCitations[index]!);
  const promoted = await promoteRepositoryCitations({
    workItemId: input.workItemId,
    citations: selectedCitations,
    reviewScope: `project-fact-research:${input.runId}`,
  });
  const localIndexByOriginal = new Map(
    selectedOriginalIndexes.map((originalIndex, localIndex) => [originalIndex, localIndex]),
  );
  const existingFacts = await prisma.projectFact.findMany({
    where: { workItemId: input.workItemId, status: "approved" },
    include: { evidence: { include: { evidenceItem: { select: { metadata: true } } } } },
    orderBy: { updatedAt: "desc" },
  });
  const batchNumber = input.batchNumber ?? 1;
  const created: Array<{ candidateId: string; projectFactId: string; statement: string; category: ProjectFactCategory; reviewNotes: string | null; autoSafe: boolean }> = [];

  await prisma.$transaction(async (tx) => {
    for (const fact of validFacts) {
      const ranked = existingFacts
        .map((existing) => ({ existing, score: similarity(fact.statement, existing.statement) }))
        .sort((left, right) => right.score - left.score);
      const closest = ranked[0] ?? null;
      const citedShas = new Set(fact.citationIndexes.flatMap((oneBasedIndex) => {
        const citation = repositoryCitations[oneBasedIndex - 1];
        return citation?.commitSha ? [citation.commitSha] : [];
      }));
      const closestEvidenceShas = new Set(closest?.existing.evidence.flatMap((entry) => {
        const metadata = entry.evidenceItem.metadata;
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
        const commitSha = (metadata as Record<string, unknown>).commitSha;
        return typeof commitSha === "string" ? [commitSha] : [];
      }) ?? []);
      const alreadyGroundedAtRevision =
        (closest?.score ?? 0) >= 0.86 &&
        citedShas.size > 0 &&
        Array.from(citedShas).every((sha) => closestEvidenceShas.has(sha));
      if (alreadyGroundedAtRevision) continue;
      const supersedes = (closest?.score ?? 0) >= 0.86
        ? closest!.existing
        : ranked.find(
            (entry) => entry.existing.category === fact.category && entry.score >= 0.42,
          )?.existing ?? null;
      const evidenceIds = fact.citationIndexes.flatMap((oneBasedIndex) => {
        const localIndex = localIndexByOriginal.get(oneBasedIndex - 1);
        if (localIndex == null) return [];
        const evidenceId = promoted.evidenceIdByCitationIndex.get(localIndex);
        return evidenceId ? [evidenceId] : [];
      });
      if (!evidenceIds.length) continue;
      const autoSafe = !fact.sensitivityFlag && fact.confidence !== "low";
      const projectFact = await tx.projectFact.create({
        data: {
          workItemId: input.workItemId,
          statement: fact.statement,
          category: fact.category,
          confidence: fact.confidence,
          status: autoSafe ? "approved" : "draft",
          sensitivityFlag: fact.sensitivityFlag,
          reviewNotes: fact.reviewNotes,
          searchText: normalizeWhitespace([fact.statement, fact.category, fact.reviewNotes ?? ""].join(" ")),
          supersedesProjectFactId: supersedes?.id ?? null,
          lifecycleStatus: autoSafe ? "active" : "quarantined",
          reviewState: "pending_review",
          approvalSource: "automation",
          autoAppliedAt: autoSafe ? new Date() : null,
          validatedThroughSha: Array.from(citedShas)[0] ?? null,
          lastValidatedAt: new Date(),
          evidence: {
            create: evidenceIds.map((evidenceItemId) => ({ evidenceItemId })),
          },
        },
      });
      const candidate = await tx.agentRunCandidate.create({
        data: {
          agentRunId: input.runId,
          projectFactId: projectFact.id,
          kind: supersedes ? "project_fact_revision" : "new_project_fact",
          status: autoSafe ? "approved" : "pending",
          batchNumber,
          ordinal: created.length + 1,
          snapshot: toInputJson({
            statement: fact.statement,
            category: fact.category,
            confidence: fact.confidence,
            sensitivityFlag: fact.sensitivityFlag,
            reviewNotes: fact.reviewNotes,
            evidenceIds,
            evidenceLabels: evidenceIds.map((id) => id),
            partial: input.partial,
            supersedesProjectFactId: supersedes?.id ?? null,
          }),
          reviewedAt: autoSafe ? new Date() : null,
        },
      });
      if (autoSafe && supersedes) {
        await tx.projectFact.updateMany({
          where: { id: supersedes.id, status: "approved", lifecycleStatus: "active" },
          data: { status: "superseded", lifecycleStatus: "superseded" },
        });
      }
      if (autoSafe) {
        await tx.evidenceItem.updateMany({
          where: { id: { in: evidenceIds } },
          data: {
            included: true,
            lifecycleStatus: "active",
            reviewState: "pending_review",
            approvalSource: "automation",
            autoAppliedAt: new Date(),
          },
        });
      }
      created.push({
        candidateId: candidate.id,
        projectFactId: projectFact.id,
        statement: fact.statement,
        category: fact.category,
        reviewNotes: fact.reviewNotes ?? null,
        autoSafe,
      });
    }
  });

  await Promise.allSettled(created.map((entry) => upsertProjectFactEmbedding({
    projectFactId: entry.projectFactId,
    inputText: buildProjectFactEmbeddingText(entry),
  })));
  await Promise.allSettled(created.map((entry) => recordChange({
    workItemId: input.workItemId,
    entityKind: "project_fact",
    action: entry.autoSafe ? "created" : "quarantined",
    entityId: entry.projectFactId,
    afterSnapshot: { statement: entry.statement, category: entry.category, lifecycleStatus: entry.autoSafe ? "active" : "quarantined" },
    reason: entry.autoSafe
      ? "Repository research auto-applied a supported Project Fact for later review."
      : "Repository research quarantined a Project Fact that failed the automatic safety gate.",
    provenance: { agentRunId: input.runId },
    suffix: `${input.runId}:${entry.projectFactId}`,
  })));
  if (!created.length && promoted.newIds.length) {
    await prisma.evidenceItem.deleteMany({
      where: { id: { in: promoted.newIds }, type: "github_file_excerpt", included: false },
    });
  }

  return {
    candidateIds: created.map((entry) => entry.candidateId),
    activeProjectFactIds: created.filter((entry) => entry.autoSafe).map((entry) => entry.projectFactId),
    coverageGaps: extracted.coverageGaps,
    tokenUsage: extracted.tokenUsage,
  };
}
