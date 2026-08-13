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

export const PROJECT_CHAT_ANSWER_VERIFIER_VERSION = "project-chat-answer-verifier-v6";

export const projectChatAnswerVerificationSchema = z.object({
  verdict: z.enum(["publish", "repair", "insufficient_context"]),
  requiresProjectCitations: z.boolean(),
  groundingSatisfied: z.boolean(),
  instructionSatisfied: z.boolean(),
  formatSatisfied: z.boolean(),
  issues: z.array(z.object({
    code: z.string().trim().min(1).max(100),
    explanation: z.string().trim().min(1).max(700),
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
    "issues",
  ],
  properties: {
    verdict: {
      type: "string",
      enum: ["publish", "repair", "insufficient_context"],
    },
    requiresProjectCitations: { type: "boolean" },
    groundingSatisfied: { type: "boolean" },
    instructionSatisfied: { type: "boolean" },
    formatSatisfied: { type: "boolean" },
    issues: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "explanation"],
        properties: {
          code: { type: "string", minLength: 1, maxLength: 100 },
          explanation: { type: "string", minLength: 1, maxLength: 700 },
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

export function projectChatAnswerVerificationSystemPrompt(attempt: 1 | 2 | 3) {
  return [
    "You are the bounded semantic verifier for one project-chat answer.",
    "The primary answer model—not this verifier—owns intent, structure, tool choice, and prose. Evaluate whether its answer actually satisfies the user's request and requested format without demanding a particular wording or canned structure.",
    "Check project claims only against the cited source entries. Topical similarity is not entailment. Conversation history may resolve references and requested presentation, but it is not factual project evidence.",
    "Set requiresProjectCitations true for claims about this project, its attached sources, implementation, project runtime configuration, prior tool activity, accomplishments, or stored project state. Ordinary conversational statements and clarification questions may be citation-free.",
    "A table, matrix, grid, side-by-side layout, bullets, prose, or equivalent format can satisfy the request when it expresses the requested relationships clearly. Do not require literal trigger words.",
    "Evaluate freshness semantically. If the request requires broadly synchronized reusable knowledge, require a completed durable source refresh. A bounded source search/read at an immutable current revision can satisfy a narrow current-source question without a full refresh.",
    "Do not require one citation per paragraph, bullet, table row, or other layout block. Judge whether each factual claim is supported by the citations it actually references; deterministic code validates only citation syntax, range, project scope, and internal-protocol safety.",
    ...(attempt > 1
      ? [`This is bounded revision ${attempt - 1} of at most 2. Publish when its factual claims are substantively supported by the referenced source set and the remaining concern is only redundant marker placement or another editorial nicety. Do not request another repair merely to repeat an already-referenced supporting source in every table row. Still reject any unsupported fact, unresolved contradiction, unsafe output, missing requested substance, or broken format.`]
      : []),
    "Use repair only when one bounded revision can fix grounding, relevance, completeness, continuity, or formatting using the available sources. Use insufficient_context when the source catalog cannot support the requested answer.",
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
    },
    execute: () => getStructuredLlmClient("verification").generateStructured({
      systemPrompt: projectChatAnswerVerificationSystemPrompt(input.attempt),
      userPrompt: JSON.stringify({
        request: providerSafeText(input.currentRequest),
        conversation: input.conversation.slice(-12).map((message) => ({
          ...message,
          content: providerSafeText(message.content),
        })),
        toolsUsed: input.toolNames,
        durableSourceRefreshCompleted: input.sourceRefreshCompleted,
        answer: providerSafeText(input.answer),
        mechanicalCitationIssues: mechanical.issues,
        publicationSafetyIssues: protocolSafety,
        referencedSources: referencedEntries,
        availableSourceCount: input.catalog.length,
      }),
      schema: projectChatAnswerVerificationSchema,
      schemaName: "project_chat_answer_verification",
      schemaDescription: "A semantic publication decision for one project-chat answer.",
      jsonSchema: projectChatAnswerVerificationJsonSchema,
      maxTokens: 2_000,
      temperature: 0,
      effort: "medium",
      repairStrategy: "repair_last_failure",
      extraValidation: (value) => [
        ...(value.verdict === "publish" && mechanical.issues.length
          ? ["An answer with mechanical citation errors cannot be published."]
          : []),
        ...(value.verdict === "publish" && protocolSafety.length
          ? ["An answer exposing internal transport syntax cannot be published."]
          : []),
        ...(value.verdict === "publish" && value.requiresProjectCitations && !referenced.size
          ? ["A project-grounded answer cannot be published without citations."]
          : []),
        ...(value.verdict === "publish" &&
        (!value.groundingSatisfied || !value.instructionSatisfied || !value.formatSatisfied)
          ? ["Publish requires grounding, instruction following, and format satisfaction."]
          : []),
        ...(value.verdict !== "publish" && !value.issues.length
          ? ["A non-publish verdict must explain at least one issue."]
          : []),
      ],
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
    ...verification.issues.map((issue) => `- ${issue.code}: ${issue.explanation}`),
    "Do not call tools, search again, or introduce new sources. The frozen source catalog is the complete evidence boundary for this repair.",
    "If the available sources cannot support the requested fact, say that boundary plainly instead of guessing; that honest boundary can itself be the complete answer.",
    "Return only the revised user-facing answer.",
  ].join("\n");
}
