import { createHash } from "node:crypto";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedCitationIndexes(value: unknown) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((index) =>
      typeof index !== "number" || !Number.isInteger(index) || index < 1
    )
  ) {
    return null;
  }
  return Array.from(new Set(value as number[])).sort((left, right) => left - right);
}

/**
 * Hashes exactly the claim fields assessed by the repository entailment critic.
 * Array presentation order is irrelevant; positional claim keys and citation
 * membership remain part of the attestation.
 */
export function repositorySynthesisClaimContentDigest(value: unknown) {
  const subsystems = record(value)?.subsystems;
  if (!Array.isArray(subsystems)) return null;
  const claims: Array<Record<string, unknown>> = [];
  for (const candidate of subsystems) {
    const subsystem = record(candidate);
    const subsystemKey = typeof subsystem?.subsystemKey === "string"
      ? subsystem.subsystemKey.trim()
      : "";
    if (
      !subsystemKey ||
      !Array.isArray(subsystem?.facts) ||
      !Array.isArray(subsystem.highlights)
    ) {
      return null;
    }
    for (const [index, candidateFact] of subsystem.facts.entries()) {
      const fact = record(candidateFact);
      const statement = typeof fact?.statement === "string"
        ? fact.statement.trim()
        : "";
      const citationIndexes = normalizedCitationIndexes(fact?.citationIndexes);
      if (!statement || !citationIndexes) return null;
      claims.push({
        claimKey: `${subsystemKey}:fact:${index + 1}`,
        kind: "fact",
        statement,
        citationIndexes,
      });
    }
    for (const [index, candidateHighlight] of subsystem.highlights.entries()) {
      const highlight = record(candidateHighlight);
      const text = typeof highlight?.text === "string" ? highlight.text.trim() : "";
      const summary = typeof highlight?.summary === "string"
        ? highlight.summary.trim()
        : "";
      const citationIndexes = normalizedCitationIndexes(highlight?.citationIndexes);
      if (!text || !summary || !citationIndexes) return null;
      claims.push({
        claimKey: `${subsystemKey}:highlight:${index + 1}`,
        kind: "highlight",
        text,
        summary,
        citationIndexes,
      });
    }
  }
  claims.sort((left, right) =>
    String(left.claimKey).localeCompare(String(right.claimKey))
  );
  return createHash("sha256").update(JSON.stringify(claims)).digest("hex");
}
