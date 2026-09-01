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

function digestNormalizedClaims(claims: Array<Record<string, unknown>>) {
  claims.sort((left, right) =>
    String(left.claimKey).localeCompare(String(right.claimKey))
  );
  return createHash("sha256").update(JSON.stringify(claims)).digest("hex");
}

/** Hashes an explicit, stable-keyed subset sent to a revision critic. */
export function repositorySynthesisCriticClaimContentDigest(value: unknown) {
  if (!Array.isArray(value) || !value.length) return null;
  const claims: Array<Record<string, unknown>> = [];
  const claimKeys = new Set<string>();
  for (const candidate of value) {
    const data = record(candidate);
    const claimKey = typeof data?.claimKey === "string" ? data.claimKey.trim() : "";
    const kind = data?.kind;
    const claim = record(data?.claim);
    const citationIndexes = normalizedCitationIndexes(data?.citationIndexes);
    const keyParts = claimKey.split(":");
    const claimPosition = Number(keyParts.at(-1));
    if (
      !claimKey ||
      claimKeys.has(claimKey) ||
      (kind !== "fact" && kind !== "highlight") ||
      !citationIndexes ||
      keyParts.at(-2) !== kind ||
      !Number.isInteger(claimPosition) ||
      claimPosition < 1
    ) {
      return null;
    }
    claimKeys.add(claimKey);
    if (kind === "fact") {
      const statement = typeof claim?.statement === "string"
        ? claim.statement.trim()
        : "";
      if (!statement) return null;
      claims.push({ claimKey, kind, statement, citationIndexes });
      continue;
    }
    const text = typeof claim?.text === "string" ? claim.text.trim() : "";
    const summary = typeof claim?.summary === "string" ? claim.summary.trim() : "";
    if (!text || !summary) return null;
    claims.push({ claimKey, kind, text, summary, citationIndexes });
  }
  return digestNormalizedClaims(claims);
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
  return digestNormalizedClaims(claims);
}
