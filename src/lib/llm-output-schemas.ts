import { z } from "zod";

const confidenceEnum = z.enum(["low", "medium", "high"]);
const ownershipClarityEnum = z.enum(["unclear", "partial", "clear"]);
const visibilityEnum = z.enum([
  "private",
  "resume_safe",
  "linkedin_safe",
  "public_safe",
]);

const evidenceSourceRefSchema = z.object({
  evidenceItemId: z.string().min(1).optional(),
  sourceId: z.string().min(1),
  sourceLabel: z.string().min(1),
  sourceType: z.enum(["manual_note", "github_repo"]),
  title: z.string().min(1).max(160).optional(),
  excerpt: z.string().min(1).max(500),
});

const evidenceSourceRefInputSchema = z.union([
  evidenceSourceRefSchema,
  z.object({
    evidenceItemId: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
  }),
  z.object({
    sourceId: z.string().min(1),
  }),
  z.string().min(1),
]);

function toTrimmedString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function toJoinedString(value: unknown) {
  if (typeof value === "string") {
    return toTrimmedString(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);

    return parts.length ? parts.join(" ") : null;
  }

  return null;
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }
  }

  return null;
}

function normalizeVisibilitySuggestion(value: unknown) {
  const text = toTrimmedString(value);

  if (!text) {
    return null;
  }

  if (text in { private: true, resume_safe: true, linkedin_safe: true, public_safe: true }) {
    return text;
  }

  const normalized = text.toLowerCase().replace(/[\s-]+/g, "_");

  if (
    normalized === "private" ||
    normalized === "resume_safe" ||
    normalized === "linkedin_safe" ||
    normalized === "public_safe"
  ) {
    return normalized;
  }

  return null;
}

function includesSensitiveSignal(value: unknown) {
  const text = toJoinedString(value);

  if (!text) {
    return false;
  }

  return /\b(sensitive|private|confidential|internal|restricted|discretion)\b/i.test(
    text,
  );
}

function normalizeVerificationItem(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const item = value as Record<string, unknown>;
  const cautions = toJoinedString(item.cautions);
  const visibilityNotes =
    toJoinedString(item.visibilityNotes) ?? toJoinedString(item.visibilitySuggestions);
  const missingInfo = toJoinedString(item.missingInfo);
  const verdict = toTrimmedString(item.verdict)?.toLowerCase();
  const explicitSensitivity = toBoolean(item.sensitivityWarning);
  const sensitivityFlagsPresent =
    Array.isArray(item.sensitivityFlags) && item.sensitivityFlags.length > 0;
  const inferredSensitivityWarning =
    sensitivityFlagsPresent ||
    includesSensitiveSignal(item.sensitivityFlags) ||
    includesSensitiveSignal(visibilityNotes) ||
    includesSensitiveSignal(cautions);
  const sensitivityWarning = explicitSensitivity ?? inferredSensitivityWarning;
  const inferredOverstatementWarning =
    /\b(overstate|overreach|sole authorship|single-handed|ownership)\b/i.test(
      `${cautions ?? ""} ${missingInfo ?? ""}`,
    );
  const overstatementWarning =
    toBoolean(item.overstatementWarning) ?? inferredOverstatementWarning;
  const inferredUnsupportedImpactWarning =
    /\b(impact|corroborat|evidence|confirm|unverified|unsupported)\b/i.test(
      `${cautions ?? ""} ${missingInfo ?? ""}`,
    );
  const unsupportedImpactWarning =
    toBoolean(item.unsupportedImpactWarning) ?? inferredUnsupportedImpactWarning;
  const inferredShouldFlag =
    verdict === "needs_revision" ||
    verdict === "flagged" ||
    verdict === "unsupported" ||
    sensitivityWarning ||
    overstatementWarning ||
    unsupportedImpactWarning;
  const shouldFlag =
    toBoolean(item.shouldFlag) ?? inferredShouldFlag;
  const visibilitySuggestion =
    normalizeVisibilitySuggestion(item.visibilitySuggestion) ??
    normalizeVisibilitySuggestion(
      Array.isArray(item.visibilitySuggestions) ? item.visibilitySuggestions[0] : null,
    ) ??
    (sensitivityWarning ? "private" : "resume_safe");

  return {
    ...item,
    revisedText:
      toTrimmedString(item.revisedText) ??
      toTrimmedString(item.suggestedWording) ??
      toTrimmedString(item.suggestedRevision) ??
      toTrimmedString(item.text),
    visibilitySuggestion,
    sensitivityWarning,
    shouldFlag,
    overstatementWarning,
    unsupportedImpactWarning,
    rationaleSummary:
      toTrimmedString(item.rationaleSummary) ??
      toTrimmedString(item.verifierNotes) ??
      toTrimmedString(item.notes) ??
      toTrimmedString(item.summary) ??
      cautions ??
      "Review this claim against the supporting evidence before approval.",
    risksSummary:
      toTrimmedString(item.risksSummary) ??
      cautions ??
      toJoinedString(item.sensitivityFlags),
    missingInfo,
    verificationNotes: (() => {
      const directNotes = toTrimmedString(item.verificationNotes);

      if (directNotes) {
        return directNotes;
      }

      const combinedNotes = [visibilityNotes, cautions, toJoinedString(item.sensitivityFlags)]
        .filter(Boolean)
        .join(" ")
        .trim();

      return combinedNotes || null;
    })(),
  };
}

function normalizeClusterItem(value: unknown) {
  if (typeof value === "string") {
    const evidenceItemId = toTrimmedString(value);

    return evidenceItemId ? { evidenceItemId } : value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const item = value as Record<string, unknown>;

  return {
    ...item,
    evidenceItemId:
      toTrimmedString(item.evidenceItemId) ??
      toTrimmedString(item.id) ??
      toTrimmedString(item.evidenceId),
  };
}

function buildClaimResearchLlmOutputSchema(params: {
  minClaims: number;
  maxClaims: number;
}) {
  return z.preprocess(
    (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }

      const input = value as Record<string, unknown>;

      return {
        ...input,
        claims: Array.isArray(input.claims)
          ? input.claims.map((claim) => {
              if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
                return claim;
              }

              const claimRecord = claim as Record<string, unknown>;

              return {
                ...claimRecord,
                claimText:
                  toTrimmedString(claimRecord.claimText) ??
                  toTrimmedString(claimRecord.claim) ??
                  toTrimmedString(claimRecord.text),
                confidence: toTrimmedString(claimRecord.confidence)?.toLowerCase(),
                ownershipClarity: toTrimmedString(claimRecord.ownershipClarity)?.toLowerCase(),
                evidenceSummary: toTrimmedString(claimRecord.evidenceSummary),
                rationaleSummary: toTrimmedString(claimRecord.rationaleSummary),
                sourceRefs: Array.isArray(claimRecord.sourceRefs)
                  ? claimRecord.sourceRefs
                  : Array.isArray(claimRecord.evidenceRefs)
                    ? claimRecord.evidenceRefs
                    : claimRecord.sourceRefs,
              };
            })
          : input.claims,
      };
    },
    z.object({
      claims: z
        .array(
          z.object({
            claimText: z.string().min(10).max(240),
            category: z.string().trim().min(1).max(64),
            confidence: confidenceEnum,
            ownershipClarity: ownershipClarityEnum,
            evidenceSummary: z.string().min(16).max(500),
            rationaleSummary: z.string().min(16).max(500),
            risksSummary: z.string().trim().max(500).nullable(),
            missingInfo: z.string().trim().max(500).nullable(),
            sourceRefs: z.array(evidenceSourceRefInputSchema).min(1).max(4),
          }),
        )
        .min(params.minClaims)
        .max(params.maxClaims),
    }),
  );
}

export const claimResearchLlmOutputSchema = buildClaimResearchLlmOutputSchema({
  minClaims: 1,
  maxClaims: 6,
});

export const clusterClaimResearchLlmOutputSchema = buildClaimResearchLlmOutputSchema({
  minClaims: 0,
  maxClaims: 2,
});

export const claimVerificationLlmOutputSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const input = value as Record<string, unknown>;
    const results = Array.isArray(input.results)
      ? input.results
      : Array.isArray(input.verificationResults)
        ? input.verificationResults
        : input.results;

    return {
      ...input,
      results: Array.isArray(results)
        ? results.map((item, index) => {
            const normalized = normalizeVerificationItem(item);

            if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
              return normalized;
            }

            const normalizedRecord = normalized as Record<string, unknown>;

            return {
              ...normalizedRecord,
              claimIndex:
                typeof normalizedRecord.claimIndex === "number"
                  ? normalizedRecord.claimIndex
                  : index,
            };
          })
        : results,
    };
  },
  z.object({
    results: z.array(
      z.object({
        claimIndex: z.number().int().nonnegative(),
        revisedText: z.string().trim().max(500).nullable().optional(),
        confidence: confidenceEnum,
        ownershipClarity: ownershipClarityEnum,
        visibilitySuggestion: visibilityEnum,
        sensitivityWarning: z.boolean(),
        shouldFlag: z.boolean(),
        overstatementWarning: z.boolean(),
        unsupportedImpactWarning: z.boolean(),
        rationaleSummary: z.string().min(16).max(500),
        risksSummary: z.string().trim().max(500).nullable().optional(),
        missingInfo: z.string().trim().max(500).nullable().optional(),
        verificationNotes: z.string().trim().max(1200).nullable().optional(),
      }),
    ),
  }),
);

export const artifactGenerationLlmOutputSchema = z.object({
  content: z.string().min(20).max(4000),
  usedClaimIds: z.array(z.string().min(1)).min(1).max(3),
});

export const evidenceClusteringLlmOutputSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    const input = value as Record<string, unknown>;

    return {
      ...input,
      clusters: Array.isArray(input.clusters)
        ? input.clusters.map((cluster) => {
            if (!cluster || typeof cluster !== "object" || Array.isArray(cluster)) {
              return cluster;
            }

            const clusterRecord = cluster as Record<string, unknown>;

            return {
              ...clusterRecord,
              items: Array.isArray(clusterRecord.items)
                ? clusterRecord.items.map(normalizeClusterItem)
                : clusterRecord.items,
            };
          })
        : input.clusters,
    };
  },
  z.object({
    clusters: z
      .array(
        z.object({
          title: z.string().min(3).max(120),
          summary: z.string().min(16).max(500),
          theme: z.string().min(2).max(80),
          confidence: confidenceEnum,
          metadata: z.record(z.string(), z.unknown()).nullable().optional(),
          items: z
            .array(
              z.object({
                evidenceItemId: z.string().min(1),
                relevanceScore: z.number().min(0).max(1).nullable().optional(),
              }),
            )
            .min(1),
        }),
      )
      .min(1)
      .max(8),
  }),
);
