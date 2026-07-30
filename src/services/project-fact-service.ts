import { Prisma } from "@/src/generated/prisma/client";
import { z } from "zod";
import type {
  ProjectFactCategory,
  ProjectFactDraft,
  ProjectKnowledgeCitation,
} from "@/src/domain/project-chat";
import { inferProjectSubsystemKey } from "@/src/domain/project-subsystems";
import type { JsonSchemaObject, StructuredOutputTransportMode } from "@/src/lib/llm-json-schemas";
import {
  createStructuredGenerationBudget,
  StructuredGenerationBudgetError,
  StructuredOutputError,
} from "@/src/lib/bedrock-structured-llm-client";
import {
  generationRunFailureTokenUsage,
  isStructuredGenerationAdmissionFailure,
} from "@/src/lib/generation-runs";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { prisma } from "@/src/lib/prisma";
import { normalizeWhitespace } from "@/src/lib/utils";
import { getStructuredLlmClient } from "@/src/services/bedrock-runtime";
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
  "about", "and", "answer", "are", "assistant", "attached", "code", "current", "does",
  "enforced", "file", "follow-up", "from", "how", "implementation", "inspect", "into",
  "its", "objective", "prior", "project", "repository", "request", "research", "specific",
  "that", "the", "this", "what", "where", "which", "with", "work", "works",
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
  const asksAboutRetry = /\bretr(?:y|ied|ies)\b/i.test(input.question);
  const asksAboutBackoff = /\bbackoff\b/i.test(input.question);
  const facts: ProjectFactDraft[] = [];
  let foundExplicitBound = false;
  let foundExplicitExit = false;
  let foundExplicitRetry = false;
  let foundExplicitBackoff = false;

  const addFact = (fact: ProjectFactDraft) => {
    if (facts.length >= input.maxFacts || facts.some((existing) => existing.statement === fact.statement)) return;
    facts.push({
      ...fact,
      subsystemKey: fact.subsystemKey ?? inferProjectSubsystemKey({
        text: fact.statement,
        paths: fact.citationIndexes.flatMap((oneBasedIndex) => {
          const path = input.citations[oneBasedIndex - 1]?.path;
          return path ? [path] : [];
        }),
      }),
    });
  };

  for (const [index, citation] of input.citations.entries()) {
    if (facts.length >= input.maxFacts || citation.kind !== "github_file" || !citation.path) continue;
    const excerpt = citation.excerpt ?? "";
    const hasRetryNamedDeclaration =
      /\b(?:function|class|const|let|var)\s+(?=[A-Za-z_$])(?=[\w$]*retry)[A-Za-z_$][\w$]*\b/i.test(excerpt);
    const hasBackoffNamedDeclaration =
      /\b(?:function|class|const|let|var)\s+(?=[A-Za-z_$])(?=[\w$]*backoff)[A-Za-z_$][\w$]*\b/i.test(excerpt);
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
        if (/\bretr(?:y|ied|ies)\b/i.test(condition)) foundExplicitRetry = true;
        if (/\bbackoff\b/i.test(condition)) foundExplicitBackoff = true;
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
        if (/\bretr(?:y|ied|ies)\b/i.test(condition)) foundExplicitRetry = true;
        if (/\bbackoff\b/i.test(condition)) foundExplicitBackoff = true;
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

    // A retry-named function plus an exact guard in the same immutable excerpt
    // is useful bounded evidence about where retry control lives. A declaration
    // in some other file is not enough to establish the policy.
    if (facts.some((fact) =>
      fact.category === "behavior" && fact.citationIndexes.includes(index + 1)
    )) {
      if (hasRetryNamedDeclaration) foundExplicitRetry = true;
      if (hasBackoffNamedDeclaration) foundExplicitBackoff = true;
    }

    // Once an exact guard or exit was recovered, generic declarations only
    // dilute the answer (for example, `iterationUsage`). Keep declarations as
    // a last-resort code-location result when no behavioral fact was visible.
    if (asksAboutControlFlow && facts.some((fact) => fact.category === "behavior")) {
      continue;
    }
    const declarations = Array.from(excerpt.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g));
    const pathLower = citation.path.toLowerCase();
    for (const declaration of declarations) {
      const symbol = declaration[1]!;
      const symbolLower = symbol.toLowerCase();
      const controlRelevantSymbol =
        /(?:retry|backoff|attempt|iteration|limit|budget|stop|timeout|abort|tool.?call)/i.test(symbol);
      const relevant = asksAboutControlFlow
        ? controlRelevantSymbol
        : questionTerms.some((term) =>
            symbolLower.includes(term) || pathLower.includes(term)
          );
      if (!relevant) continue;
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
  if (asksAboutBackoff && !foundExplicitBackoff) {
    coverageGaps.push("The inspected excerpts did not establish a backoff or delay policy; retry control must not be reported as backoff.");
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
      modelInvoked: false,
      fallbackUsed: false,
    };
  }

  const result = await getStructuredLlmClient("code_extraction").generateStructured({
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
    transportPreference: ["json_schema"] as StructuredOutputTransportMode[],
    budget: createStructuredGenerationBudget({
      maxModelCalls: 1,
      maxRepairPasses: 0,
      maxOutputTokens: 4_000,
      maxTotalTokens: 32_000,
    }),
  });
  const extractedFacts = controlFlowQuestionPattern.test(input.question)
    ? [...exactRecovery.facts, ...result.data.facts]
        .filter((fact, index, all) => all.findIndex((candidate) => candidate.statement === fact.statement) === index)
        .slice(0, input.maxFacts)
    : result.data.facts;
  const facts = extractedFacts.map((fact) => ({
    ...fact,
    subsystemKey: inferProjectSubsystemKey({
      text: fact.statement,
      paths: fact.citationIndexes.flatMap((oneBasedIndex) => {
        const path = input.citations[oneBasedIndex - 1]?.path;
        return path ? [path] : [];
      }),
    }),
  }));
  return {
    ...result.data,
    facts,
    coverageGaps: Array.from(new Set([
      ...result.data.coverageGaps,
      ...exactRecovery.coverageGaps,
    ])),
    tokenUsage: result.tokenUsage,
    modelInvoked: true,
    fallbackUsed: false,
  };
}

function failedExtractionAttemptUsage(error: unknown, phase: string) {
  const usage =
    error instanceof StructuredOutputError
      ? error.tokenUsage
      : generationRunFailureTokenUsage(error);
  const admissionFailure = isStructuredGenerationAdmissionFailure(error);
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
    unknownUsageAttempts: usage || admissionFailure ? 0 : 1,
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
        modelInvoked: !isStructuredGenerationAdmissionFailure(error),
        fallbackUsed: true,
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
        modelInvoked: !isStructuredGenerationAdmissionFailure(error),
        fallbackUsed: true,
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
      modelInvoked: true,
      fallbackUsed: true,
    };
  }
}

const PROJECT_FACT_PERSISTENCE_ATTEMPTS = 5;
const ACTIVE_PROJECT_FACT_RUN_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_review",
]);

class InactiveProjectFactRunError extends Error {
  constructor(status: string) {
    super(`Project Fact materialization stopped because the AgentRun is ${status}.`);
    this.name = "InactiveProjectFactRunError";
  }
}

type StoredProjectFactCandidate = {
  id: string;
  status: "pending" | "approved" | "edited_and_approved" | "denied";
  projectFactId: string | null;
  projectFact: {
    id: string;
    workItemId: string;
    statement: string;
    category: ProjectFactCategory;
    confidence: "low" | "medium" | "high";
    status: "draft" | "approved" | "rejected" | "superseded";
    lifecycleStatus: "active" | "needs_validation" | "stale" | "superseded" | "retired" | "quarantined";
    reviewNotes: string | null;
  } | null;
};

function isActiveApprovedCandidate(candidate: StoredProjectFactCandidate) {
  return (
    (candidate.status === "approved" || candidate.status === "edited_and_approved") &&
    candidate.projectFact?.status === "approved" &&
    candidate.projectFact.lifecycleStatus === "active"
  );
}

function isPendingReviewCandidate(candidate: StoredProjectFactCandidate) {
  return (
    candidate.status === "pending" &&
    candidate.projectFact?.status === "draft" &&
    candidate.projectFact.lifecycleStatus === "quarantined"
  );
}

function reusableCandidateState(candidates: StoredProjectFactCandidate[]) {
  const reusable = candidates.filter((candidate) =>
    isActiveApprovedCandidate(candidate) || isPendingReviewCandidate(candidate)
  );
  return {
    hadCandidates: candidates.length > 0,
    candidates: reusable,
    candidateIds: reusable.map((candidate) => candidate.id),
    activeProjectFactIds: reusable.flatMap((candidate) =>
      isActiveApprovedCandidate(candidate) && candidate.projectFactId
        ? [candidate.projectFactId]
        : []
    ),
  };
}

async function loadStoredProjectFactCandidates(input: {
  runId: string;
  userId: string;
  workItemId: string;
}) {
  const candidates = await prisma.agentRunCandidate.findMany({
    where: {
      agentRunId: input.runId,
      agentRun: {
        userId: input.userId,
        workItemId: input.workItemId,
      },
      kind: { in: ["new_project_fact", "project_fact_revision"] },
    },
    select: {
      id: true,
      status: true,
      projectFactId: true,
      projectFact: {
        select: {
          id: true,
          workItemId: true,
          statement: true,
          category: true,
          confidence: true,
          status: true,
          lifecycleStatus: true,
          reviewNotes: true,
        },
      },
    },
    orderBy: [{ batchNumber: "asc" }, { ordinal: "asc" }],
  });
  return reusableCandidateState(candidates);
}

async function ensureProjectFactCandidateSideEffects(input: {
  runId: string;
  workItemId: string;
  candidates: StoredProjectFactCandidate[];
}) {
  const repairable = input.candidates.flatMap((candidate) =>
    candidate.projectFact ? [{ candidate, fact: candidate.projectFact }] : []
  );
  // Embeddings are an optimization because lexical retrieval remains available.
  // Only approved active facts participate in retrieval. Re-attempt those on
  // every workflow replay, but do not pay to embed quarantined pending facts.
  const embeddings = Promise.allSettled(repairable
    .filter(({ candidate }) => isActiveApprovedCandidate(candidate))
    .map(({ fact }) =>
      upsertProjectFactEmbedding({
        projectFactId: fact.id,
      inputText: buildProjectFactEmbeddingText(fact),
    })
  ));
  // The review-later audit card is product state, so let a local write failure
  // reach the persistence retry loop. The idempotency key makes this safe after
  // the ProjectFact transaction has already committed.
  // These serializable writes share pending-review indexes. Running them in
  // parallel creates avoidable TransactionWriteConflict retries on Neon even
  // though each card belongs to a different fact.
  for (const { candidate, fact } of repairable) {
    await recordChange({
      workItemId: input.workItemId,
      entityKind: "project_fact",
      action: isActiveApprovedCandidate(candidate) ? "created" : "quarantined",
      entityId: fact.id,
      afterSnapshot: {
        statement: fact.statement,
        category: fact.category,
        lifecycleStatus: fact.lifecycleStatus,
      },
      reason: isActiveApprovedCandidate(candidate)
        ? "Repository research auto-applied a supported Project Fact for later review."
        : "Repository research quarantined a Project Fact that failed the automatic safety gate.",
      provenance: { agentRunId: input.runId },
      suffix: `${input.runId}:${fact.id}`,
    });
  }
  await embeddings;
}

function persistenceErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
}

function isRetryableProjectFactPersistenceError(error: unknown) {
  const code = persistenceErrorCode(error);
  if (code === "P2002" || code === "P2034") return true;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return message.includes("TransactionWriteConflict");
}

async function projectFactPersistenceBackoff(attempt: number) {
  const baseDelayMs = Math.min(250, 10 * (2 ** attempt));
  const delayMs = baseDelayMs + Math.floor(Math.random() * Math.max(1, baseDelayMs / 2));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function acquireProjectFactMaterializationLock(
  tx: Prisma.TransactionClient,
  workItemId: string,
) {
  // Two-key advisory locks give this workflow its own namespace while keeping
  // the lock scoped to one Work Item. PostgreSQL releases it automatically when
  // the transaction commits or rolls back.
  await tx.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(
      hashtext('workbase-project-fact-materialization'),
      hashtext(${workItemId})
    )
  `;
}

async function lockActiveProjectFactRun(
  tx: Prisma.TransactionClient,
  input: {
    runId: string;
    userId: string;
    workItemId: string;
  },
) {
  const runs = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT "status"::text AS "status"
    FROM "AgentRun"
    WHERE "id" = ${input.runId}
      AND "userId" = ${input.userId}
      AND "workItemId" = ${input.workItemId}
    FOR UPDATE
  `;
  const status = runs[0]?.status ?? "missing";
  if (!ACTIVE_PROJECT_FACT_RUN_STATUSES.has(status)) {
    throw new InactiveProjectFactRunError(status);
  }
}

async function repairAndReturnStoredCandidates(input: {
  runId: string;
  userId: string;
  workItemId: string;
  coverageGaps: string[];
  tokenUsage: unknown;
  modelInvoked: boolean;
  fallbackUsed: boolean;
  repairSideEffects?: boolean;
}) {
  const stored = await loadStoredProjectFactCandidates(input);
  if (!stored.hadCandidates) return null;
  if (input.repairSideEffects !== false) {
    await ensureProjectFactCandidateSideEffects({
      runId: input.runId,
      workItemId: input.workItemId,
      candidates: stored.candidates,
    });
  }
  return {
    candidateIds: stored.candidateIds,
    activeProjectFactIds: stored.activeProjectFactIds,
    coverageGaps: input.coverageGaps,
    tokenUsage: input.tokenUsage,
    modelInvoked: input.modelInvoked,
    fallbackUsed: input.fallbackUsed,
  };
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
  const [workItem, agentRun] = await Promise.all([
    prisma.workItem.findFirstOrThrow({
      where: { id: input.workItemId, userId: input.userId },
      select: { title: true },
    }),
    prisma.agentRun.findFirstOrThrow({
      where: {
        id: input.runId,
        userId: input.userId,
        workItemId: input.workItemId,
      },
      select: { id: true, status: true },
    }),
  ]);
  const replayed = await repairAndReturnStoredCandidates({
    runId: input.runId,
    userId: input.userId,
    workItemId: input.workItemId,
    coverageGaps: [],
    tokenUsage: null,
    modelInvoked: false,
    fallbackUsed: false,
    repairSideEffects: ACTIVE_PROJECT_FACT_RUN_STATUSES.has(agentRun.status),
  });
  if (replayed) return replayed;
  if (!ACTIVE_PROJECT_FACT_RUN_STATUSES.has(agentRun.status)) {
    throw new InactiveProjectFactRunError(agentRun.status);
  }

  const repositoryCitations = input.citations.filter((citation) => citation.kind === "github_file");
  if (!repositoryCitations.length) {
    return {
      candidateIds: [],
      activeProjectFactIds: [],
      coverageGaps: [],
      tokenUsage: null,
      modelInvoked: false,
      fallbackUsed: false,
    };
  }
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
    return {
      candidateIds: [],
      activeProjectFactIds: [],
      coverageGaps: extracted.coverageGaps,
      tokenUsage: extracted.tokenUsage,
      modelInvoked: extracted.modelInvoked,
      fallbackUsed: extracted.fallbackUsed,
    };
  }

  const selectedOriginalIndexes = Array.from(
    new Set(validFacts.flatMap((fact) => fact.citationIndexes.map((index) => index - 1))),
  );
  const selectedCitations = selectedOriginalIndexes.map((index) => repositoryCitations[index]!);
  const localIndexByOriginal = new Map(
    selectedOriginalIndexes.map((originalIndex, localIndex) => [originalIndex, localIndex]),
  );
  const batchNumber = input.batchNumber ?? 1;
  for (let attempt = 0; attempt < PROJECT_FACT_PERSISTENCE_ATTEMPTS; attempt += 1) {
    try {
      const winner = await repairAndReturnStoredCandidates({
        runId: input.runId,
        userId: input.userId,
        workItemId: input.workItemId,
        coverageGaps: extracted.coverageGaps,
        tokenUsage: extracted.tokenUsage,
        modelInvoked: extracted.modelInvoked,
        fallbackUsed: extracted.fallbackUsed,
      });
      if (winner) return winner;

      const reusedProjectFactIds = await prisma.$transaction(async (tx) => {
        // Acquire the Work Item lock before the run row. If another run is
        // materializing this Work Item, cancellation can still take its own
        // run-row lock while we wait; this transaction will then observe the
        // terminal status rather than committing stale research afterward.
        await acquireProjectFactMaterializationLock(tx, input.workItemId);
        await lockActiveProjectFactRun(tx, input);
        const sameRunCandidates = await tx.agentRunCandidate.findMany({
          where: {
            agentRunId: input.runId,
            kind: { in: ["new_project_fact", "project_fact_revision"] },
          },
          select: { id: true },
        });
        if (sameRunCandidates.length) return [] as string[];

        // Promotion shares this transaction with fact/candidate materialization.
        // Cancellation therefore wins before every write or waits until the
        // complete materialization commits; a rollback cannot leave orphan
        // github_file_excerpt evidence behind.
        const promoted = await promoteRepositoryCitations({
          workItemId: input.workItemId,
          citations: selectedCitations,
          reviewScope: `project-fact-research:${input.runId}`,
          mutationFence: (operation) => operation(tx),
        });

        // This read deliberately happens after the database lock is acquired.
        // A second process therefore observes facts committed by the winner and
        // skips an identical current-revision statement instead of creating a
        // parallel active successor.
        const existingFacts = await tx.projectFact.findMany({
          where: {
            workItemId: input.workItemId,
            status: "approved",
            lifecycleStatus: "active",
          },
          include: { evidence: { select: { evidenceItemId: true } } },
          orderBy: { updatedAt: "desc" },
        });
        let ordinal = 0;
        const reused: string[] = [];
        for (const fact of validFacts) {
          const ranked = existingFacts
            .map((existing) => ({ existing, score: similarity(fact.statement, existing.statement) }))
            .sort((left, right) => right.score - left.score);
          const closest = ranked[0] ?? null;
          const citedShas = new Set(fact.citationIndexes.flatMap((oneBasedIndex) => {
            const citation = repositoryCitations[oneBasedIndex - 1];
            return citation?.commitSha ? [citation.commitSha] : [];
          }));
          const evidenceIds = fact.citationIndexes.flatMap((oneBasedIndex) => {
            const localIndex = localIndexByOriginal.get(oneBasedIndex - 1);
            if (localIndex == null) return [];
            const evidenceId = promoted.evidenceIdByCitationIndex.get(localIndex);
            return evidenceId ? [evidenceId] : [];
          });
          const declaredSubsystemKey = "subsystemKey" in fact ? fact.subsystemKey : null;
          const subsystemKey = declaredSubsystemKey ?? inferProjectSubsystemKey({
            text: fact.statement,
            paths: fact.citationIndexes.flatMap((oneBasedIndex) => {
              const path = repositoryCitations[oneBasedIndex - 1]?.path;
              return path ? [path] : [];
            }),
          });
          const closestEvidenceIds = new Set(
            closest?.existing.evidence.map((entry) => entry.evidenceItemId) ?? [],
          );
          const alreadyGroundedByImmutableContent =
            (closest?.score ?? 0) >= 0.86 &&
            evidenceIds.length > 0 &&
            evidenceIds.every((evidenceId) => closestEvidenceIds.has(evidenceId));
          if (alreadyGroundedByImmutableContent) {
            if (!closest!.existing.subsystemKey && subsystemKey) {
              await tx.projectFact.update({
                where: { id: closest!.existing.id },
                data: { subsystemKey },
              });
            }
            reused.push(closest!.existing.id);
            continue;
          }
          const supersedes = (closest?.score ?? 0) >= 0.86
            ? closest!.existing
            : ranked.find(
                (entry) => entry.existing.category === fact.category && entry.score >= 0.42,
              )?.existing ?? null;
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
              subsystemKey,
              searchText: normalizeWhitespace([
                fact.statement,
                fact.category,
                subsystemKey ?? "",
                fact.reviewNotes ?? "",
              ].join(" ")),
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
          ordinal += 1;
          await tx.agentRunCandidate.create({
            data: {
              agentRunId: input.runId,
              projectFactId: projectFact.id,
              kind: supersedes ? "project_fact_revision" : "new_project_fact",
              status: autoSafe ? "approved" : "pending",
              batchNumber,
              ordinal,
              snapshot: toInputJson({
                statement: fact.statement,
                category: fact.category,
                confidence: fact.confidence,
                sensitivityFlag: fact.sensitivityFlag,
                reviewNotes: fact.reviewNotes,
                subsystemKey,
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
              where: {
                id: { in: evidenceIds },
                approvalSource: { not: "user" },
                reviewState: "pending_review",
              },
              data: {
                included: true,
                lifecycleStatus: "active",
                approvalSource: "automation",
                autoAppliedAt: new Date(),
              },
            });
          }
        }
        return Array.from(new Set(reused));
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      });

      const stored = await loadStoredProjectFactCandidates({
        runId: input.runId,
        userId: input.userId,
        workItemId: input.workItemId,
      });
      await ensureProjectFactCandidateSideEffects({
        runId: input.runId,
        workItemId: input.workItemId,
        candidates: stored.candidates,
      });
      return {
        candidateIds: stored.candidateIds,
        activeProjectFactIds: Array.from(new Set([
          ...stored.activeProjectFactIds,
          ...reusedProjectFactIds,
        ])),
        coverageGaps: extracted.coverageGaps,
        tokenUsage: extracted.tokenUsage,
        modelInvoked: extracted.modelInvoked,
        fallbackUsed: extracted.fallbackUsed,
      };
    } catch (error) {
      if (!isRetryableProjectFactPersistenceError(error)) throw error;
      const winner = await repairAndReturnStoredCandidates({
        runId: input.runId,
        userId: input.userId,
        workItemId: input.workItemId,
        coverageGaps: extracted.coverageGaps,
        tokenUsage: extracted.tokenUsage,
        modelInvoked: extracted.modelInvoked,
        fallbackUsed: extracted.fallbackUsed,
      });
      if (winner) return winner;
      if (attempt >= PROJECT_FACT_PERSISTENCE_ATTEMPTS - 1) throw error;
      await projectFactPersistenceBackoff(attempt);
    }
  }
  throw new Error("Project Fact persistence retry budget exhausted.");
}
