import { z } from "zod";
import type { GroundedAnswerBlock, ProjectResearchDossier } from "@/src/domain/project-chat";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { CitationIntegrityError } from "@/src/services/chat-citation-service";
import { repositoryFreshnessFromDossier } from "@/src/services/project-research-dossier-service";

const groundingSchema = z.object({
  blocks: z.array(z.object({
    heading: z.string().trim().min(1).max(200).nullable(),
    bodyMarkdown: z.string().trim().min(1).max(2_000),
    citationIndexes: z.array(z.number().int().min(1)).min(1).max(6),
  })).min(1).max(40),
  issues: z.array(z.object({
    claim: z.string().trim().min(1).max(500),
    verdict: z.enum(["partially_entailed", "unsupported", "conflicted", "freshness_mismatch", "scope_overclaim"]),
    correction: z.string().trim().min(1).max(800),
  })).max(20),
});

const groundingJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["blocks", "issues"],
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "bodyMarkdown", "citationIndexes"],
        properties: {
          heading: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "null" }] },
          bodyMarkdown: { type: "string", minLength: 1, maxLength: 2_000 },
          citationIndexes: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    issues: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "verdict", "correction"],
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 500 },
          verdict: {
            type: "string",
            enum: ["partially_entailed", "unsupported", "conflicted", "freshness_mismatch", "scope_overclaim"],
          },
          correction: { type: "string", minLength: 1, maxLength: 800 },
        },
      },
    },
  },
};

export interface ProjectAnswerGroundingEntry {
  kind: string;
  authority: string;
  title: string;
  content: string;
  currentRun: boolean;
  citationIndexes: number[];
  supportingSources: Array<{
    type: string;
    title: string;
    path?: string;
    commitSha?: string;
  }>;
}

function dateLabels(value: string | null) {
  if (!value) return [];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return [];
  return [
    value.slice(0, 10),
    new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date),
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date),
  ];
}

export function detectGroundingContractIssues(input: {
  answer: string;
  citationCount: number;
  dossier?: ProjectResearchDossier | null;
}) {
  const issues: string[] = [];
  const markers = Array.from(input.answer.matchAll(/\[citation:(\d+)\]/g));
  for (const marker of markers) {
    const ordinal = Number(marker[1]);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > input.citationCount) {
      issues.push(`The answer references unavailable citation ${marker[0]}.`);
    }
  }

  const freshness = repositoryFreshnessFromDossier(input.dossier ?? null);
  if (freshness.latestRepositoryInspectedAt) {
    for (const importedLabel of dateLabels(freshness.latestSourceImportedAt)) {
      if (input.answer.toLowerCase().includes(`as of ${importedLabel.toLowerCase()}`)) {
        issues.push("The answer labels the source import date as current even though a newer repository inspection exists.");
        break;
      }
    }
  }
  return Array.from(new Set(issues));
}

export function extractClaimCitationMap(answer: string) {
  return answer
    .split(/\n{2,}|\n(?=[-*#])/)
    .flatMap((segment) => {
      const citationIndexes = Array.from(segment.matchAll(/\[citation:(\d+)\]/g))
        .map((match) => Number(match[1]))
        .filter((index) => Number.isInteger(index) && index > 0);
      const claim = segment
        .replace(/\[citation:\d+\]/g, "")
        .replace(/^[-*#\s]+/, "")
        .replace(/\s+([,.;:!?])/g, "$1")
        .trim();
      return claim && citationIndexes.length
        ? [{ claim, citationIndexes: Array.from(new Set(citationIndexes)) }]
        : [];
    });
}

function mockGroundedBlocks(answer: string, citationCount: number): GroundedAnswerBlock[] {
  return answer
    .split(/\n{2,}/)
    .flatMap((segment) => {
      const citationIndexes = Array.from(segment.matchAll(/\[citation:(\d+)\]/gi))
        .map((match) => Number(match[1]))
        .filter((index) => Number.isInteger(index) && index > 0 && index <= citationCount);
      const withoutMarkers = segment.replace(/\[citation:\d+\]/gi, "").trim();
      if (!withoutMarkers || !citationIndexes.length) return [];
      const lines = withoutMarkers.split("\n");
      const first = lines[0]?.match(/^#{1,6}\s+(.+)$/);
      return [{
        heading: first?.[1]?.trim() ?? null,
        bodyMarkdown: (first ? lines.slice(1).join("\n") : withoutMarkers).trim(),
        citationIndexes: Array.from(new Set(citationIndexes)),
      }];
    })
    .filter((block) => Boolean(block.bodyMarkdown));
}

export async function groundProjectAnswer(input: {
  answer: string;
  entries: ProjectAnswerGroundingEntry[];
  citationCount: number;
  dossier?: ProjectResearchDossier | null;
}) {
  const contractIssues = detectGroundingContractIssues(input);
  if (resolveWorkbaseLlmProvider() === "mock") {
    const blocks = mockGroundedBlocks(input.answer, input.citationCount);
    if (!blocks.length) throw new CitationIntegrityError("The mock grounding verifier found no supported cited blocks.");
    return {
      blocks,
      issues: contractIssues,
      tokenUsage: null,
    };
  }

  const freshness = repositoryFreshnessFromDossier(input.dossier ?? null);
  const result = await getBedrockStructuredLlmClient().generateStructured({
      systemPrompt: [
        "You verify a citation-backed Workbase project answer before it is shown to the user.",
        "Check each factual project claim against only the source entry referenced by a [citation:N] marker in that claim or paragraph.",
        "Topical similarity is not entailment. Narrow configurable defaults, conditional behavior, and inferred intent instead of turning them into universal guarantees.",
        "Return supported factual units as structured blocks. Do not include [citation:N], [N], footnotes, or any other citation syntax in heading or bodyMarkdown; use citationIndexes only.",
        "Do not introduce new facts or citation indexes. Remove claims that cannot be supported.",
        "Keep useful Markdown such as emphasis, inline code, lists, and short paragraphs inside bodyMarkdown, but each block must remain one independently supported factual unit.",
        "For repository freshness, current-through means the pinned commit or inspection time. Never present an older source-import time as the current-through date.",
        "If research is partial, do not describe representative coverage as exhaustive and retain a concise coverage limitation when material.",
      ].join(" "),
      userPrompt: JSON.stringify({
        answer: input.answer,
        sources: input.entries,
        freshness,
        research: input.dossier ? {
          partial: input.dossier.partial,
          coverage: input.dossier.coverage,
          coverageGaps: input.dossier.coverageGaps,
        } : null,
        deterministicContractIssues: contractIssues,
      }),
      schema: groundingSchema,
      schemaName: "project_answer_grounding",
      schemaDescription: "Supported Markdown answer blocks whose claims are entailed by their cited project sources.",
      jsonSchema: groundingJsonSchema,
      maxTokens: 8_000,
      temperature: 0,
      effort: "high",
      extraValidation: (value) => value.blocks.flatMap((block, index) => {
        const errors: string[] = [];
        if (/\[citation:\d+\]/i.test(block.bodyMarkdown) || /\[\d+\](?:\s*\[\d+\])*/.test(block.bodyMarkdown)) {
          errors.push(`Block ${index + 1} must use citationIndexes instead of citation marker text.`);
        }
        if (block.heading && (/\[citation:\d+\]/i.test(block.heading) || /\[\d+\]/.test(block.heading))) {
          errors.push(`Heading ${index + 1} must not contain citation marker text.`);
        }
        if (block.citationIndexes.some((citationIndex) => citationIndex > input.citationCount)) {
          errors.push(`Block ${index + 1} references an unavailable citation index.`);
        }
        return errors;
      }),
    });
  if (!result.data.blocks.length) throw new CitationIntegrityError("The grounding verifier returned no supported blocks.");
  return {
    blocks: result.data.blocks,
    issues: [
      ...contractIssues,
      ...result.data.issues.map((issue) => `${issue.verdict}: ${issue.claim} — ${issue.correction}`),
    ],
    tokenUsage: result.tokenUsage,
  };
}
