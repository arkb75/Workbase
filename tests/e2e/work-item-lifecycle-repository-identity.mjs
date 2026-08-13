export function resolveLifecycleRepositoryIdentity(input) {
  const selectedRepositoryId = String(input.selectedRepositoryId ?? "").trim();
  const selectedRepositoryFullName = String(
    input.selectedRepositoryFullName ?? "",
  ).trim();
  const expectedRepositoryId = String(input.expectedRepositoryId ?? "").trim();
  const configuredRepositoryFullName = String(
    input.configuredRepositoryFullName ?? "",
  ).trim();

  if (!expectedRepositoryId || selectedRepositoryId !== expectedRepositoryId) {
    throw new Error(
      `The application selected repository ID ${JSON.stringify(selectedRepositoryId || null)}; the lifecycle gate requires exact ID ${JSON.stringify(expectedRepositoryId || null)}.`,
    );
  }
  if (!/^[^/\s]+\/[^/\s]+$/u.test(selectedRepositoryFullName)) {
    throw new Error(
      `Repository ID ${expectedRepositoryId} did not resolve to a valid canonical owner/repository name.`,
    );
  }

  return {
    repositoryId: selectedRepositoryId,
    fullName: selectedRepositoryFullName,
    configuredFullName: configuredRepositoryFullName,
    canonicalized: configuredRepositoryFullName !== selectedRepositoryFullName,
  };
}
