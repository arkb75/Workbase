import type { JsonValue } from "@/src/domain/types";

export type JsonSchemaObject = Record<string, unknown>;

export const structuredOutputTransportModes = [
  "bedrock_json_schema",
  "strict_tool_use",
  "text_repair_fallback",
] as const;

export type StructuredOutputTransportMode =
  (typeof structuredOutputTransportModes)[number];

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

export function buildClaimResearchJsonSchema(params: {
  minClaims: number;
  maxClaims: number;
}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        minItems: params.minClaims,
        maxItems: params.maxClaims,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "claimText",
            "category",
            "confidence",
            "ownershipClarity",
            "evidenceSummary",
            "rationaleSummary",
            "sourceRefs",
            "risksSummary",
            "missingInfo",
          ],
          properties: {
            claimText: {
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
            evidenceSummary: {
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

export const claimResearchSchemaName = "workbase_claim_research";
export const claimResearchSchemaDescription =
  "Structured Workbase claim drafts grounded in provided evidence references.";
export const claimResearchExampleOutput = {
  claims: [
    {
      claimText:
        "Implemented a trainable feed ranking model using investor interaction signals.",
      category: "ai_ml",
      confidence: "high",
      ownershipClarity: "partial",
      evidenceSummary:
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
export const claimResearchRequiredFields = [
  "claims",
  "claims[].claimText",
  "claims[].category",
  "claims[].confidence",
  "claims[].ownershipClarity",
  "claims[].evidenceSummary",
  "claims[].rationaleSummary",
  "claims[].sourceRefs",
  "claims[].risksSummary",
  "claims[].missingInfo",
] as const;
export const claimResearchRepairMappings = [
  "Map title, claim, or text to claimText.",
  "Map evidenceRefs to sourceRefs.",
  "If description contains evidence grounding and evidenceSummary is missing, map description to evidenceSummary.",
  "Do not invent missing claimText, evidenceSummary, or rationaleSummary. If they cannot be recovered from the original output, keep the repair faithful and let validation fail.",
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

export const evidenceClusteringJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["clusters"],
  properties: {
    clusters: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "theme", "confidence", "metadata", "items"],
        properties: {
          title: {
            type: "string",
            minLength: 3,
            maxLength: 120,
          },
          summary: {
            type: "string",
            minLength: 16,
            maxLength: 500,
          },
          theme: {
            type: "string",
            minLength: 2,
            maxLength: 80,
          },
          confidence: {
            type: "string",
            enum: [...confidenceEnum],
          },
          metadata: {
            anyOf: [
              {
                type: "object",
              },
              {
                type: "null",
              },
            ],
          },
          items: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["evidenceItemId", "relevanceScore"],
              properties: {
                evidenceItemId: {
                  type: "string",
                  minLength: 1,
                },
                relevanceScore: {
                  anyOf: [
                    {
                      type: "number",
                      minimum: 0,
                      maximum: 1,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies JsonSchemaObject;

export const evidenceClusteringSchemaName = "workbase_evidence_clustering";
export const evidenceClusteringSchemaDescription =
  "Clustered Workbase evidence grouped into coherent technical work themes.";
export const evidenceClusteringExampleOutput = {
  clusters: [
    {
      title: "Feed ranking and event signals",
      summary:
        "Feed ranking model work grouped with the event logging and training pipeline evidence that supports it.",
      theme: "ML ranking and event instrumentation",
      confidence: "high",
      metadata: {
        strategy: "theme_grouping",
      },
      items: [
        {
          evidenceItemId: "ev_01",
          relevanceScore: 0.98,
        },
        {
          evidenceItemId: "ev_02",
          relevanceScore: 0.92,
        },
      ],
    },
  ],
} satisfies JsonValue;
export const evidenceClusteringRequiredFields = [
  "clusters",
  "clusters[].title",
  "clusters[].summary",
  "clusters[].theme",
  "clusters[].confidence",
  "clusters[].metadata",
  "clusters[].items",
  "clusters[].items[].evidenceItemId",
  "clusters[].items[].relevanceScore",
] as const;

export const artifactGenerationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["content", "usedClaimIds"],
  properties: {
    content: {
      type: "string",
      minLength: 20,
      maxLength: 4000,
    },
    usedClaimIds: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "string",
        minLength: 1,
      },
    },
  },
} satisfies JsonSchemaObject;

export const artifactGenerationSchemaName = "workbase_artifact_generation";
export const artifactGenerationSchemaDescription =
  "Structured artifact draft content grounded only in approved Workbase claims.";
export const artifactGenerationExampleOutput = {
  content:
    "- Implemented a trainable feed ranking model using investor interaction signals and deterministic fallbacks.",
  usedClaimIds: ["claim-01"],
} satisfies JsonValue;
export const artifactGenerationRequiredFields = [
  "content",
  "usedClaimIds",
] as const;
