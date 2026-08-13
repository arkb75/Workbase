export type EmbeddingQualityGateMode = "promotion" | "rollback";

export type EmbeddingQualityGateInput = {
  mode: EmbeddingQualityGateMode;
  activeRecallAt10: number | null;
  activeMrr: number | null;
  candidateRecallAt10: number;
  candidateMrr: number;
  historicalRecallAt10: number;
  historicalMrr: number;
  requiredSourceLoss: number;
  candidateStatus: string;
  candidateReconciledAt: string | null;
  candidateBaseActivationEpoch: number;
  activeActivationEpoch: number;
};

export function evaluateEmbeddingIndexQualityGate(
  input: EmbeddingQualityGateInput,
) {
  const validMetric = (value: number | null): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const qualityMetricsValid =
    validMetric(input.candidateRecallAt10) &&
    validMetric(input.candidateMrr) &&
    validMetric(input.historicalRecallAt10) &&
    validMetric(input.historicalMrr) &&
    (
      input.mode === "rollback" ||
      (validMetric(input.activeRecallAt10) && validMetric(input.activeMrr))
    );
  const recallAt10Minimum = input.mode === "rollback"
    ? validMetric(input.historicalRecallAt10)
      ? input.historicalRecallAt10
      : null
    : validMetric(input.activeRecallAt10) && validMetric(input.historicalRecallAt10)
      ? Math.max(input.activeRecallAt10, input.historicalRecallAt10)
      : null;
  const mrrMinimum = input.mode === "rollback"
    ? validMetric(input.historicalMrr)
      ? input.historicalMrr
      : null
    : validMetric(input.activeMrr) && validMetric(input.historicalMrr)
      ? Math.max(input.activeMrr, input.historicalMrr)
      : null;
  const sourceIntegrityInputValid =
    Number.isInteger(input.requiredSourceLoss) && input.requiredSourceLoss >= 0;
  const checks = {
    qualityMetricsValid,
    candidateRecallAt10:
      qualityMetricsValid &&
      recallAt10Minimum !== null &&
      input.candidateRecallAt10 + Number.EPSILON >= recallAt10Minimum,
    candidateMrr:
      qualityMetricsValid &&
      mrrMinimum !== null &&
      input.candidateMrr + Number.EPSILON >= mrrMinimum,
    sourceIntegrityInputValid,
    zeroRequiredSourceLoss:
      sourceIntegrityInputValid && input.requiredSourceLoss === 0,
    candidateReady: input.candidateStatus === "ready",
    candidateReconciled:
      input.candidateReconciledAt !== null &&
      input.candidateBaseActivationEpoch === input.activeActivationEpoch,
  };

  return {
    mode: input.mode,
    thresholds: {
      basis: input.mode === "rollback"
        ? "historical_fixture"
        : "current_active_and_historical_fixture",
      recallAt10Minimum,
      mrrMinimum,
      requiredSourceLossMustBeZero: true,
      candidateMustBeReady: true,
      candidateMustBeReconciledToActivationEpoch: input.activeActivationEpoch,
    },
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}
