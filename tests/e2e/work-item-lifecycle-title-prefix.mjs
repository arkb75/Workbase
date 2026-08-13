export function resolveLifecycleTitlePrefix(configuredPrefix, randomSuffix) {
  const fallback = `Lifecycle eval ${randomSuffix}`;
  if (configuredPrefix === undefined || configuredPrefix === null) return fallback;
  if (typeof configuredPrefix !== "string") {
    throw new Error("WORKBASE_LIFECYCLE_TITLE_PREFIX must be a string.");
  }
  const normalized = configuredPrefix.trim();
  if (
    normalized.length < "Lifecycle eval ".length + 1 ||
    normalized.length > 120 ||
    !normalized.startsWith("Lifecycle eval ") ||
    !/^[A-Za-z0-9 _.-]+$/.test(normalized)
  ) {
    throw new Error(
      "WORKBASE_LIFECYCLE_TITLE_PREFIX must start with 'Lifecycle eval ', contain only letters, digits, spaces, '.', '_' or '-', and be at most 120 characters.",
    );
  }
  return normalized;
}
