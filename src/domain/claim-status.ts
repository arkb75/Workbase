import type { VerificationStatus } from "@/src/lib/options";

export function transitionClaimStatus(
  currentStatus: VerificationStatus,
  intent: "save" | "approve" | "reject",
) {
  if (intent === "save") {
    return currentStatus;
  }

  if (intent === "approve") {
    if (currentStatus === "draft" || currentStatus === "flagged") {
      return "approved" as const;
    }

    return currentStatus;
  }

  if (intent === "reject") {
    if (currentStatus !== "rejected") {
      return "rejected" as const;
    }
  }

  return currentStatus;
}
