import type { JsonValue } from "@/src/domain/types";

export type JsonSchemaObject = Record<string, unknown>;

export const structuredOutputTransportModes = [
  "json_schema",
  "bedrock_json_schema",
  "strict_tool_use",
  "text_repair_fallback",
] as const;

export type StructuredOutputTransportMode =
  (typeof structuredOutputTransportModes)[number];

function sanitizeConstraintLimitedJsonSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeConstraintLimitedJsonSchemaNode);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const objectValue = value as Record<string, unknown>;
  const sanitizedEntries = Object.entries(objectValue).flatMap(([key, nestedValue]) => {
    if (objectValue.type === "array" && key === "maxItems") {
      return [];
    }

    if (
      objectValue.type === "array" &&
      key === "minItems" &&
      nestedValue !== 0 &&
      nestedValue !== 1
    ) {
      return [];
    }

    if (
      objectValue.type === "string" &&
      (key === "minLength" || key === "maxLength")
    ) {
      return [];
    }

    if (
      (objectValue.type === "integer" || objectValue.type === "number") &&
      ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].includes(
        key,
      )
    ) {
      return [];
    }

    return [[key, sanitizeConstraintLimitedJsonSchemaNode(nestedValue)]];
  });

  return Object.fromEntries(sanitizedEntries);
}

export function toBedrockCompatibleJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
  return sanitizeConstraintLimitedJsonSchemaNode(schema) as JsonSchemaObject;
}

/**
 * Anthropic's strict structured-output transports reject the same constraint
 * keywords stripped for Bedrock. The complete schema still reaches Workbase's
 * Zod and extra-validation layers after generation; only the provider request
 * uses this constraint-compatible copy.
 */
export function toAnthropicCompatibleJsonSchema(
  schema: JsonSchemaObject,
): JsonSchemaObject {
  return sanitizeConstraintLimitedJsonSchemaNode(schema) as JsonSchemaObject;
}

const nullableString = (maxLength: number): JsonSchemaObject => ({
  anyOf: [
    {
      type: "string",
      maxLength,
    },
    {
      type: "null",
    },
  ],
});

const claimCategoryEnum = [
  "general",
  "ai_ml",
  "data_engineering",
  "backend",
  "full_stack",
] as const;

const confidenceEnum = ["low", "medium", "high"] as const;
const ownershipClarityEnum = ["unclear", "partial", "clear"] as const;
const visibilityEnum = [
  "private",
  "resume_safe",
  "linkedin_safe",
  "public_safe",
] as const;

export function buildHighlightGenerationJsonSchema(params: {
  minHighlights: number;
  maxHighlights: number;
}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["highlights"],
    properties: {
      highlights: {
        type: "array",
        minItems: params.minHighlights,
        maxItems: params.maxHighlights,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "text",
            "category",
            "confidence",
            "ownershipClarity",
            "summary",
            "rationaleSummary",
            "sourceRefs",
            "risksSummary",
            "missingInfo",
          ],
          properties: {
            text: {
              type: "string",
              minLength: 10,
              maxLength: 240,
            },
            category: {
              type: "string",
              enum: [...claimCategoryEnum],
            },
            confidence: {
              type: "string",
              enum: [...confidenceEnum],
            },
            ownershipClarity: {
              type: "string",
              enum: [...ownershipClarityEnum],
            },
            summary: {
              type: "string",
              minLength: 16,
              maxLength: 500,
            },
            rationaleSummary: {
              type: "string",
              minLength: 16,
              maxLength: 500,
            },
            risksSummary: nullableString(500),
            missingInfo: nullableString(500),
            sourceRefs: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["evidenceItemId"],
                properties: {
                  evidenceItemId: {
                    type: "string",
                    minLength: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
  } satisfies JsonSchemaObject;
}

export const highlightGenerationSchemaName = "workbase_highlight_generation";
export const highlightGenerationSchemaDescription =
  "Structured reusable Workbase highlights grounded in provided evidence references.";
export const highlightGenerationExampleOutput = {
  highlights: [
    {
      text:
        "Implemented a trainable feed ranking model using investor interaction signals.",
      category: "ai_ml",
      confidence: "high",
      ownershipClarity: "partial",
      summary:
        "README and commit evidence point to logistic regression feed ranking and investor-interaction training data.",
      rationaleSummary:
        "The evidence explicitly references the ranking model, training pipeline, and behavioral signals without claiming unsupported impact.",
      risksSummary:
        "Clarify whether model design decisions were made independently or in collaboration.",
      missingInfo: null,
      sourceRefs: [
        {
          evidenceItemId: "ev_01",
        },
        {
          evidenceItemId: "ev_02",
        },
      ],
    },
  ],
} satisfies JsonValue;
export const highlightGenerationRequiredFields = [
  "highlights",
  "highlights[].text",
  "highlights[].category",
  "highlights[].confidence",
  "highlights[].ownershipClarity",
  "highlights[].summary",
  "highlights[].rationaleSummary",
  "highlights[].sourceRefs",
  "highlights[].risksSummary",
  "highlights[].missingInfo",
] as const;
export const highlightGenerationRepairMappings = [
  "Map claimText, title, claim, or highlightText to text.",
  "Map evidenceRefs to sourceRefs.",
  "Map evidenceSummary or description to summary only if summary is missing.",
  "Do not invent missing text, summary, or rationaleSummary. If they cannot be recovered from the original output, keep the repair faithful and let validation fail.",
] as const;

export const claimVerificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "claimIndex",
          "revisedText",
          "confidence",
          "ownershipClarity",
          "visibilitySuggestion",
          "sensitivityWarning",
          "shouldFlag",
          "overstatementWarning",
          "unsupportedImpactWarning",
          "rationaleSummary",
          "risksSummary",
          "missingInfo",
          "verificationNotes",
        ],
        properties: {
          claimIndex: {
            type: "integer",
            minimum: 0,
          },
          revisedText: nullableString(240),
          confidence: {
            type: "string",
            enum: [...confidenceEnum],
          },
          ownershipClarity: {
            type: "string",
            enum: [...ownershipClarityEnum],
          },
          visibilitySuggestion: {
            type: "string",
            enum: [...visibilityEnum],
          },
          sensitivityWarning: {
            type: "boolean",
          },
          shouldFlag: {
            type: "boolean",
          },
          overstatementWarning: {
            type: "boolean",
          },
          unsupportedImpactWarning: {
            type: "boolean",
          },
          rationaleSummary: {
            type: "string",
            minLength: 16,
            maxLength: 500,
          },
          risksSummary: nullableString(500),
          missingInfo: nullableString(500),
          verificationNotes: nullableString(1200),
        },
      },
    },
  },
} satisfies JsonSchemaObject;

export const claimVerificationSchemaName = "workbase_claim_verification";
export const claimVerificationSchemaDescription =
  "Structured verification decisions for Workbase candidate claims.";
export const claimVerificationExampleOutput = {
  results: [
    {
      claimIndex: 0,
      revisedText:
        "Implemented a trainable feed ranking model using investor interaction signals.",
      confidence: "medium",
      ownershipClarity: "partial",
      visibilitySuggestion: "resume_safe",
      sensitivityWarning: false,
      shouldFlag: false,
      overstatementWarning: false,
      unsupportedImpactWarning: false,
      rationaleSummary:
        "The cited evidence supports the technical implementation and avoids unsupported impact claims.",
      risksSummary:
        "Ownership should remain partial unless independent architectural ownership is documented.",
      missingInfo: null,
      verificationNotes:
        "Use this wording only if the candidate can explain the training pipeline and ranking signals in detail.",
    },
  ],
} satisfies JsonValue;
export const claimVerificationRequiredFields = [
  "results",
  "results[].claimIndex",
  "results[].revisedText",
  "results[].confidence",
  "results[].ownershipClarity",
  "results[].visibilitySuggestion",
  "results[].sensitivityWarning",
  "results[].shouldFlag",
  "results[].overstatementWarning",
  "results[].unsupportedImpactWarning",
  "results[].rationaleSummary",
  "results[].risksSummary",
  "results[].missingInfo",
  "results[].verificationNotes",
] as const;
export const claimVerificationRepairMappings = [
  "Map verdict, cautions, verifierNotes, suggestedRevision, and visibilitySuggestions into the required verification fields when directly recoverable.",
  "Do not fabricate claimIndex values beyond the original ordering.",
] as const;

export const artifactGenerationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "usedHighlightIds", "supportingEvidenceItemIds"],
  properties: {
    content: {
      type: "string",
      minLength: 20,
      maxLength: 4000,
    },
    usedHighlightIds: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "string",
        minLength: 1,
      },
    },
    supportingEvidenceItemIds: {
      type: "array",
      minItems: 0,
      maxItems: 0,
      items: {
        type: "string",
        minLength: 1,
      },
    },
  },
} satisfies JsonSchemaObject;

export const artifactGenerationSchemaName = "workbase_artifact_generation";
export const artifactGenerationSchemaDescription =
  "Structured artifact draft grounded only in approved Workbase highlights; exact evidence provenance is derived outside the model.";
export const artifactGenerationExampleOutput = {
  content:
    "- Implemented a trainable feed ranking model using investor interaction signals and deterministic fallbacks.",
  usedHighlightIds: ["highlight-01"],
  supportingEvidenceItemIds: [],
} satisfies JsonValue;
export const artifactGenerationRequiredFields = [
  "content",
  "usedHighlightIds",
  "supportingEvidenceItemIds",
] as const;
