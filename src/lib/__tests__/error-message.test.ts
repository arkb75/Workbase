import { describe, expect, it } from "vitest";
import { classifyWorkflowFailure, errorMessageFromUnknown } from "@/src/lib/error-message";

describe("workflow error normalization", () => {
  it("preserves messages serialized across a durable workflow boundary", () => {
    expect(errorMessageFromUnknown({ cause: { message: "specific failure" } })).toBe("specific failure");
  });

  it("turns Prisma runtime mismatches into safe actionable failures", () => {
    expect(classifyWorkflowFailure({ message: "Unknown argument `productImportance`." })).toEqual({
      code: "runtime_schema_mismatch",
      message: "Workbase's generated database client or deployed schema is out of date.",
      recovery: "Run npm run db:prepare, restart the application, and retry this message.",
      retryable: false,
    });
  });
});
