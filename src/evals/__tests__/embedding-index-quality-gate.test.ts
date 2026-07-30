import { describe, expect, it } from "vitest";
import {
  evaluateEmbeddingIndexQualityGate,
  type EmbeddingQualityGateInput,
} from "@/src/evals/embedding-index-quality-gate";

const historicalTitanQuality: EmbeddingQualityGateInput = {
  mode: "promotion",
  activeRecallAt10: 1,
  activeMrr: 0.9375,
  candidateRecallAt10: 1,
  candidateMrr: 0.8125,
  historicalRecallAt10: 1,
  historicalMrr: 0.8125,
  requiredSourceLoss: 0,
  candidateStatus: "ready",
  candidateReconciledAt: "2026-07-29T12:00:00.000Z",
  candidateBaseActivationEpoch: 1,
  activeActivationEpoch: 1,
};

describe("embedding index quality gates", () => {
  it("does not weaken normal promotion criteria for a historical rollback index", () => {
    const result = evaluateEmbeddingIndexQualityGate(historicalTitanQuality);

    expect(result.thresholds).toMatchObject({
      basis: "current_active_and_historical_fixture",
      recallAt10Minimum: 1,
      mrrMinimum: 0.9375,
    });
    expect(result.checks.candidateMrr).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("accepts historical Titan quality only in explicit rollback mode", () => {
    const result = evaluateEmbeddingIndexQualityGate({
      ...historicalTitanQuality,
      mode: "rollback",
    });

    expect(result.thresholds).toMatchObject({
      basis: "historical_fixture",
      recallAt10Minimum: 1,
      mrrMinimum: 0.8125,
    });
    expect(result.passed).toBe(true);
  });

  it("rejects rollback when the candidate loses a required active source", () => {
    const result = evaluateEmbeddingIndexQualityGate({
      ...historicalTitanQuality,
      mode: "rollback",
      requiredSourceLoss: 1,
    });

    expect(result.checks.zeroRequiredSourceLoss).toBe(false);
    expect(result.passed).toBe(false);
  });

  it("rejects a rollback candidate that is not ready at the active epoch", () => {
    const result = evaluateEmbeddingIndexQualityGate({
      ...historicalTitanQuality,
      mode: "rollback",
      candidateBaseActivationEpoch: 0,
    });

    expect(result.checks.candidateReconciled).toBe(false);
    expect(result.passed).toBe(false);
  });
});
