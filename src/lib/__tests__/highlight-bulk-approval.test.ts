import { describe, expect, it } from "vitest";
import { pendingHighlightBulkApprovalWhere } from "@/src/lib/highlight-bulk-approval";

describe("pendingHighlightBulkApprovalWhere", () => {
  it("never bulk-approves stale or otherwise inactive highlights", () => {
    expect(pendingHighlightBulkApprovalWhere("work-item-1")).toEqual({
      workItemId: "work-item-1",
      lifecycleStatus: "active",
      verificationStatus: {
        in: ["draft", "flagged"],
      },
      agentRunCandidates: {
        none: { status: "pending" },
      },
    });
  });
});
