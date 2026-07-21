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
    | "repository_provider_unavailable"
    | "shared_refresh_timeout"
    | "workflow_failed";
  message: string;
  recovery: string | null;
  retryable: boolean;
}

export function classifyWorkflowFailure(error: unknown): ClassifiedWorkflowFailure {
  const raw = errorMessageFromUnknown(error);
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
