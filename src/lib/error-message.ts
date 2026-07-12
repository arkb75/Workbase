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
  code: "runtime_schema_mismatch" | "database_unavailable" | "workflow_failed";
  message: string;
  recovery: string | null;
  retryable: boolean;
}

export function classifyWorkflowFailure(error: unknown): ClassifiedWorkflowFailure {
  const raw = errorMessageFromUnknown(error);
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
  const safe = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  return {
    code: "workflow_failed",
    message: safe || "The durable agent run failed without a usable error message.",
    recovery: "Retry the message. If it fails again, inspect the run events using the displayed run ID.",
    retryable: true,
  };
}
