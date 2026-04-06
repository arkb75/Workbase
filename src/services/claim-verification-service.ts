import type { Prisma } from "@/src/generated/prisma/client";
import type {
  JsonValue,
  NormalizedEvidenceItem,
} from "@/src/domain/types";
import { inferHighlightTags } from "@/src/lib/highlight-tags";
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

const MAX_VERIFICATION_BATCH_SIZE = 6;

function isRejectedGuidanceSource(source: NormalizedEvidenceItem) {
  return (
    typeof source.metadata === "object" &&
    source.metadata &&
    "kind" in source.metadata &&
    (source.metadata.kind === "rejected_highlight_context" ||
      source.metadata.kind === "rejected_claim_context")
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

function chunkHighlights<T>(items: T[], chunkSize: number) {
  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    batches.push(items.slice(index, index + chunkSize));
  }

  return batches;
}

function mapSupportingEvidence(source: NormalizedEvidenceItem) {
  return {
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
  };
}

const bedrockClaimVerificationService: ClaimVerificationService = {
  async verify({ workItem, evidenceItems, highlights }) {
    const structuredClient = getBedrockStructuredLlmClient();
    const rejectedGuidance = evidenceItems
      .filter(isRejectedGuidanceSource)
      .map((source) => source.body)
      .join("\n\n");
    const baseEvidence = evidenceItems.filter((source) => !isRejectedGuidanceSource(source));
    const indexedHighlights = highlights.map((highlight, index) => ({
      highlight,
      originalIndex: index,
    }));
    const highlightBatches = chunkHighlights(
      indexedHighlights,
      MAX_VERIFICATION_BATCH_SIZE,
    );
    const systemPrompt = [
      "You verify Workbase candidate highlights against provided evidence.",
      "Return JSON that matches the provided schema exactly.",
      "Do not decide final application rules such as artifact eligibility or state transitions.",
    ].join(" ");
    const aggregateAttempts: Array<Record<string, unknown>> = [];
    const aggregateRawOutputs: Array<{ batchIndex: number; rawOutput: string | null }> = [];
    const aggregateParsedResults: Array<Record<string, unknown>> = [];
    const aggregateTokenUsage: Array<{
      batchIndex: number;
      tokenUsage: JsonValue | null;
    }> = [];
    const verifiedClaims = [...highlights];
    let aggregateTransportMode: string | null = null;
    let aggregateProvider = "bedrock";
    let aggregateModelId = process.env.WORKBASE_BEDROCK_MODEL_ID ?? "unconfigured";
    let aggregateEvidenceCount = 0;

    try {
      for (const [batchIndex, batch] of highlightBatches.entries()) {
        const referencedEvidenceIds = new Set(
          batch.flatMap(({ highlight }) =>
            highlight.evidence.sourceRefs.flatMap((sourceRef) =>
              sourceRef.evidenceItemId ? [sourceRef.evidenceItemId] : [],
            ),
          ),
        );
        const batchEvidenceItems = (
          referencedEvidenceIds.size
            ? baseEvidence.filter((item) => referencedEvidenceIds.has(item.id))
            : baseEvidence
        ).map(mapSupportingEvidence);
        const supportingEvidence = batchEvidenceItems.length
          ? batchEvidenceItems
          : baseEvidence.map(mapSupportingEvidence);
        const userPrompt = formatTaggedSections([
          {
            tag: "task",
            content:
              "Review each candidate highlight and return exactly one verification result per highlight.",
          },
          {
            tag: "rules",
            content: [
              "Return a top-level JSON object with a `results` array.",
              "Each result object must include exactly these fields: claimIndex, revisedText, confidence, ownershipClarity, visibilitySuggestion, sensitivityWarning, shouldFlag, overstatementWarning, unsupportedImpactWarning, rationaleSummary, risksSummary, missingInfo, verificationNotes.",
              "Preserve one result per input highlight in the same indexing space.",
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
            tag: "rejected_claim_guidance",
            content: rejectedGuidance || "null",
          },
          {
            tag: "evidence_items",
            content: JSON.stringify(supportingEvidence, null, 2),
          },
          {
            tag: "highlights",
            content: JSON.stringify(
              batch.map(({ highlight }, localIndex) => ({
                claimIndex: localIndex,
                text: highlight.text,
                confidence: highlight.confidence,
                ownershipClarity: highlight.ownershipClarity,
                evidenceSummary: highlight.summary,
                rationaleSummary: highlight.verificationNotes,
                sourceRefs: highlight.evidence.sourceRefs,
                risksSummary: highlight.risksSummary,
                missingInfo: highlight.missingInfo,
              })),
              null,
              2,
            ),
          },
        ]);

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
          maxTokens: 3200,
          extraValidation: (value) => {
            const errors: string[] = [];
            const seenIndexes = new Set<number>();

            if (value.results.length !== batch.length) {
              errors.push("Verification output must include exactly one result per input highlight.");
            }

            value.results.forEach((item, index) => {
              if (item.claimIndex < 0 || item.claimIndex >= batch.length) {
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

        aggregateProvider = result.provider;
        aggregateModelId = result.modelId;
        aggregateTransportMode =
          aggregateTransportMode == null || aggregateTransportMode === result.transportMode
            ? result.transportMode
            : "batched";
        aggregateEvidenceCount += supportingEvidence.length;
        aggregateAttempts.push({
          batchIndex,
          transportMode: result.transportMode,
          attempts: JSON.parse(JSON.stringify(result.attempts)) as JsonValue,
        });
        aggregateRawOutputs.push({
          batchIndex,
          rawOutput: result.rawOutput,
        });
        aggregateTokenUsage.push({
          batchIndex,
          tokenUsage: (result.tokenUsage as JsonValue | null) ?? null,
        });

        const sourceMentionsSensitivity = supportingEvidence.some((item) =>
          item.excerpts.some((excerpt) =>
            /sensitive|confidential|internal|private dataset|customer/i.test(excerpt),
          ),
        );

        for (const { highlight, originalIndex } of batch) {
          const localIndex = batch.findIndex((entry) => entry.originalIndex === originalIndex);
          const verification = result.data.results.find(
            (item) => item.claimIndex === localIndex,
          );

          if (!verification) {
            continue;
          }

          aggregateParsedResults.push({
            ...verification,
            claimIndex: originalIndex,
          });

          const risks = [highlight.risksSummary, verification.risksSummary].filter(Boolean);
          let verificationStatus = highlight.verificationStatus;
          let visibility = verification.visibilitySuggestion;
          const sensitivityFlag =
            highlight.sensitivityFlag ||
            verification.sensitivityWarning ||
            sourceMentionsSensitivity;
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

          if (!highlight.evidence.sourceRefs.length) {
            verificationStatus = "flagged";
            confidence = "low";
            risks.push("No source reference is attached to this highlight.");
          }

          verifiedClaims[originalIndex] = {
            ...highlight,
            text: resolveVerifiedClaimText(highlight.text, verification.revisedText),
            confidence,
            ownershipClarity,
            verificationStatus,
            visibility,
            sensitivityFlag,
            rejectionReason: null,
            risksSummary: risks.join(" ").trim() || null,
            missingInfo: verification.missingInfo ?? highlight.missingInfo ?? null,
            summary: highlight.summary,
            verificationNotes:
              [highlight.verificationNotes, verification.verificationNotes, verification.rationaleSummary]
                .filter(Boolean)
                .join(" ")
                .trim() || null,
            metadata: {
              ...(typeof highlight.metadata === "object" &&
              highlight.metadata &&
              !Array.isArray(highlight.metadata)
                ? highlight.metadata
                : {}),
              rationaleSummary: verification.rationaleSummary,
            },
            evidence: {
              ...highlight.evidence,
              summary: highlight.summary,
              verificationNotes:
                [highlight.verificationNotes, verification.verificationNotes]
                  .filter(Boolean)
                  .join(" ")
                  .trim() || null,
            },
            tags: inferHighlightTags({
              text: resolveVerifiedClaimText(highlight.text, verification.revisedText),
              summary: highlight.summary,
              verificationNotes:
                [verification.verificationNotes, verification.rationaleSummary, verification.risksSummary]
                  .filter(Boolean)
                  .join(" ")
                  .trim() || null,
            }),
          };
        }
      }

      const baseInputSummary = buildVerificationInputSummary({
        workItemId: workItem.id,
        workItemTitle: workItem.title,
        systemPrompt,
        userPrompt: `Batched highlight verification across ${highlightBatches.length} batches.`,
        claimCount: highlights.length,
        clusterCount: 0,
        evidenceCount: aggregateEvidenceCount,
        transportMode: aggregateTransportMode,
        attempts: aggregateAttempts as JsonValue,
      });

      const generationRun = await createGenerationRun({
        workItemId: workItem.id,
        kind: "highlight_verification",
        status: "success",
        provider: aggregateProvider,
        modelId: aggregateModelId,
        inputSummary: {
          ...baseInputSummary,
          transportMode: aggregateTransportMode,
          transportAttempts: aggregateAttempts as Prisma.InputJsonValue,
        } as Prisma.InputJsonValue,
        rawOutput: JSON.stringify(aggregateRawOutputs, null, 2),
        parsedOutput: {
          results: aggregateParsedResults,
        } as Prisma.InputJsonValue,
        validationErrors: null,
        resultRefs: null,
        tokenUsage: {
          batches: aggregateTokenUsage,
        } as Prisma.InputJsonValue,
        estimatedCostUsd: null,
      });

      return attachGenerationRunMetadata(verifiedClaims, {
        id: generationRun.id,
        kind: "highlight_verification",
      });
    } catch (error) {
      const failure = error instanceof StructuredOutputError ? error : null;
      const baseInputSummary = buildVerificationInputSummary({
        workItemId: workItem.id,
        workItemTitle: workItem.title,
        systemPrompt,
        userPrompt: `Batched highlight verification across ${highlightBatches.length} batches.`,
        claimCount: highlights.length,
        clusterCount: 0,
        evidenceCount: baseEvidence.length,
        transportMode: failure?.transportMode ?? null,
        attempts:
          failure?.attempts == null
            ? (aggregateAttempts as JsonValue)
            : ([
                ...aggregateAttempts,
                {
                  batchIndex: aggregateAttempts.length,
                  transportMode: failure.transportMode,
                  attempts: JSON.parse(JSON.stringify(failure.attempts)) as JsonValue,
                },
              ] as JsonValue),
      });

      await createGenerationRun({
        workItemId: workItem.id,
        kind: "highlight_verification",
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
