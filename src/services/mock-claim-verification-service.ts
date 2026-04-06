import type { ClaimVerificationService } from "@/src/services/types";

function downgradeConfidence(value: "low" | "medium" | "high") {
  if (value === "high") {
    return "medium" as const;
  }

  return "low" as const;
}

export const mockClaimVerificationService: ClaimVerificationService = {
  async verify({ highlights, evidenceItems }) {
    return highlights.map((highlight) => {
      const risks = [highlight.risksSummary].filter(Boolean);
      let verificationStatus = highlight.verificationStatus;
      let visibility = highlight.visibility;
      let sensitivityFlag = highlight.sensitivityFlag;
      let confidence = highlight.confidence;
      let ownershipClarity = highlight.ownershipClarity;

      if (/\b(10x|100%|single-handedly|owned the entire|revolutionized)\b/i.test(highlight.text)) {
        verificationStatus = "flagged";
        confidence = downgradeConfidence(confidence);
        risks.push("Wording may overstate impact relative to the available evidence.");
      }

      if (/\b(team|paired|collaborated|supported)\b/i.test(highlight.text)) {
        ownershipClarity =
          ownershipClarity === "clear" ? "partial" : ownershipClarity;
        risks.push("Clarify individual ownership before using in a public artifact.");
      }

      const sourceMentionsSensitivity = evidenceItems.some((source) =>
        /sensitive|confidential|internal|private dataset|customer/i.test(source.body),
      );

      if (
        /\b(customer data|internal|confidential|sensitive)\b/i.test(highlight.text) ||
        sourceMentionsSensitivity
      ) {
        sensitivityFlag = true;
        verificationStatus = "flagged";
        visibility = "private";
        risks.push("Potentially sensitive material should stay private until reviewed.");
      }

      if (!highlight.evidence.sourceRefs.length) {
        verificationStatus = "flagged";
        confidence = "low";
        risks.push("No source reference is attached to this highlight.");
      }

      return {
        ...highlight,
        confidence,
        ownershipClarity,
        verificationStatus,
        visibility,
        sensitivityFlag,
        rejectionReason: null,
        risksSummary: risks.join(" "),
        verificationNotes:
          [highlight.verificationNotes, ...risks]
            .filter(Boolean)
            .join(" ")
            .trim() || null,
        evidence: {
          ...highlight.evidence,
          verificationNotes:
            [highlight.evidence.verificationNotes, ...risks]
              .filter(Boolean)
              .join(" ")
              .trim() || null,
        },
      };
    });
  },
};
