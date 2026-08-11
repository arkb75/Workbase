import { describe, expect, it } from "vitest";
import { resolveLifecycleRepositoryIdentity } from "@/tests/e2e/work-item-lifecycle-repository-identity.mjs";

describe("live lifecycle repository identity", () => {
  it("uses the canonical GitHub name returned for the exact stable repository ID", () => {
    expect(resolveLifecycleRepositoryIdentity({
      expectedRepositoryId: "1075120340",
      configuredRepositoryFullName: "rafaykhurram/Resume",
      selectedRepositoryId: "1075120340",
      selectedRepositoryFullName: "arkb75/Resume",
    })).toEqual({
      repositoryId: "1075120340",
      fullName: "arkb75/Resume",
      configuredFullName: "rafaykhurram/Resume",
      canonicalized: true,
    });
  });

  it("rejects a different selected repository ID instead of trusting its name", () => {
    expect(() => resolveLifecycleRepositoryIdentity({
      expectedRepositoryId: "1075120340",
      configuredRepositoryFullName: "arkb75/Resume",
      selectedRepositoryId: "1200815769",
      selectedRepositoryFullName: "arkb75/Workbase",
    })).toThrow("requires exact ID");
  });

  it("rejects an invalid canonical repository name", () => {
    expect(() => resolveLifecycleRepositoryIdentity({
      expectedRepositoryId: "1075120340",
      configuredRepositoryFullName: "arkb75/Resume",
      selectedRepositoryId: "1075120340",
      selectedRepositoryFullName: "Resume",
    })).toThrow("valid canonical owner/repository name");
  });
});
