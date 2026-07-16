import type { Prisma } from "@/src/generated/prisma/client";

export function pendingHighlightBulkApprovalWhere(
  workItemId: string,
): Prisma.HighlightWhereInput {
  return {
    workItemId,
    lifecycleStatus: "active",
    verificationStatus: {
      in: ["draft", "flagged"],
    },
    agentRunCandidates: {
      none: { status: "pending" },
    },
  };
}
