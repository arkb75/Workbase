export type EmbeddingQualityGateMode = "promotion" | "rollback";

export type EmbeddingQualityGateInput = {
  mode: EmbeddingQualityGateMode;
  activeRecallAt10: number;
  activeMrr: number;
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
  const recallAt10Minimum = input.mode === "rollback"
    ? input.historicalRecallAt10
    : Math.max(input.activeRecallAt10, input.historicalRecallAt10);
  const mrrMinimum = input.mode === "rollback"
    ? input.historicalMrr
    : Math.max(input.activeMrr, input.historicalMrr);
  const checks = {
    candidateRecallAt10:
      input.candidateRecallAt10 + Number.EPSILON >= recallAt10Minimum,
    candidateMrr: input.candidateMrr + Number.EPSILON >= mrrMinimum,
    zeroRequiredSourceLoss: input.requiredSourceLoss === 0,
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
