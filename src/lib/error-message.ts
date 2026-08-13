function messageFromRecord(value: Record<string, unknown>, seen: Set<unknown>) {
  for (const key of ["message", "cause", "error", "reason", "details"] as const) {
    const message = errorMessageFromUnknown(value[key], seen);
    if (message) return message;
  }
  return "";
}

export function errorMessageFromUnknown(value: unknown, seen = new Set<unknown>()): string {
  if (typeof value === "string") return value.trim();
  if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return "";
  seen.add(value);
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  if (!Array.isArray(value)) return messageFromRecord(value as Record<string, unknown>, seen);
  for (const entry of value) {
    const message = errorMessageFromUnknown(entry, seen);
    if (message) return message;
  }
  return "";
}

export interface ClassifiedWorkflowFailure {
  code:
    | "runtime_schema_mismatch"
    | "database_schema_out_of_date"
    | "database_unavailable"
    | "model_provider_unavailable"
    | "model_execution_limit"
    | "repository_provider_unavailable"
    | "shared_refresh_timeout"
    | "workflow_failed";
  message: string;
  recovery: string | null;
  retryable: boolean;
}

function providerFailureSemantics(value: unknown, seen = new Set<unknown>()): {
  status: number | null;
  retryable: boolean | null;
  code: string | null;
} | null {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    seen.has(value)
  ) {
    return null;
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const status =
    typeof record.providerStatus === "number"
      ? record.providerStatus
      : typeof record.status === "number"
        ? record.status
        : null;
  const retryable =
    typeof record.retryable === "boolean" ? record.retryable : null;
  const code =
    typeof record.providerCode === "string"
      ? record.providerCode
      : typeof record.code === "string"
        ? record.code
        : null;
  if (status != null || retryable != null || code != null) {
    return { status, retryable, code };
  }
  for (const key of ["cause", "error", "reason", "details"]) {
    const nested = providerFailureSemantics(record[key], seen);
    if (nested) return nested;
  }
  return null;
}

export function classifyWorkflowFailure(error: unknown): ClassifiedWorkflowFailure {
  const raw = errorMessageFromUnknown(error);
  const providerFailure = providerFailureSemantics(error);
  if (
    providerFailure?.code === "iteration_limit_exceeded" ||
    providerFailure?.code === "tool_call_limit_exceeded" ||
    providerFailure?.code === "token_limit_exceeded" ||
    providerFailure?.code === "output_token_limit_reached"
  ) {
    return {
      code: "model_execution_limit",
      message: "Workbase stopped the model after it reached a bounded execution limit.",
      recovery: "Retry with a narrower request, or inspect the run's tool activity if the same limit repeats.",
      retryable: false,
    };
  }
  if (/database_schema_out_of_date|database migrations?.{0,40}out of date/i.test(raw)) {
    return {
      code: "database_schema_out_of_date",
      message: "Workbase's database migrations are out of date.",
      recovery: "Run npm run db:prepare, restart the application, and retry this message.",
      retryable: false,
    };
  }
  if (
    /runtime_schema_mismatch|unknown argument [`\"]?(?:productImportance|implementationBreadth|technicalDifficulty|distinctiveness)|\bP202[12]\b|column .* does not exist/i.test(raw)
  ) {
    return {
      code: "runtime_schema_mismatch",
      message: "Workbase's generated database client or deployed schema is out of date.",
      recovery: "Run npm run db:prepare, restart the application, and retry this message.",
      retryable: false,
    };
  }
  if (/database_unavailable|ECONNREFUSED|connection (?:failed|terminated|timed out)|can't reach database/i.test(raw)) {
    return {
      code: "database_unavailable",
      message: "Workbase could not reach the project database.",
      recovery: "Check the database connection and retry.",
      retryable: true,
    };
  }
  if (
    providerFailure &&
    (
      providerFailure.retryable === false ||
      providerFailure.code === "response_blocked" ||
      providerFailure.code === "model_capability_error" ||
      providerFailure.status === 400 ||
      providerFailure.status === 401 ||
      providerFailure.status === 402 ||
      providerFailure.status === 403 ||
      providerFailure.status === 404 ||
      providerFailure.status === 422
    )
  ) {
    return {
      code: "model_provider_unavailable",
      message:
        providerFailure.code === "response_blocked"
          ? "The model provider blocked this response."
          : "The configured model provider rejected this request.",
      recovery:
        providerFailure.code === "response_blocked"
          ? "Revise the request or review the project content-policy constraints before trying again."
          : "Check model access, billing, provider routing, and required capabilities before retrying.",
      retryable: false,
    };
  }
  if (
    providerFailure?.retryable === true ||
    providerFailure?.status === 408 ||
    providerFailure?.status === 409 ||
    providerFailure?.status === 425 ||
    providerFailure?.status === 429 ||
    (providerFailure?.status != null && providerFailure.status >= 500) ||
    /\b(?:ThrottlingException|ServiceUnavailableException|ModelTimeoutException|ModelErrorException|ValidationException)\b|bedrock.{0,80}(?:timed out|unavailable|throttl|failed)|(?:model|provider) request (?:timed out|failed)|model provider did not complete/i.test(raw)
  ) {
    return {
      code: "model_provider_unavailable",
      message: "The model provider did not complete this request.",
      recovery: "Your project data is intact. Retry the message; Workbase will reuse completed retrieval and repository work where possible.",
      retryable: true,
    };
  }
  if (
    /GitHub API (?:request failed|rate limit exceeded)|repository (?:request|read|refresh).{0,60}(?:failed|timed out|unavailable)|attached repository could not be read/i.test(raw)
  ) {
    return {
      code: "repository_provider_unavailable",
      message: "The attached repository could not be read completely for this request.",
      recovery: "Any verified findings already saved remain available. Retry to continue the bounded repository work.",
      retryable: true,
    };
  }
  if (/shared repository refresh did not complete within the durable wait window/i.test(raw)) {
    return {
      code: "shared_refresh_timeout",
      message: "The shared repository refresh did not finish within the durable wait window.",
      recovery: "Retry the message; Workbase will reuse the shared refresh if it completed later.",
      retryable: true,
    };
  }
  return {
    code: "workflow_failed",
    message: "Workbase could not complete this request before the run ended.",
    recovery: "Your saved project context is intact. Retry the message; if the issue repeats, use the displayed run ID to inspect its progress events.",
    retryable: true,
  };
}
