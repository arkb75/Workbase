import { createHash } from "node:crypto";

export type RepositoryOperationCommunityMapping = {
  communities: Array<{
    label: string;
    memberIndexes: number[];
  }>;
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function canonicalRepositoryOperationCommunityMapping(
  value: unknown,
): RepositoryOperationCommunityMapping | null {
  const communities = record(value)?.communities;
  if (!Array.isArray(communities)) return null;

  const canonical: RepositoryOperationCommunityMapping["communities"] = [];
  for (const value of communities) {
    const community = record(value);
    const memberIndexes = community?.memberIndexes;
    if (
      typeof community?.label !== "string" ||
      !Array.isArray(memberIndexes) ||
      memberIndexes.some((index) =>
        typeof index !== "number" || !Number.isInteger(index)
      )
    ) {
      return null;
    }
    canonical.push({
      label: community.label.trim().replace(/\s+/gu, " "),
      memberIndexes: memberIndexes.map((index) => index as number),
    });
  }
  return { communities: canonical };
}

export function repositoryOperationCommunityMappingDigest(value: unknown) {
  const canonical = canonicalRepositoryOperationCommunityMapping(value);
  return canonical
    ? createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
    : null;
}
