import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  repositorySynthesisClaimContentDigest,
  repositorySynthesisCriticClaimContentDigest,
  repositorySynthesisCriticAssessmentDigest,
} from "@/src/domain/repository-synthesis-attestation";

function synthesis(input: {
  statement?: string;
  summary?: string;
  citationIndexes?: number[];
}) {
  return {
    subsystems: [{
      subsystemKey: "project_domain:payments#scope",
      facts: [{
        statement: input.statement ?? "The service persists payment receipts.",
        citationIndexes: input.citationIndexes ?? [1, 2],
      }],
      highlights: [{
        text: "Built durable receipt storage",
        summary: input.summary ?? "The service records receipts for later retrieval.",
        citationIndexes: input.citationIndexes ?? [1, 2],
      }],
    }],
  };
}

describe("repository synthesis claim attestation", () => {
  it("preserves schema-order assessment hashes across JSONB object-key reordering", () => {
    const assessment = { claimKey: "controller:fact:1", supported: false,
      issues: ["unsupported_detail"], reason: "The cited handler invokes a helper; its implementation is not shown." };
    const original = { assessments: [assessment] };
    const digest = createHash("sha256").update(JSON.stringify(original)).digest("hex");
    expect(repositorySynthesisCriticAssessmentDigest(original)).toBe(digest);
    const reordered = { assessments: [{ issues: assessment.issues, reason: assessment.reason,
      supported: assessment.supported, claimKey: assessment.claimKey }] };
    expect(repositorySynthesisCriticAssessmentDigest(reordered)).toBe(digest);
    for (const change of [{ supported: true }, { issues: [] }, { reason: "Supported." }, { claimKey: "other:fact:1" }]) {
      expect(repositorySynthesisCriticAssessmentDigest({ assessments: [{ ...assessment, ...change }] })).not.toBe(digest);
    }
    expect(repositorySynthesisCriticAssessmentDigest({ assessments: [{ ...assessment, extra: true }] })).toBeNull();
    expect(repositorySynthesisCriticAssessmentDigest({ assessments: [{ ...assessment, reason: 5 }] })).toBeNull();
    expect(repositorySynthesisCriticAssessmentDigest({ assessments: [{ ...assessment, issues: [null] }] })).toBeNull();
    expect(repositorySynthesisCriticAssessmentDigest({ assessments: [assessment], extra: true })).toBeNull();
  });

  it("is stable across presentation-only citation and subsystem ordering", () => {
    const left = synthesis({ citationIndexes: [1, 2, 2] });
    const right = {
      subsystems: [
        {
          subsystemKey: "project_domain:empty#scope",
          facts: [],
          highlights: [],
        },
        {
          ...left.subsystems[0],
          citationIndexes: undefined,
          facts: [{ ...left.subsystems[0]!.facts[0]!, citationIndexes: [2, 1] }],
          highlights: [{
            ...left.subsystems[0]!.highlights[0]!,
            citationIndexes: [2, 1],
          }],
        },
      ],
    };
    const reorderedLeft = {
      subsystems: [left.subsystems[0], right.subsystems[0]],
    };

    expect(repositorySynthesisClaimContentDigest(reorderedLeft)).toBe(
      repositorySynthesisClaimContentDigest(right),
    );
  });

  it("changes when critic-visible wording or citation membership changes", () => {
    const baseline = repositorySynthesisClaimContentDigest(synthesis({}));
    expect(baseline).toMatch(/^[a-f0-9]{64}$/u);
    expect(repositorySynthesisClaimContentDigest(synthesis({
      statement: "The service reads payment receipts.",
    }))).not.toBe(baseline);
    expect(repositorySynthesisClaimContentDigest(synthesis({
      summary: "The service records immutable receipts.",
    }))).not.toBe(baseline);
    expect(repositorySynthesisClaimContentDigest(synthesis({
      citationIndexes: [1, 3],
    }))).not.toBe(baseline);
  });

  it("gives an explicit full claim set the same digest as its synthesis payload", () => {
    const payload = synthesis({});
    expect(repositorySynthesisCriticClaimContentDigest([
      {
        claimKey: "project_domain:payments#scope:fact:1",
        kind: "fact",
        claim: {
          statement: payload.subsystems[0]!.facts[0]!.statement,
        },
        citationIndexes: [2, 1],
      },
      {
        claimKey: "project_domain:payments#scope:highlight:1",
        kind: "highlight",
        claim: {
          text: payload.subsystems[0]!.highlights[0]!.text,
          summary: payload.subsystems[0]!.highlights[0]!.summary,
        },
        citationIndexes: [1, 2],
      },
    ])).toBe(repositorySynthesisClaimContentDigest(payload));
  });

  it("fails closed for malformed claim payloads", () => {
    expect(repositorySynthesisClaimContentDigest({
      subsystems: [{ subsystemKey: "scope", facts: [{}], highlights: [] }],
    })).toBeNull();
    expect(repositorySynthesisCriticClaimContentDigest([])).toBeNull();
    expect(repositorySynthesisCriticClaimContentDigest([
      {
        claimKey: "scope:fact:1",
        kind: "fact",
        claim: { statement: "A supported statement." },
        citationIndexes: [1],
      },
      {
        claimKey: "scope:fact:1",
        kind: "fact",
        claim: { statement: "A duplicate-key statement." },
        citationIndexes: [2],
      },
    ])).toBeNull();
  });
});
