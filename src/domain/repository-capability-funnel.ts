export type RepositoryHighlightOmissionReason =
  | "not_approval_eligible"
  | "no_citations"
  | "unverified_semantic_evidence"
  | "no_implementation_evidence"
  | "roadmap_only"
  | "selector_routine_supporting_detail"
  | "selector_lower_relative_salience"
  | "selector_overlapping_repository_outcome"
  | "selector_not_career_relevant"
  | "critic_unsupported_title"
  | "critic_citation_mismatch"
  | "critic_documentation_only"
  | "duplicate"
  | "not_materialized";

export interface RepositoryHighlightFunnelDecision {
  candidateRef: string;
  factIndex: number;
  outcome: "selected" | "omitted";
  reasons: RepositoryHighlightOmissionReason[];
  materialization?: {
    status: "materialized" | "not_materialized";
    entityId?: string;
  };
}

export interface RepositoryCapabilityFunnelTraceV1 {
  version: 1;
  observations: {
    admittedToSynthesis: number;
  };
  facts: {
    verified: number;
  };
  highlights: {
    eligibleCandidates: number;
    selected: number;
    materialized?: number;
    decisions: RepositoryHighlightFunnelDecision[];
  };
  auditRefs: {
    selectionGenerationRunId?: string;
    criticGenerationRunIds: string[];
  };
}

export function reconcileRepositoryCapabilityFunnelMaterialization(
  trace: RepositoryCapabilityFunnelTraceV1 | undefined,
  entityIdByCandidateRef: ReadonlyMap<string, string>,
): RepositoryCapabilityFunnelTraceV1 | undefined {
  if (!trace) return undefined;
  const decisions = trace.highlights.decisions.map((decision) => {
    if (decision.outcome !== "selected") return decision;
    const entityId = entityIdByCandidateRef.get(decision.candidateRef);
    return entityId
      ? {
          ...decision,
          reasons: decision.reasons.filter((reason) => reason !== "not_materialized"),
          materialization: { status: "materialized" as const, entityId },
        }
      : {
          ...decision,
          reasons: Array.from(new Set([...decision.reasons, "not_materialized" as const])),
          materialization: { status: "not_materialized" as const },
        };
  });
  return {
    ...trace,
    highlights: {
      ...trace.highlights,
      materialized: decisions.filter((decision) =>
        decision.materialization?.status === "materialized"
      ).length,
      decisions,
    },
  };
}

export function mergeRepositoryCapabilityFunnelTraces(
  traces: readonly (RepositoryCapabilityFunnelTraceV1 | undefined)[],
): RepositoryCapabilityFunnelTraceV1 | undefined {
  const present = traces.filter(
    (trace): trace is RepositoryCapabilityFunnelTraceV1 => Boolean(trace),
  );
  if (!present.length) return undefined;
  return {
    version: 1,
    observations: {
      admittedToSynthesis: present.reduce(
        (total, trace) => total + trace.observations.admittedToSynthesis,
        0,
      ),
    },
    facts: {
      verified: present.reduce(
        (total, trace) => total + trace.facts.verified,
        0,
      ),
    },
    highlights: {
      eligibleCandidates: present.reduce(
        (total, trace) => total + trace.highlights.eligibleCandidates,
        0,
      ),
      selected: present.reduce(
        (total, trace) => total + trace.highlights.selected,
        0,
      ),
      materialized: present.reduce(
        (total, trace) => total + (trace.highlights.materialized ?? 0),
        0,
      ),
      decisions: present.flatMap((trace) => trace.highlights.decisions),
    },
    auditRefs: {
      selectionGenerationRunId: present.find(
        (trace) => trace.auditRefs.selectionGenerationRunId,
      )?.auditRefs.selectionGenerationRunId,
      criticGenerationRunIds: Array.from(new Set(present.flatMap(
        (trace) => trace.auditRefs.criticGenerationRunIds,
      ))),
    },
  };
}
