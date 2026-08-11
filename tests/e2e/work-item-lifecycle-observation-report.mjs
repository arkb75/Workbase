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
  return {
    ...prior,
    schemaVersion: input.schemaVersion,
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
