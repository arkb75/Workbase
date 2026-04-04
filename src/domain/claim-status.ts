import type { VerificationStatus } from "@/src/lib/options";

export function transitionClaimStatus(
  currentStatus: VerificationStatus,
  intent: "save" | "approve" | "reject" | "restore",
) {
  if (intent === "save") {
    return currentStatus;
  }

  if (intent === "approve") {
    if (
      currentStatus === "draft" ||
      currentStatus === "flagged" ||
      currentStatus === "rejected"
    ) {
      return "approved" as const;
    }

    return currentStatus;
  }

  if (intent === "restore") {
    if (currentStatus === "rejected") {
      return "flagged" as const;
    }

    return currentStatus;
  }

  if (intent === "reject") {
    return "rejected" as const;
  }

  return currentStatus;
}
