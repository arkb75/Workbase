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

export const PROJECT_CHAT_ANSWER_VERIFIER_VERSION = "project-chat-answer-verifier-v8";

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
  verdict: z.enum([
    "publish",
    "publish_with_limitations",
    "continue_research",
    "repair",
    "insufficient_context",
  ]),
  requiresProjectCitations: z.boolean(),
  groundingSatisfied: z.boolean(),
  instructionSatisfied: z.boolean(),
  formatSatisfied: z.boolean(),
  researchObjective: z.string().trim().min(1).max(1_000).nullable(),
  recommendedCapabilities: z.array(projectChatResearchCapabilitySchema).max(4),
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
    "verdict",
    "requiresProjectCitations",
    "groundingSatisfied",
    "instructionSatisfied",
    "formatSatisfied",
    "researchObjective",
    "recommendedCapabilities",
    "issues",
  ],
  properties: {
    verdict: {
      type: "string",
      enum: [
        "publish",
        "publish_with_limitations",
        "continue_research",
        "repair",
        "insufficient_context",
      ],
    },
    requiresProjectCitations: { type: "boolean" },
    groundingSatisfied: { type: "boolean" },
    instructionSatisfied: { type: "boolean" },
    formatSatisfied: { type: "boolean" },
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
  attempt: 1 | 2 | 3;
  researchContinuationUsed: boolean;
}) {
  return [
    "You are the bounded semantic verifier for one project-chat answer.",
    "The primary answer model—not this verifier—owns intent, structure, tool choice, and prose. Evaluate whether its answer actually satisfies the user's request and requested format without demanding a particular wording or canned structure.",
    "Check each project claim as written against the source entries it cites. Topical similarity is not entailment. Conversation history may resolve references and requested presentation, but it is not factual project evidence.",
    "You also receive a compact manifest of every frozen source. Use it to identify existing citations that can repair a claim; do not mistake an omitted citation in the draft for missing evidence. Put any useful source ordinals in candidateCitationIndexes for the corresponding issue.",
    "Set requiresProjectCitations true for claims about this project, its attached sources, implementation, project runtime configuration, prior tool activity, accomplishments, or stored project state. Ordinary conversational statements and clarification questions may be citation-free.",
    "A table, matrix, grid, side-by-side layout, bullets, prose, or equivalent format can satisfy the request when it expresses the requested relationships clearly. Do not require literal trigger words.",
    "Evaluate freshness semantically. If the request requires broadly synchronized reusable knowledge, require a completed durable knowledge refresh. Bounded repository inspection at an immutable current revision can satisfy a narrow current-source question without a full refresh.",
    "Do not require one citation per paragraph, bullet, table row, or other layout block. Judge whether each factual claim is supported by the citations it actually references; deterministic code validates only citation syntax, range, project scope, and internal-protocol safety.",
    ...(input.attempt > 1 && !input.researchContinuationUsed
      ? ["This is the only bounded revision. Publish when the factual claims are substantively supported and remaining concerns are editorial. Do not request another repair merely to repeat a supporting source in every table row. Still reject unsupported facts, contradictions, unsafe output, or a broken requested format."]
      : []),
    "Use continue_research when a material relationship or requested fact is not established by the frozen sources, an available authorized capability can reasonably resolve it, and the answer would otherwise omit it or publish a central limitation. Select only the capabilities needed and state a precise, general research objective; do not prescribe exact Git commands or wording.",
    ...(input.researchContinuationUsed
      ? [input.attempt === 3
          ? "The one evidence continuation and one frozen repair have both been used. Do not request either again; publish only if safe, otherwise use a truthful non-publish verdict."
          : "One evidence continuation has already been used. Do not request another. Use repair if the gathered evidence can support a corrected answer; otherwise use publish_with_limitations only for a non-central irreducible boundary, or insufficient_context."]
      : []),
    "Use publish_with_limitations only when the answer is useful and grounded, the unsupported portion is not central to the request, the limitation is explicit, and none of the available authorized capabilities can reasonably resolve it in the bounded continuation. Use repair only when one bounded revision can fix grounding, relevance, completeness, continuity, or formatting using the frozen sources. Use insufficient_context only when neither the frozen catalog nor an allowed continuation can support a useful answer.",
    "Do not introduce facts, rewrite the answer, write user-facing prose, or select a preferred editorial template.",
  ].join(" ");
}

export async function verifyModelLedProjectChatAnswer(input: {
  workItemId: string;
  agentRunId: string;
  attempt: 1 | 2 | 3;
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
      schemaDescription: "A semantic publication decision for one project-chat answer.",
      jsonSchema: projectChatAnswerVerificationJsonSchema,
      maxTokens: 2_000,
      temperature: 0,
      effort: "medium",
      repairStrategy: "repair_last_failure",
      extraValidation: (value) => {
        const publishable = value.verdict === "publish" ||
          value.verdict === "publish_with_limitations";
        const continuing = value.verdict === "continue_research";
        const candidateIndexes = value.issues.flatMap((issue) =>
          issue.candidateCitationIndexes
        );
        const available = new Set(input.availableResearchCapabilities);
        return [
        ...(publishable && mechanical.issues.length
          ? ["An answer with mechanical citation errors cannot be published."]
          : []),
        ...(publishable && protocolSafety.length
          ? ["An answer exposing internal transport syntax cannot be published."]
          : []),
        ...(publishable && value.requiresProjectCitations && !referenced.size
          ? ["A project-grounded answer cannot be published without citations."]
          : []),
        ...(value.verdict === "publish" &&
        (!value.groundingSatisfied || !value.instructionSatisfied || !value.formatSatisfied)
          ? ["Publish requires grounding, instruction following, and format satisfaction."]
          : []),
        ...(value.verdict === "publish_with_limitations" &&
        (!value.groundingSatisfied || !value.formatSatisfied || !value.issues.length)
          ? ["Publish with limitations requires a grounded, correctly formatted useful answer and at least one explicit limitation."]
          : []),
        ...(continuing && input.researchContinuationUsed
          ? ["Only one evidence continuation is allowed."]
          : []),
        ...(continuing &&
        (!value.researchObjective || !value.recommendedCapabilities.length)
          ? ["Continue research requires a precise objective and at least one recommended capability."]
          : []),
        ...(!continuing &&
        (value.researchObjective !== null || value.recommendedCapabilities.length)
          ? ["Only continue research may carry a research objective or recommended capabilities."]
          : []),
        ...(value.recommendedCapabilities.some((capability) => !available.has(capability))
          ? ["Recommended research capabilities must be authorized for this turn."]
          : []),
        ...(!publishable && !value.issues.length
          ? ["A non-publish verdict must explain at least one issue."]
          : []),
        ...(candidateIndexes.some((index) => index > input.catalog.length)
          ? ["Candidate citation indexes must exist in the frozen source catalog."]
          : []),
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
    "Revise your prior answer once using only the frozen source catalog. Preserve supported useful content, but fix every issue below.",
    ...verification.mechanicalIssues.map((issue) => `- Citation integrity: ${issue}`),
    ...verification.issues.map((issue) => {
      const candidates = issue.candidateCitationIndexes.length
        ? ` Candidate citations already in the frozen catalog: ${issue.candidateCitationIndexes.map((index) => `[citation:${index}]`).join(", ")}.`
        : "";
      return `- ${issue.code}: ${issue.explanation}${candidates}`;
    }),
    "Do not call tools, search again, or introduce new sources. The frozen source catalog is the complete evidence boundary for this repair.",
    "If the available sources cannot support the requested fact, say that boundary plainly instead of guessing; that honest boundary can itself be the complete answer.",
    "Return only the revised user-facing answer.",
  ].join("\n");
}
