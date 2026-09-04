import { describe, expect, it } from "vitest";
import { classifyWorkflowFailure, errorMessageFromUnknown } from "@/src/lib/error-message";

describe("workflow error normalization", () => {
  it("does not retry deterministic repository checkpoint or terminal-refresh failures", () => {
    expect(classifyWorkflowFailure(new Error(
      "Persisted repository investigation checkpoint contains stale claim evidence.",
    ))).toMatchObject({ code: "workflow_failed", retryable: false });
    expect(classifyWorkflowFailure(new Error(
      "Repository refresh refresh-1 is failed and cannot continue.",
    ))).toMatchObject({ code: "workflow_failed", retryable: false });
    expect(classifyWorkflowFailure(new Error(
      "Repository investigation source attestation contains a conflicting durable identity.",
    ))).toMatchObject({ code: "workflow_failed", retryable: false });
    expect(classifyWorkflowFailure(new Error(
      "Persisted repository investigation checkpoint contains a stale exact read identity.",
    ))).toMatchObject({ code: "workflow_failed", retryable: false });
  });

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

  it("classifies model-provider failures without exposing provider payloads or stack traces", () => {
    const failure = classifyWorkflowFailure(new Error(
      "ThrottlingException: request abc-123 failed\n    at BedrockRuntimeClient.send (/secret/runtime.ts:41:9)",
    ));

    expect(failure).toEqual({
      code: "model_provider_unavailable",
      message: "The model provider did not complete this request.",
      recovery: "Your project data is intact. Retry the message; Workbase will reuse completed retrieval and repository work where possible.",
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toMatch(/abc-123|secret\/runtime|ThrottlingException/);
  });

  it("preserves typed schema and shared-refresh failures across safe durable messages", () => {
    expect(classifyWorkflowFailure("database_schema_out_of_date: migrations are out of date")).toMatchObject({
      code: "database_schema_out_of_date",
      retryable: false,
    });
    expect(classifyWorkflowFailure(
      "The shared repository refresh did not complete within the durable wait window.",
    )).toMatchObject({
      code: "shared_refresh_timeout",
      retryable: true,
    });
    expect(classifyWorkflowFailure(
      "The model provider did not complete this request.",
    )).toMatchObject({
      code: "model_provider_unavailable",
      retryable: true,
    });
  });

  it("does not recommend retrying terminal provider auth, billing, or refusal errors", () => {
    expect(classifyWorkflowFailure({
      message: "payment required",
      status: 402,
      retryable: false,
      code: "payment_required",
    })).toMatchObject({
      code: "model_provider_unavailable",
      retryable: false,
    });
    expect(classifyWorkflowFailure({
      message: "blocked",
      providerStatus: null,
      retryable: false,
      providerCode: "response_blocked",
    })).toMatchObject({
      code: "model_provider_unavailable",
      message: "The model provider blocked this response.",
      retryable: false,
    });
    expect(classifyWorkflowFailure({
      message: "rate limited",
      status: 429,
      retryable: true,
    })).toMatchObject({
      code: "model_provider_unavailable",
      retryable: true,
    });
  });

  it("does not replay deterministic model execution-limit failures", () => {
    expect(classifyWorkflowFailure({
      message: "Bedrock agent exceeded its 5-iteration limit.",
      code: "iteration_limit_exceeded",
      limit: 5,
      actual: 6,
    })).toEqual({
      code: "model_execution_limit",
      message: "Workbase stopped the model after it reached a bounded execution limit.",
      recovery: "Retry with a narrower request, or inspect the run's tool activity if the same limit repeats.",
      retryable: false,
    });
  });

  it("never reflects an unknown internal error into the user-visible failure", () => {
    const failure = classifyWorkflowFailure({
      message: "Validation blew up with token ghp_supersecret and /private/app.ts:77",
    });

    expect(failure.code).toBe("workflow_failed");
    expect(failure.message).toBe("Workbase could not complete this request before the run ended.");
    expect(JSON.stringify(failure)).not.toMatch(/ghp_|private\/app|Validation blew up/);
  });
});
