import { describe, expect, it } from "vitest";
import { isArtifactPublicVerificationEligible } from "@/src/services/public-knowledge-verification-service";

describe("public artifact verification", () => {
  it("requires at least one entailed claim before certifying an artifact", () => {
    expect(isArtifactPublicVerificationEligible({
      eligible: true,
      claims: [{ verdict: "entailed" }],
    })).toBe(true);

    expect(isArtifactPublicVerificationEligible({
      eligible: true,
      claims: [],
    })).toBe(false);
  });

  it("fails closed when any returned claim is not entailed", () => {
    expect(isArtifactPublicVerificationEligible({
      eligible: true,
      claims: [
        { verdict: "entailed" },
        { verdict: "partially_entailed" },
      ],
    })).toBe(false);
  });
});
