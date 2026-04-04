import type { Prisma } from "@/src/generated/prisma/client";
import type { JsonValue, NormalizedSource } from "@/src/domain/types";
import { attachGenerationRunMetadata } from "@/src/lib/generation-run-metadata";
import { createGenerationRun } from "@/src/lib/generation-runs";
import { claimVerificationLlmOutputSchema } from "@/src/lib/llm-output-schemas";
import { resolveWorkbaseLlmProvider } from "@/src/lib/llm-config";
import { StructuredOutputError } from "@/src/lib/bedrock-structured-llm-client";
import { toSentence } from "@/src/lib/utils";
import type { ClaimVerificationService } from "@/src/services/types";
import { getBedrockStructuredLlmClient } from "@/src/services/bedrock-runtime";
import { mockClaimVerificationService } from "@/src/services/mock-claim-verification-service";

function isRejectedGuidanceSource(source: NormalizedSource) {
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
}) {
  return {
    workItemId: params.workItemId,
    workItemTitle: params.workItemTitle,
    claimCount: params.claimCount,
    systemPrompt: params.systemPrompt,
    userPrompt: params.userPrompt,
  } as JsonValue;
}

const bedrockClaimVerificationService: ClaimVerificationService = {
  async verify({ workItem, sources, claims }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const rejectedGuidance = sources
      .filter(isRejectedGuidanceSource)
      .map((source) => source.body)
      .join("\n\n");
    const supportingSources = sources
      .filter((source) => !isRejectedGuidanceSource(source))
      .map((source) => ({
        id: source.id,
        label: source.label,
        excerpts: source.excerpts.length ? source.excerpts : [source.body],
      }));
    const systemPrompt = [
      "You verify Workbase candidate claims against provided evidence.",
      "Return strict JSON only.",
      "Do not decide final application rules such as artifact eligibility or state transitions.",
      "You may suggest cautions, revised wording, uncertainty, sensitivity warnings, and visibility suggestions.",
    ].join(" ");
    const userPrompt = JSON.stringify(
      {
        task: "Review each candidate claim and return one verification result per claim.",
        workItem: {
          id: workItem.id,
          title: workItem.title,
          type: workItem.type,
          description: workItem.description,
        },
        rejectedClaimGuidance: rejectedGuidance || null,
        sources: supportingSources,
        claims: claims.map((claim, index) => ({
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
      },
      null,
      2,
    );
    const inputSummary = buildVerificationInputSummary({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      systemPrompt,
      userPrompt,
      claimCount: claims.length,
    });

    try {
      const result = await structuredClient.generateStructured({
        systemPrompt,
        userPrompt,
        schema: claimVerificationLlmOutputSchema,
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
        const sensitivityFlag = claim.sensitivityFlag || verification.sensitivityWarning;
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
        inputSummary: inputSummary as Prisma.InputJsonValue,
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
        inputSummary: inputSummary as Prisma.InputJsonValue,
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
