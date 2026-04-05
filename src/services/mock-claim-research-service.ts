import type { ClaimDraft } from "@/src/domain/types";
import type { ClaimResearchService } from "@/src/services/types";
import { targetAngleKeywordMap } from "@/src/lib/options";
import { normalizeWhitespace, toSentence } from "@/src/lib/utils";

const researchActionVerbs = [
  "built",
  "implemented",
  "created",
  "designed",
  "improved",
  "integrated",
  "automated",
  "deployed",
  "trained",
  "analyzed",
  "optimized",
  "shipped",
  "developed",
] as const;

function inferClaimCategory(text: string) {
  const loweredText = text.toLowerCase();

  for (const [category, keywords] of Object.entries(targetAngleKeywordMap)) {
    if (keywords.some((keyword) => loweredText.includes(keyword))) {
      return category;
    }
  }

  return "general";
}

function inferConfidence(text: string) {
  const specificitySignals = [
    /postgres/i,
    /prisma/i,
    /next\.js/i,
    /react/i,
    /\d/,
    /api/i,
    /pipeline/i,
    /automation/i,
  ].filter((pattern) => pattern.test(text)).length;

  if (specificitySignals >= 3) {
    return "high" as const;
  }

  if (specificitySignals >= 1) {
    return "medium" as const;
  }

  return "low" as const;
}

function inferOwnershipClarity(text: string) {
  if (/\b(i|implemented|built|created|designed|wrote|shipped)\b/i.test(text)) {
    return "clear" as const;
  }

  if (/\b(team|paired|collaborated|worked with|supported)\b/i.test(text)) {
    return "partial" as const;
  }

  return "unclear" as const;
}

function inferRisks(text: string) {
  const risks: string[] = [];

  if (!/\d/.test(text)) {
    risks.push("Outcome is described without a quantified result.");
  }

  if (/\b(team|collaborated|supported)\b/i.test(text)) {
    risks.push("Individual ownership should be checked before approval.");
  }

  if (!/\b(api|dashboard|service|pipeline|model|database|automation|script)\b/i.test(text)) {
    risks.push("Technical scope is implied more than explicitly stated.");
  }

  return risks.join(" ");
}

function inferMissingInfo(text: string) {
  const missing: string[] = [];

  if (!/\b(postgres|prisma|next\.js|react|python|typescript|sql|api)\b/i.test(text)) {
    missing.push("Add the main stack or system surface.");
  }

  if (!/\b(user|users|team|lab|customer|dataset|records)\b/i.test(text)) {
    missing.push("Add who benefited from the work.");
  }

  return missing.join(" ");
}

function createClaimDraft(params: {
  sourceId: string;
  sourceLabel: string;
  sourceType: "manual_note" | "github_repo";
  claimText: string;
  supportingExcerpt: string;
}): ClaimDraft {
  const text = toSentence(params.claimText);
  const risksSummary = inferRisks(text) || null;
  const missingInfo = inferMissingInfo(text) || null;

  return {
    text,
    category: inferClaimCategory(text),
    confidence: inferConfidence(text),
    ownershipClarity: inferOwnershipClarity(text),
    sensitivityFlag: false,
    verificationStatus: "draft",
    visibility: "resume_safe",
    risksSummary,
    missingInfo,
    rejectionReason: null,
    evidenceCard: {
      evidenceSummary: `Grounded in ${params.sourceLabel.toLowerCase()}: "${toSentence(
        params.supportingExcerpt,
      )}".`,
      rationaleSummary:
        "The claim is phrased as implementation work directly supported by the attached source.",
      sourceRefs: [
        {
          sourceId: params.sourceId,
          sourceLabel: params.sourceLabel,
          sourceType: params.sourceType,
          excerpt: toSentence(params.supportingExcerpt),
        },
      ],
      verificationNotes:
        missingInfo || risksSummary
          ? [missingInfo, risksSummary].filter(Boolean).join(" ")
          : "Check wording against the exact scope of the work before approval.",
    },
  };
}

export const mockClaimResearchService: ClaimResearchService = {
  async generate({ workItem, evidenceItems }) {
    const drafts: ClaimDraft[] = [
      createClaimDraft({
        sourceId: `${workItem.id}-description`,
        sourceLabel: "Work Item description",
        sourceType: "manual_note",
        claimText:
          workItem.type === "experience"
            ? `${workItem.description}`
            : `Built ${workItem.title}, ${workItem.description}`,
        supportingExcerpt: workItem.description,
      }),
    ];

    for (const source of evidenceItems) {
      const isRejectedGuidance =
        typeof source.metadata === "object" &&
        source.metadata &&
        "kind" in source.metadata &&
        source.metadata.kind === "rejected_claim_context";

      if (isRejectedGuidance) {
        continue;
      }

      for (const excerpt of source.excerpts) {
        const normalizedExcerpt = normalizeWhitespace(excerpt);

        if (
          !researchActionVerbs.some((verb) =>
            normalizedExcerpt.toLowerCase().includes(verb),
          )
        ) {
          continue;
        }

        drafts.push(
          createClaimDraft({
            sourceId: source.sourceId,
            sourceLabel:
              typeof source.metadata === "object" &&
              source.metadata &&
              "sourceLabel" in source.metadata &&
              typeof source.metadata.sourceLabel === "string"
                ? source.metadata.sourceLabel
                : source.label,
            sourceType: source.type,
            claimText: normalizedExcerpt,
            supportingExcerpt: normalizedExcerpt,
          }),
        );
      }
    }

    return drafts.slice(0, 6);
  },
};
