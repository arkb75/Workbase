import type { ClaimVerificationService } from "@/src/services/types";

function downgradeConfidence(value: "low" | "medium" | "high") {
  if (value === "high") {
    return "medium" as const;
  }

  return "low" as const;
}

export const mockClaimVerificationService: ClaimVerificationService = {
  async verify({ claims, sources }) {
    return claims.map((claim) => {
      const risks = [claim.risksSummary].filter(Boolean);
      let verificationStatus = claim.verificationStatus;
      let visibility = claim.visibility;
      let sensitivityFlag = claim.sensitivityFlag;
      let confidence = claim.confidence;
      let ownershipClarity = claim.ownershipClarity;

      if (/\b(10x|100%|single-handedly|owned the entire|revolutionized)\b/i.test(claim.text)) {
        verificationStatus = "flagged";
        confidence = downgradeConfidence(confidence);
        risks.push("Wording may overstate impact relative to the available evidence.");
      }

      if (/\b(team|paired|collaborated|supported)\b/i.test(claim.text)) {
        ownershipClarity =
          ownershipClarity === "clear" ? "partial" : ownershipClarity;
        risks.push("Clarify individual ownership before using in a public artifact.");
      }

      const sourceMentionsSensitivity = sources.some((source) =>
        /sensitive|confidential|internal|private dataset|customer/i.test(source.body),
      );

      if (
        /\b(customer data|internal|confidential|sensitive)\b/i.test(claim.text) ||
        sourceMentionsSensitivity
      ) {
        sensitivityFlag = true;
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
        confidence,
        ownershipClarity,
        verificationStatus,
        visibility,
        sensitivityFlag,
        rejectionReason: null,
        risksSummary: risks.join(" "),
        evidenceCard: {
          ...claim.evidenceCard,
          verificationNotes:
            [claim.evidenceCard.verificationNotes, ...risks]
              .filter(Boolean)
              .join(" ")
              .trim() || null,
        },
      };
    });
  },
};
