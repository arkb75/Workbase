import { z } from "zod";
import type {
  AnswerCitationPolicy,
  FinalizedChatAnswer,
  ProjectKnowledgeCitation,
} from "@/src/domain/project-chat";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import { analyzeProjectChatPublicationSafety } from "@/src/lib/project-chat-publication-safety";
import {
  assertAnswerCitationContract,
  selectReferencedCitations,
} from "@/src/services/chat-citation-service";
import type { ProjectAnswerGroundingEntry } from "@/src/services/project-answer-grounding-service";
import { getStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { redactRepositorySecrets } from "@/src/services/github-repository-exploration-service";
import { runAuditedStructuredGeneration } from "@/src/services/structured-generation-audit-service";
import {
  claimLedgerNeedsResearch,
  claimLedgerValidationIssues,
  PROJECT_CHAT_CLAIM_LEDGER_VERSION,
  projectChatClaimLedgerSchema,
} from "@/src/services/project-chat-claim-ledger-service";

export const PROJECT_CHAT_ANSWER_VERIFIER_VERSION = "project-chat-answer-verifier-v10";

export const projectChatResearchCapabilitySchema = z.enum([
  "project_knowledge",
  "repository_git",
  "durable_refresh",
  "prior_turn",
]);
export type ProjectChatResearchCapability = z.infer<
  typeof projectChatResearchCapabilitySchema
>;

export const projectChatAnswerVerificationSchema = z.object({
  requiresProjectCitations: z.boolean(),
  instructionSatisfied: z.boolean(),
  formatSatisfied: z.boolean(),
  answerUseful: z.boolean(),
  researchObjective: z.string().trim().min(1).max(1_000).nullable(),
  recommendedCapabilities: z.array(projectChatResearchCapabilitySchema).max(4),
  claimLedger: projectChatClaimLedgerSchema,
  issues: z.array(z.object({
    code: z.string().trim().min(1).max(100),
    explanation: z.string().trim().min(1).max(700),
    candidateCitationIndexes: z.array(z.number().int().min(1)).max(12),
  })).max(16),
});

export type ProjectChatAnswerVerification = z.infer<
  typeof projectChatAnswerVerificationSchema
> & {
  generationRunId: string | null;
  mechanicalIssues: string[];
};

const projectChatAnswerVerificationJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "requiresProjectCitations",
    "instructionSatisfied",
    "formatSatisfied",
    "answerUseful",
    "researchObjective",
    "recommendedCapabilities",
    "claimLedger",
    "issues",
  ],
  properties: {
    requiresProjectCitations: { type: "boolean" },
    instructionSatisfied: { type: "boolean" },
    formatSatisfied: { type: "boolean" },
    answerUseful: { type: "boolean" },
    researchObjective: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 1_000 },
        { type: "null" },
      ],
    },
    recommendedCapabilities: {
      type: "array",
      maxItems: 4,
      items: {
        type: "string",
        enum: [
          "project_knowledge",
          "repository_git",
          "durable_refresh",
          "prior_turn",
        ],
      },
    },
    claimLedger: {
      type: "object",
      additionalProperties: false,
      required: ["version", "entries"],
      properties: {
        version: {
          type: "string",
          enum: [PROJECT_CHAT_CLAIM_LEDGER_VERSION],
        },
        entries: {
          type: "array",
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "quote",
              "centrality",
              "support",
              "action",
              "citationIndexes",
              "missingOrContradictedPremise",
              "rationale",
              "confidence",
            ],
            properties: {
              id: { type: "string", pattern: "^claim_[1-9]\\d*$", maxLength: 30 },
              quote: { type: "string", minLength: 1, maxLength: 1_200 },
              centrality: { type: "string", enum: ["central", "supporting"] },
              support: {
                type: "string",
                enum: [
                  "direct",
                  "synthesis",
                  "reasonable_inference",
                  "ambiguous",
                  "unfounded",
                  "contradicted",
                  "misleading",
                ],
              },
              action: {
                type: "string",
                enum: [
                  "keep_direct",
                  "keep_synthesis",
                  "keep_inference",
                  "qualify",
                  "repair_citation",
                  "research",
                  "remove_unfounded",
                  "remove_contradicted",
                  "remove_misleading",
                ],
              },
              citationIndexes: {
                type: "array",
                maxItems: 20,
                items: { type: "integer", minimum: 1 },
              },
              missingOrContradictedPremise: {
                anyOf: [
                  { type: "string", minLength: 1, maxLength: 700 },
                  { type: "null" },
                ],
              },
              rationale: { type: "string", minLength: 1, maxLength: 700 },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
            },
          },
        },
      },
    },
    issues: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "explanation", "candidateCitationIndexes"],
        properties: {
          code: { type: "string", minLength: 1, maxLength: 100 },
          explanation: { type: "string", minLength: 1, maxLength: 700 },
          candidateCitationIndexes: {
            type: "array",
            maxItems: 12,
            items: { type: "integer", minimum: 1 },
          },
        },
      },
    },
  },
};

const citationMarkerPattern = /\[citation:(\d+)\]/gi;
const permissiveCitationMarkerPattern = /\[citation:([^\]]*)\]/gi;

function providerSafeText(value: string) {
  return redactRepositorySecrets(value).content;
}

export function compactProjectChatVerificationSources(
  catalog: ProjectKnowledgeCitation[],
  maximumCharacters = 28_000,
) {
  const perSourceCharacters = Math.max(
    160,
    Math.floor(maximumCharacters / Math.max(1, catalog.length)),
  );
  return catalog.map((citation, offset) => ({
    citationIndex: offset + 1,
    kind: citation.kind,
    label: providerSafeText(citation.label),
    excerpt: providerSafeText(citation.excerpt ?? "").slice(0, perSourceCharacters),
    repository: citation.repository ?? null,
    commitSha: citation.commitSha ?? null,
    path: citation.path ?? null,
  }));
}

/** Mechanical validation only: syntax, range, and catalog membership. */
export function analyzeProjectChatCitationSyntax(
  answer: string,
  citationCount: number,
) {
  const markers = Array.from(answer.matchAll(permissiveCitationMarkerPattern));
  const issues: string[] = [];
  const indexes: number[] = [];
  for (const marker of markers) {
    const raw = marker[1]?.trim() ?? "";
    if (!/^\d+$/.test(raw)) {
      issues.push(`Malformed citation marker: ${marker[0]}.`);
      continue;
    }
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 1 || index > citationCount) {
      issues.push(`Citation ${raw} is outside the available source catalog.`);
      continue;
    }
    indexes.push(index);
  }
  const exactMarkerCount = Array.from(answer.matchAll(citationMarkerPattern)).length;
  if (exactMarkerCount !== markers.length) {
    issues.push("One or more citation markers are not in canonical [citation:N] form.");
  }
  return {
    issues: Array.from(new Set(issues)),
    citationIndexes: Array.from(new Set(indexes)),
  };
}

function groundedClaimSegments(answer: string) {
  const segments = answer
    .split(/\n{2,}|\n(?=\s*(?:[-*+]\s+|\d+[.)]\s+|\|))/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.flatMap((segment, index) => {
    const citationIndexes = Array.from(segment.matchAll(citationMarkerPattern))
      .map((match) => Number(match[1]))
      .filter((citationIndex) => Number.isInteger(citationIndex) && citationIndex > 0);
    if (!citationIndexes.length) return [];
    const localClaim = segment.replace(citationMarkerPattern, "").trim();
    // Models commonly place one citation line directly after a table. That is
    // still an explicit mechanical attachment to the immediately preceding
    // block; retain the model's layout instead of forcing citations into a
    // particular table cell.
    const claim = localClaim || segments.slice(0, index).reverse()
      .map((candidate) => candidate.replace(citationMarkerPattern, "").trim())
      .find(Boolean) || "";
    return claim
      ? [{ claim, citationIndexes: Array.from(new Set(citationIndexes)) }]
      : [];
  });
}

export function finalizeModelLedProjectChatAnswer(input: {
  answer: string;
  catalog: ProjectKnowledgeCitation[];
  requiresProjectCitations: boolean;
  freshness?: FinalizedChatAnswer["freshness"];
}) {
  const syntax = analyzeProjectChatCitationSyntax(
    input.answer,
    input.catalog.length,
  );
  const protocolSafety = analyzeProjectChatPublicationSafety({
    answer: input.answer,
    requiresProjectCitations: false,
  });
  if (syntax.issues.length || protocolSafety.length) {
    throw new Error([
      ...syntax.issues,
      ...protocolSafety.map((issue) => issue.explanation),
    ].join(" "));
  }
  if (!syntax.citationIndexes.length) {
    if (input.requiresProjectCitations) {
      throw new Error("The answer makes project claims but cites no authoritative project source.");
    }
    const answer = input.answer.trim();
    assertAnswerCitationContract({
      content: answer,
      citations: [],
      policy: "none",
      groundedClaims: [],
    });
    return {
      answer,
      citations: [] as ProjectKnowledgeCitation[],
      citationPolicy: "none" as AnswerCitationPolicy,
      groundedClaims: [] as Array<{ claim: string; citationIndexes: number[] }>,
      freshness: input.freshness ?? null,
    };
  }
  const selected = selectReferencedCitations(input.answer, input.catalog, 20);
  const groundedClaims = groundedClaimSegments(selected.content);
  assertAnswerCitationContract({
    content: selected.content,
    citations: selected.citations,
    policy: "required_inline",
    groundedClaims,
  });
  return {
    answer: selected.content,
    citations: selected.citations,
    citationPolicy: "required_inline" as AnswerCitationPolicy,
    groundedClaims,
    freshness: input.freshness ?? null,
  };
}

export function projectChatAnswerVerificationSystemPrompt(input: {
  attempt: 1 | 2 | 3 | 4;
  researchContinuationUsed: boolean;
}) {
  return [
    "You are the bounded claim-level semantic verifier for one project-chat answer.",
    "The primary answer model—not this verifier—owns intent, structure, tool choice, and prose. Build an internal claim ledger; do not issue one global publish-or-reject verdict and do not demand particular wording or a canned structure.",
    "Ledger every material factual project claim or tightly related group of claims using concise, faithful claim text. Prefer an answer span when convenient, but harmless wording or Markdown differences are not verification failures. Omit headings and ordinary conversational language that make no factual assertion. Use stable IDs claim_1, claim_2, and so on in answer order.",
    "For each claim, distinguish direct support, multi-source synthesis, reasonable inference, ambiguity, an unfounded missing premise, contradiction, and a proposition whose central implication remains misleading even when qualified. Topical similarity and absence of verbatim wording are not grounds for rejection.",
    "A reasonable inference follows from cited premises through ordinary reasoning without introducing a new measurement, event, actor, universal, causal result, or other necessary fact. Keep it, using qualify only when the uncertainty is material to the user.",
    "Removal is exceptional. It requires high confidence, the exact missing or contradicted premise, and a conclusion that citation repair or honest qualification cannot preserve the proposition. Prefer keep, then qualify, then citation repair, then focused research, and remove last.",
    "Use research only for a central unresolved claim when an available authorized capability can reasonably establish the missing premise. Peripheral gaps must be qualified or removed without discarding supported content.",
    "Check each project claim against the source entries it cites and the complete compact source manifest. Conversation history may resolve references and requested presentation, but it is not factual project evidence.",
    "You also receive a compact manifest of every frozen source. Use it to identify existing citations that can repair a claim; do not mistake an omitted citation in the draft for missing evidence. Put any useful source ordinals in candidateCitationIndexes for the corresponding issue.",
    "Set requiresProjectCitations true for claims about this project, its attached sources, implementation, project runtime configuration, prior tool activity, accomplishments, or stored project state. Ordinary conversational statements and clarification questions may be citation-free.",
    "A table, matrix, grid, side-by-side layout, bullets, prose, or equivalent format can satisfy the request when it expresses the requested relationships clearly. Do not require literal trigger words.",
    "Evaluate freshness semantically. If the request requires broadly synchronized reusable knowledge, require a completed durable knowledge refresh. Bounded repository inspection at an immutable current revision can satisfy a narrow current-source question without a full refresh.",
    "Do not require one citation per paragraph, bullet, table row, or other layout block. Judge whether each factual claim is supported by the citations it actually references; deterministic code validates only citation syntax, range, project scope, and internal-protocol safety.",
    ...(input.attempt > 1 && !input.researchContinuationUsed
      ? ["This answer has already received its bounded revision. Classify the remaining claims precisely. Do not turn editorial preferences or repeated citation placement into substantive objections."]
      : []),
    ...(input.researchContinuationUsed
      ? [input.attempt >= 3
          ? "The one evidence continuation and bounded revision have both been used. Do not request research again. Classify each remaining claim for preservation, qualification, citation repair, or removal."
          : "One evidence continuation has already been used. Do not request another. Classify unresolved content for qualification or removal while preserving supported claims."]
      : []),
    "Set answerUseful true whenever at least one central request obligation is answered or supported content can form a specific useful partial answer. Do not mark the entire answer useless because a supporting claim is weak.",
    "Use issues only for answer-wide instruction, format, safety, or mechanical concerns. Claim support concerns belong in the ledger. If any claim uses research, provide one precise general research objective and only the authorized capabilities needed. Otherwise researchObjective must be null and recommendedCapabilities empty.",
    "Do not introduce facts, rewrite the answer, write user-facing prose, or select a preferred editorial template. Your ledger is private audit and revision guidance.",
  ].join(" ");
}

export async function verifyModelLedProjectChatAnswer(input: {
  workItemId: string;
  agentRunId: string;
  attempt: 1 | 2 | 3 | 4;
  currentRequest: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  answer: string;
  entries: ProjectAnswerGroundingEntry[];
  catalog: ProjectKnowledgeCitation[];
  toolNames: string[];
  sourceRefreshCompleted: boolean;
  availableResearchCapabilities: ProjectChatResearchCapability[];
  researchContinuationUsed: boolean;
}) {
  const mechanical = analyzeProjectChatCitationSyntax(
    input.answer,
    input.catalog.length,
  );
  const protocolSafety = analyzeProjectChatPublicationSafety({
    answer: input.answer,
    requiresProjectCitations: false,
  });
  const referenced = new Set(mechanical.citationIndexes);
  const referencedEntries = input.entries.filter((entry) =>
    entry.citationIndexes.some((index) => referenced.has(index))
  );
  const referencedCharacters = 24_000;
  const perReferencedEntryCharacters = Math.max(
    400,
    Math.floor(referencedCharacters / Math.max(1, referencedEntries.length)),
  );
  const compactReferencedEntries = referencedEntries.map((entry) => ({
    kind: entry.kind,
    authority: entry.authority,
    title: providerSafeText(entry.title),
    content: providerSafeText(entry.content).slice(0, perReferencedEntryCharacters),
    citationIndexes: entry.citationIndexes,
    currentRun: entry.currentRun,
  }));
  const availableSources = compactProjectChatVerificationSources(input.catalog);
  const result = await runAuditedStructuredGeneration({
    workItemId: input.workItemId,
    agentRunId: input.agentRunId,
    kind: "project_chat_verification",
    profile: "verification",
    idempotencyKey: `project-chat-verification:${input.agentRunId}:${PROJECT_CHAT_ANSWER_VERIFIER_VERSION}:${input.attempt}`,
    inputSummary: {
      verifierVersion: PROJECT_CHAT_ANSWER_VERIFIER_VERSION,
      attempt: input.attempt,
      answerCharacters: input.answer.length,
      citationCount: input.catalog.length,
      referencedCitationCount: referenced.size,
      mechanicalIssueCount: mechanical.issues.length,
      toolNames: input.toolNames,
      sourceRefreshCompleted: input.sourceRefreshCompleted,
      availableResearchCapabilities: input.availableResearchCapabilities,
      researchContinuationUsed: input.researchContinuationUsed,
    },
    execute: () => getStructuredLlmClient("verification").generateStructured({
      systemPrompt: projectChatAnswerVerificationSystemPrompt({
        attempt: input.attempt,
        researchContinuationUsed: input.researchContinuationUsed,
      }),
      userPrompt: JSON.stringify({
        request: providerSafeText(input.currentRequest),
        conversation: input.conversation.slice(-12).map((message) => ({
          ...message,
          content: providerSafeText(message.content),
        })),
        toolsUsed: input.toolNames,
        availableResearchCapabilities: input.availableResearchCapabilities,
        researchContinuationUsed: input.researchContinuationUsed,
        durableSourceRefreshCompleted: input.sourceRefreshCompleted,
        answer: providerSafeText(input.answer),
        mechanicalCitationIssues: mechanical.issues,
        publicationSafetyIssues: protocolSafety,
        referencedSources: compactReferencedEntries,
        availableSources,
      }),
      schema: projectChatAnswerVerificationSchema,
      schemaName: "project_chat_answer_verification",
      schemaDescription: "A claim-level semantic audit and revision ledger for one project-chat answer.",
      jsonSchema: projectChatAnswerVerificationJsonSchema,
      maxTokens: 4_500,
      temperature: 0,
      effort: "medium",
      repairStrategy: "repair_last_failure",
      extraValidation: (value) => {
        const continuing = claimLedgerNeedsResearch(value.claimLedger);
        const candidateIndexes = value.issues.flatMap((issue) =>
          issue.candidateCitationIndexes
        );
        const claimCitationIndexes = value.claimLedger.entries.flatMap((entry) =>
          entry.citationIndexes
        );
        const available = new Set(input.availableResearchCapabilities);
        return [
        ...(value.requiresProjectCitations && !value.claimLedger.entries.length
          ? ["A project-grounded answer must ledger its material project claims."]
          : []),
        ...(continuing && input.researchContinuationUsed
          ? ["Only one evidence continuation is allowed."]
          : []),
        ...(continuing &&
        (!value.researchObjective || !value.recommendedCapabilities.length)
          ? ["Continue research requires a precise objective and at least one recommended capability."]
          : []),
        ...(!continuing && (value.researchObjective !== null || value.recommendedCapabilities.length)
          ? ["Only continue research may carry a research objective or recommended capabilities."]
          : []),
        ...(value.recommendedCapabilities.some((capability) => !available.has(capability))
          ? ["Recommended research capabilities must be authorized for this turn."]
          : []),
        ...(candidateIndexes.some((index) => index > input.catalog.length)
          ? ["Candidate citation indexes must exist in the frozen source catalog."]
          : []),
        ...(claimCitationIndexes.some((index) => index > input.catalog.length)
          ? ["Claim citation indexes must exist in the frozen source catalog."]
          : []),
        ...(value.requiresProjectCitations && value.claimLedger.entries.some((entry) =>
          !entry.action.startsWith("remove_") &&
          entry.action !== "research" &&
          entry.citationIndexes.length === 0
        )
          ? ["Every surviving project claim must cite at least one frozen source or premise."]
          : []),
        ...claimLedgerValidationIssues(value.claimLedger),
      ];
      },
    }),
  });
  return {
    ...result.data,
    generationRunId: result.generationRunId,
    mechanicalIssues: [
      ...mechanical.issues,
      ...protocolSafety.map((issue) => issue.explanation),
    ],
  } satisfies ProjectChatAnswerVerification;
}

export function projectChatRepairInstructions(
  verification: ProjectChatAnswerVerification,
) {
  return [
    "Revise your prior answer once using only the frozen source catalog and internal claim ledger. Preserve every supported useful claim and the requested structure; make only the targeted edits below.",
    ...verification.mechanicalIssues.map((issue) => `- Citation integrity: ${issue}`),
    ...verification.claimLedger.entries.map((entry) => {
      const citations = entry.citationIndexes.length
        ? ` Evidence: ${entry.citationIndexes.map((index) => `[citation:${index}]`).join(", ")}.`
        : "";
      const premise = entry.missingOrContradictedPremise
        ? ` Premise issue: ${entry.missingOrContradictedPremise}`
        : "";
      return `- ${entry.id} ${entry.action}: ${entry.quote} — ${entry.rationale}${premise}${citations}`;
    }),
    ...verification.issues.map((issue) => {
      const candidates = issue.candidateCitationIndexes.length
        ? ` Candidate citations already in the frozen catalog: ${issue.candidateCitationIndexes.map((index) => `[citation:${index}]`).join(", ")}.`
        : "";
      return `- ${issue.code}: ${issue.explanation}${candidates}`;
    }),
    "Do not call tools, search again, or introduce new sources. The frozen source catalog is the complete evidence boundary for this repair.",
    "Keep direct, synthesis, and reasonable-inference claims. Qualify only claims marked qualify; repair only the specified citations; remove only claims explicitly marked remove. If a central requested fact remains unresolved, state that specific boundary while still answering with every supported result.",
    "Return only the revised user-facing answer.",
  ].join("\n");
}

export function projectChatPublicationInstructions(
  verification: ProjectChatAnswerVerification,
) {
  return [
    "Produce the final publication projection from the prior answer and the internal claim ledger using only the frozen sources.",
    "Preserve the user's requested format and every claim marked keep_direct, keep_synthesis, or keep_inference. Reasonable inferences may remain, with calibrated wording when the ledger marks qualify.",
    "Repair citations using only the ledger's citation indexes. Remove only claims explicitly marked remove_unfounded, remove_contradicted, or remove_misleading. Do not replace the answer with a generic refusal.",
    ...verification.mechanicalIssues.map((issue) => `- Citation integrity: ${issue}`),
    ...verification.claimLedger.entries.map((entry) => {
      const citations = entry.citationIndexes.length
        ? ` Sources: ${entry.citationIndexes.map((index) => `[citation:${index}]`).join(", ")}.`
        : "";
      const premise = entry.missingOrContradictedPremise
        ? ` Missing or contradicted premise: ${entry.missingOrContradictedPremise}`
        : "";
      return `- ${entry.id} ${entry.action}: ${entry.quote} — ${entry.rationale}${premise}${citations}`;
    }),
    ...verification.issues.map((issue) => `- Answer-wide issue ${issue.code}: ${issue.explanation}`),
    "If some requested information remains unavailable, publish the supported portion and name the narrow gap. Return only the user-facing answer with normal [citation:N] markers.",
  ].join("\n");
}
