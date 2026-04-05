import type { Prisma } from "@/src/generated/prisma/client";
import type {
  JsonValue,
  NormalizedEvidenceItem,
} from "@/src/domain/types";
import { attachGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { createGenerationRun } from "@/src/lib/generation-runs";
import { claimVerificationLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import {
  claimVerificationExampleOutput,
  claimVerificationJsonSchema,
  claimVerificationRepairMappings,
  claimVerificationRequiredFields,
  claimVerificationSchemaDescription,
  claimVerificationSchemaName,
} from "@/src/lib/llm-json-schemas";
import { formatTaggedSections } from "@/src/lib/structured-prompt";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import { toSentence } from "@/src/lib/utils";
import type { ClaimVerificationService } from "@/src/services/types";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockClaimVerificationService } from "@/src/services/mock-claim-verification-service";

function isRejectedGuidanceSource(source: NormalizedEvidenceItem) {
  return (
    typeof source.metadata === "object" &&
    source.metadata &&
    "kind" in source.metadata &&
    source.metadata.kind === "rejected_claim_context"
  );
}

function downgradeConfidence(value: "low" | "medium" | "high") {
  if (value === "high") {
    return "medium" as const;
  }

  return "low" as const;
}

function resolveVerifiedClaimText(originalText: string, revisedText: string | null | undefined) {
  const candidate = toSentence(revisedText ?? "").trim();

  if (!candidate) {
    return toSentence(originalText);
  }

  if (candidate.length > 240) {
    return toSentence(originalText);
  }

  if (/^(consider|suggest|recommend|if\s)/i.test(candidate)) {
    return toSentence(originalText);
  }

  return candidate;
}

function buildVerificationInputSummary(params: {
  workItemId: string;
  workItemTitle: string;
  systemPrompt: string;
  userPrompt: string;
  claimCount: number;
  clusterCount: number;
  evidenceCount: number;
  transportMode?: string | null;
  attempts?: JsonValue | null;
}) {
  return {
    workItemId: params.workItemId,
    workItemTitle: params.workItemTitle,
    claimCount: params.claimCount,
    clusterCount: params.clusterCount,
    evidenceCount: params.evidenceCount,
    transportMode: params.transportMode ?? null,
    transportAttempts: params.attempts ?? null,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  };
}

const bedrockClaimVerificationService: ClaimVerificationService = {
  async verify({ workItem, evidenceItems, clusters, claims }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const rejectedGuidance = evidenceItems
      .filter(isRejectedGuidanceSource)
      .map((source) => source.body)
      .join("\n\n");
    const supportingEvidence = evidenceItems
      .filter((source) => !isRejectedGuidanceSource(source))
      .map((source) => ({
        evidenceItemId: source.id,
        sourceId: source.sourceId,
        sourceLabel:
          typeof source.metadata === "object" &&
          source.metadata &&
          "sourceLabel" in source.metadata &&
          typeof source.metadata.sourceLabel === "string"
            ? source.metadata.sourceLabel
            : source.label,
        title: source.label,
        sourceType: source.type,
        evidenceType: source.evidenceType,
        excerpts: source.excerpts.length ? source.excerpts : [source.body],
      }));
    const systemPrompt = [
      "You verify Workbase candidate claims against provided evidence.",
      "Return JSON that matches the provided schema exactly.",
      "Do not decide final application rules such as artifact eligibility or state transitions.",
    ].join(" ");
    const userPrompt = formatTaggedSections([
      {
        tag: "task",
        content:
          "Review each candidate claim and return exactly one verification result per claim.",
      },
      {
        tag: "rules",
        content: [
          "Return a top-level JSON object with a `results` array.",
          "Each result object must include exactly these fields: claimIndex, revisedText, confidence, ownershipClarity, visibilitySuggestion, sensitivityWarning, shouldFlag, overstatementWarning, unsupportedImpactWarning, rationaleSummary, risksSummary, missingInfo, verificationNotes.",
          "Preserve one result per input claim in the same indexing space.",
          "Use null for revisedText, risksSummary, missingInfo, or verificationNotes only when the field should be empty.",
        ].join("\n"),
      },
      {
        tag: "output_schema",
        content: JSON.stringify(claimVerificationJsonSchema, null, 2),
      },
      {
        tag: "required_fields",
        content: JSON.stringify(claimVerificationRequiredFields, null, 2),
      },
      {
        tag: "example_output",
        content: JSON.stringify(claimVerificationExampleOutput, null, 2),
      },
      {
        tag: "work_item",
        content: JSON.stringify(
          {
            id: workItem.id,
            title: workItem.title,
            type: workItem.type,
            description: workItem.description,
          },
          null,
          2,
        ),
      },
      {
        tag: "clusters",
        content: JSON.stringify(
          clusters.map((cluster) => ({
            clusterId: cluster.id,
            title: cluster.title,
            summary: cluster.summary,
            theme: cluster.theme,
            confidence: cluster.confidence,
            evidenceItemIds: cluster.items.map((item) => item.evidenceItemId),
          })),
          null,
          2,
        ),
      },
      {
        tag: "rejected_claim_guidance",
        content: rejectedGuidance || "null",
      },
      {
        tag: "evidence_items",
        content: JSON.stringify(supportingEvidence, null, 2),
      },
      {
        tag: "claims",
        content: JSON.stringify(
          claims.map((claim, index) => ({
            claimIndex: index,
            text: claim.text,
            category: claim.category,
            confidence: claim.confidence,
            ownershipClarity: claim.ownershipClarity,
            evidenceSummary: claim.evidenceCard.evidenceSummary,
            rationaleSummary: claim.evidenceCard.rationaleSummary,
            sourceRefs: claim.evidenceCard.sourceRefs,
            risksSummary: claim.risksSummary,
            missingInfo: claim.missingInfo,
          })),
          null,
          2,
        ),
      },
    ]);
    const baseInputSummary = buildVerificationInputSummary({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      systemPrompt,
      userPrompt,
      claimCount: claims.length,
      clusterCount: clusters.length,
      evidenceCount: supportingEvidence.length,
    });

    try {
      const result = await structuredClient.generateStructured({
        systemPrompt,
        userPrompt,
        schema: claimVerificationLlmOutputSchema,
        schemaName: claimVerificationSchemaName,
        schemaDescription: claimVerificationSchemaDescription,
        jsonSchema: claimVerificationJsonSchema,
        exampleOutput: claimVerificationExampleOutput,
        requiredFieldPaths: claimVerificationRequiredFields,
        repairMappings: claimVerificationRepairMappings,
        maxTokens: 2600,
        extraValidation: (value) => {
          const errors: string[] = [];
          const seenIndexes = new Set<number>();

          if (value.results.length !== claims.length) {
            errors.push("Verification output must include exactly one result per input claim.");
          }

          value.results.forEach((item, index) => {
            if (item.claimIndex < 0 || item.claimIndex >= claims.length) {
              errors.push(`results[${index}] has an out-of-range claimIndex.`);
            }

            if (seenIndexes.has(item.claimIndex)) {
              errors.push(`results[${index}] repeats claimIndex ${item.claimIndex}.`);
            }

            seenIndexes.add(item.claimIndex);
          });

          return errors;
        },
      });

      const sourceMentionsSensitivity = supportingEvidence.some((item) =>
        item.excerpts.some((excerpt) =>
          /sensitive|confidential|internal|private dataset|customer/i.test(excerpt),
        ),
      );

      const verifiedClaims = claims.map((claim, index) => {
        const verification = result.data.results.find(
          (item) => item.claimIndex === index,
        );

        if (!verification) {
          return claim;
        }

        const risks = [claim.risksSummary, verification.risksSummary].filter(Boolean);
        let verificationStatus = claim.verificationStatus;
        let visibility = verification.visibilitySuggestion;
        const sensitivityFlag =
          claim.sensitivityFlag || verification.sensitivityWarning || sourceMentionsSensitivity;
        let confidence = verification.confidence;
        const ownershipClarity = verification.ownershipClarity;

        if (verification.shouldFlag || verification.overstatementWarning) {
          verificationStatus = "flagged";
          confidence = downgradeConfidence(confidence);
          risks.push("Wording may overstate impact relative to the available evidence.");
        }

        if (verification.unsupportedImpactWarning) {
          verificationStatus = "flagged";
          confidence = downgradeConfidence(confidence);
          risks.push("Claim impact needs stronger evidence before approval.");
        }

        if (ownershipClarity !== "clear") {
          risks.push("Clarify individual ownership before using in a public artifact.");
        }

        if (sensitivityFlag) {
          verificationStatus = "flagged";
          visibility = "private";
          risks.push("Potentially sensitive material should stay private until reviewed.");
        }

        if (!claim.evidenceCard.sourceRefs.length) {
          verificationStatus = "flagged";
          confidence = "low";
          risks.push("No source reference is attached to this claim.");
        }

        return {
          ...claim,
          text: resolveVerifiedClaimText(claim.text, verification.revisedText),
          confidence,
          ownershipClarity,
          verificationStatus,
          visibility,
          sensitivityFlag,
          rejectionReason: null,
          risksSummary: risks.join(" ").trim() || null,
          missingInfo: verification.missingInfo ?? claim.missingInfo ?? null,
          evidenceCard: {
            ...claim.evidenceCard,
            rationaleSummary: verification.rationaleSummary,
            verificationNotes:
              [claim.evidenceCard.verificationNotes, verification.verificationNotes]
                .filter(Boolean)
                .join(" ")
                .trim() || null,
          },
        };
      });

      const generationRun = await createGenerationRun({
        workItemId: workItem.id,
        kind: "claim_verification",
        status: "success",
        provider: result.provider,
        modelId: result.modelId,
        inputSummary: {
          ...baseInputSummary,
          transportMode: result.transportMode,
          transportAttempts: JSON.parse(
            JSON.stringify(result.attempts),
          ) as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
        rawOutput: result.rawOutput,
        parsedOutput: result.parsedOutput as Prisma.InputJsonValue,
        validationErrors: null,
        resultRefs: null,
        tokenUsage: (result.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: result.estimatedCostUsd,
      });

      return attachGenerationRunMetadata(verifiedClaims, {
        id: generationRun.id,
        kind: "claim_verification",
      });
    } catch (error) {
      const failure = error instanceof StructuredOutputError ? error : null;

      await createGenerationRun({
        workItemId: workItem.id,
        kind: "claim_verification",
        status: failure?.status ?? "provider_error",
        provider: "bedrock",
        modelId: process.env.WORKBASE_BEDROCK_MODEL_ID ?? "unconfigured",
        inputSummary: {
          ...baseInputSummary,
          transportMode: failure?.transportMode ?? null,
          transportAttempts:
            failure?.attempts == null
              ? null
              : (JSON.parse(JSON.stringify(failure.attempts)) as Prisma.InputJsonValue),
        } as Prisma.InputJsonValue,
        rawOutput: failure?.rawOutput ?? null,
        parsedOutput: null,
        validationErrors:
          (failure?.validationErrors as Prisma.InputJsonValue | null) ?? null,
        resultRefs: null,
        tokenUsage: (failure?.tokenUsage as Prisma.InputJsonValue | null) ?? null,
        estimatedCostUsd: null,
      });

      throw error;
    }
  },
};

export const claimVerificationService: ClaimVerificationService = {
  async verify(input) {
    if (resolveWorkbaseLlmProvider() === "mock") {
      return mockClaimVerificationService.verify(input);
    }

    return bedrockClaimVerificationService.verify(input);
  },
};
