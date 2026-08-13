import { describe, expect, it } from "vitest";
import { resolveLifecycleTitlePrefix } from "@/tests/e2e/work-item-lifecycle-title-prefix.mjs";

describe("lifecycle title prefix", () => {
  it("uses a deterministic configured prefix for paired provider runs", () => {
    expect(resolveLifecycleTitlePrefix(
      "  Lifecycle eval paired Resume abc1234  ",
      "random123",
    )).toBe("Lifecycle eval paired Resume abc1234");
  });

  it("keeps a random isolated default and rejects unsafe deletion scopes", () => {
    expect(resolveLifecycleTitlePrefix(undefined, "random123"))
      .toBe("Lifecycle eval random123");
    expect(() => resolveLifecycleTitlePrefix("Resume", "random123"))
      .toThrow("must start with 'Lifecycle eval '");
    expect(() => resolveLifecycleTitlePrefix(
      "Lifecycle eval paired; DROP TABLE WorkItem",
      "random123",
    )).toThrow("contain only letters");
  });
});
