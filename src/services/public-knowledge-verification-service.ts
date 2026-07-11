import { z } from "zod";
import type { JsonSchemaObject } from "@/src/lib/llm-json-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";

const verificationSchema = z.object({
  eligible: z.boolean(),
  correctedText: z.string().trim().min(1).max(240).nullable(),
  reasons: z.array(z.string().trim().min(2).max(500)).max(10),
  claimChecks: z.array(z.object({
    claim: z.string().trim().min(1).max(500),
    verdict: z.enum(["entailed", "partially_entailed", "unsupported", "sensitive", "ownership_gap", "scope_overclaim"]),
    evidenceIndexes: z.array(z.number().int().min(1)).max(6),
  })).max(20),
});

const verificationJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["eligible", "correctedText", "reasons", "claimChecks"],
  properties: {
    eligible: { type: "boolean" },
    correctedText: { anyOf: [{ type: "string", minLength: 1, maxLength: 240 }, { type: "null" }] },
    reasons: { type: "array", maxItems: 10, items: { type: "string", minLength: 2, maxLength: 500 } },
    claimChecks: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "verdict", "evidenceIndexes"],
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 500 },
          verdict: { type: "string", enum: ["entailed", "partially_entailed", "unsupported", "sensitive", "ownership_gap", "scope_overclaim"] },
          evidenceIndexes: { type: "array", maxItems: 6, items: { type: "integer", minimum: 1 } },
        },
      },
    },
  },
};

export async function verifyKnowledgeForPublicUse(input: {
  text: string;
  summary: string;
  confidence: "low" | "medium" | "high";
  ownershipClarity: "unclear" | "partial" | "clear";
  sensitivityFlag: boolean;
  evidence: Array<{ title: string; excerpt: string; commitSha?: string | null }>;
}) {
  const deterministicReasons: string[] = [];
  if (input.sensitivityFlag) deterministicReasons.push("The item is marked sensitive.");
  if (input.confidence === "low") deterministicReasons.push("The item has low confidence.");
  if (!input.evidence.length) deterministicReasons.push("The item has no exact supporting evidence.");
  if (input.ownershipClarity !== "clear" && /\b(?:i|my|built|implemented|designed|shipped|led|owned|created)\b/i.test(input.text)) {
    deterministicReasons.push("The wording asserts personal ownership without clear ownership evidence.");
  }
  if (deterministicReasons.length) {
    return { eligible: false, correctedText: null, reasons: deterministicReasons, claimChecks: [], tokenUsage: null };
  }
  if (resolveWorkbaseLlmProvider() === "mock") {
    return { eligible: true, correctedText: input.text, reasons: [], claimChecks: [{ claim: input.text, verdict: "entailed" as const, evidenceIndexes: [1] }], tokenUsage: null };
  }
  try {
    const result = await getBedrockStructuredLlmClient().generateStructured({
      systemPrompt: [
        "You are a fail-closed public career-content verifier.",
        "Approve only when every material claim in the text and summary is fully entailed by exact evidence, personal ownership is explicitly supported, scope is not broadened, and no sensitive information is exposed.",
        "Repository code can establish that a project implements something but cannot by itself establish who personally built, led, shipped, or measured it.",
        "Configurable defaults and conditional behavior must not be described as universal guarantees.",
        "If a narrow correction would make the item eligible, return correctedText; otherwise return null. Any uncertain verdict makes eligible false.",
      ].join(" "),
      userPrompt: JSON.stringify(input),
      schema: verificationSchema,
      schemaName: "public_knowledge_verification",
      schemaDescription: "Fail-closed entailment, ownership, sensitivity, and scope verification for public career content.",
      jsonSchema: verificationJsonSchema,
      maxTokens: 8_000,
      temperature: 0,
      effort: "high",
    });
    const eligible = result.data.eligible && result.data.claimChecks.every((check) => check.verdict === "entailed");
    return { ...result.data, eligible, tokenUsage: result.tokenUsage };
  } catch (error) {
    return {
      eligible: false,
      correctedText: null,
      reasons: [`Public verification failed closed: ${error instanceof Error ? error.message : "unknown provider error"}`],
      claimChecks: [],
      tokenUsage: null,
    };
  }
}

const artifactVerificationSchema = z.object({
  eligible: z.boolean(),
  correctedContent: z.string().trim().min(1).max(30_000).nullable(),
  reasons: z.array(z.string().trim().min(2).max(500)).max(20),
  claims: z.array(z.object({
    claim: z.string().trim().min(1).max(1_000),
    verdict: z.enum(["entailed", "partially_entailed", "unsupported", "sensitive", "ownership_gap", "scope_overclaim"]),
    sourceIndexes: z.array(z.number().int().min(1)).max(8),
  })).max(50),
});

const artifactVerificationJsonSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["eligible", "correctedContent", "reasons", "claims"],
  properties: {
    eligible: { type: "boolean" },
    correctedContent: { anyOf: [{ type: "string", minLength: 1, maxLength: 30_000 }, { type: "null" }] },
    reasons: { type: "array", maxItems: 20, items: { type: "string", minLength: 2, maxLength: 500 } },
    claims: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "verdict", "sourceIndexes"],
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 1_000 },
          verdict: { type: "string", enum: ["entailed", "partially_entailed", "unsupported", "sensitive", "ownership_gap", "scope_overclaim"] },
          sourceIndexes: { type: "array", maxItems: 8, items: { type: "integer", minimum: 1 } },
        },
      },
    },
  },
};

export async function verifyArtifactForPublicUse(input: {
  content: string;
  sources: Array<{
    kind: "highlight" | "evidence";
    title: string;
    content: string;
    ownershipClarity?: string | null;
    sensitivityFlag?: boolean;
    publicSafetyStatus?: string | null;
  }>;
}) {
  if (!input.sources.length) {
    return { eligible: false, correctedContent: null, reasons: ["The artifact has no eligible supporting sources."], claims: [], tokenUsage: null };
  }
  if (input.sources.some((source) => source.sensitivityFlag || source.publicSafetyStatus === "failed")) {
    return { eligible: false, correctedContent: null, reasons: ["At least one supporting source failed the public safety gate."], claims: [], tokenUsage: null };
  }
  if (resolveWorkbaseLlmProvider() === "mock") {
    return { eligible: true, correctedContent: input.content, reasons: [], claims: [{ claim: input.content, verdict: "entailed" as const, sourceIndexes: [1] }], tokenUsage: null };
  }
  try {
    const result = await getBedrockStructuredLlmClient().generateStructured({
      systemPrompt: [
        "You are the final fail-closed verifier for a public career artifact.",
        "Every material technical, ownership, scope, outcome, and impact claim must be fully entailed by the supplied approved sources.",
        "Remove or narrowly correct unsupported claims without adding facts. Never convert project implementation into personal ownership unless a source explicitly supports ownership.",
        "Any sensitive, partially entailed, unsupported, ownership-gap, or scope-overclaim verdict makes eligible false unless correctedContent removes the problem and every remaining claim is entailed.",
      ].join(" "),
      userPrompt: JSON.stringify(input),
      schema: artifactVerificationSchema,
      schemaName: "public_artifact_verification",
      schemaDescription: "Fail-closed claim-level verification of a public career artifact.",
      jsonSchema: artifactVerificationJsonSchema,
      maxTokens: 8_000,
      temperature: 0,
      effort: "high",
    });
    const eligible = result.data.eligible && result.data.claims.every((claim) => claim.verdict === "entailed");
    return { ...result.data, eligible, tokenUsage: result.tokenUsage };
  } catch (error) {
    return {
      eligible: false,
      correctedContent: null,
      reasons: [`Artifact verification failed closed: ${error instanceof Error ? error.message : "unknown provider error"}`],
      claims: [],
      tokenUsage: null,
    };
  }
}

export const publicKnowledgeVerificationService = {
  verify: verifyKnowledgeForPublicUse,
  verifyArtifact: verifyArtifactForPublicUse,
};
