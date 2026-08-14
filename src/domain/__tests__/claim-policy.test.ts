import { describe, expect, it } from "vitest";
import { transitionClaimStatus } from "@/src/domain/claim-status";

describe("claim status transitions", () => {
  it("allows draft, flagged, and rejected highlights to become approved", () => {
    expect(transitionClaimStatus("draft", "approve")).toBe("approved");
    expect(transitionClaimStatus("flagged", "approve")).toBe("approved");
    expect(transitionClaimStatus("rejected", "approve")).toBe("approved");
  });

  it("moves highlights into rejected and can restore rejected highlights to flagged", () => {
    expect(transitionClaimStatus("draft", "reject")).toBe("rejected");
    expect(transitionClaimStatus("approved", "reject")).toBe("rejected");
    expect(transitionClaimStatus("rejected", "restore")).toBe("flagged");
  });
});
