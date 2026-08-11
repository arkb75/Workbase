function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function observationsFromReport(report) {
  return Array.isArray(report.observations) ? report.observations : [];
}

export function appendLifecycleObservationToReport(input) {
  const prior = objectRecord(input.priorReport);
  if (
    typeof prior.gitCommit === "string" &&
    prior.gitCommit.toLowerCase() !== input.gitCommit.toLowerCase()
  ) {
    throw new Error(
      `Lifecycle observation report commit changed from ${prior.gitCommit} to ${input.gitCommit}.`,
    );
  }
  return {
    ...prior,
    schemaVersion: input.schemaVersion,
    gitCommit: input.gitCommit.toLowerCase(),
    live: true,
    baseUrl: input.baseUrl,
    observations: [...observationsFromReport(prior), input.observation],
  };
}

export function removeLifecycleObservationFromReport(input) {
  const prior = objectRecord(input.priorReport);
  return {
    ...prior,
    observations: observationsFromReport(prior).filter((observation) => {
      const record = objectRecord(observation);
      const lineage = objectRecord(record.currentLineage);
      return lineage.workItemId !== input.workItemId;
    }),
  };
}
