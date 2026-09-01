# Generalized repository knowledge: final quality checkpoint

Date: 2026-09-01

## Decision

The generalized main path at `297d817` is the release candidate. It improves
quality over the original `main` / `feature/highlights-atlas-coverage`
extractor, the v69 orchestrated checkpoint, and the pre-efficiency generalized
build at `b777b27`.

The accepted efficiency work reduces aggregate model calls, tokens, cost, and
elapsed time while the strict matched-fixture non-inferiority comparator passes
without a regression. A prior critic-batching experiment remains rejected; its
lower call count did not justify its measured knowledge and Highlight losses.
No budget or quality threshold was relaxed to make either decision appear
green.

## What changed

- Repository-derived cartography plans semantic work from project domains,
  architectural areas, files, symbols, and operation families. Runtime logic
  contains no Workbase-, fixture-, or expected-capability-specific rules.
- Bounded repair prioritizes missing evidence floors, then operation diversity,
  and allows one final exact-file retry when a large file could not be grounded
  from discontinuous excerpts.
- Reconciliation preserves distinct operations rather than collapsing facts
  that merely share a subsystem or vocabulary.
- Synthesis remains model-first and fail-closed. The entailment critic alone may
  make one quality-approved retry after a transient provider failure; deep
  synthesis has no deterministic fallback and no second provider attempt.
- Highlight selection evaluates every verified Fact against an absolute bar and
  selects the natural number supported by the repository. There is no target,
  minimum, maximum quota below the eligible candidate set, or per-domain quota.
- Semantic excerpts use a byte-budget-scaled number of cohesive windows rather
  than many shallow fragments. This preserves citation continuity without an
  extra model pass.
- Highlight selection receives operation-community identity and performs
  relevance-first, coverage-aware set selection. It keeps distinct workflows
  apart even when they share implementation vocabulary, while avoiding generic
  persistence details when a concrete project behavior is available.
- The existing title critic can repair a title-only issue in its current call;
  evidence mismatches and unsupported content still fail closed.
- Provider pacing is reactive rather than unconditional. Transient attempts use
  bounded same-model retries and retain exact attempt accounting; deterministic
  knowledge fallbacks are not the default path.
- Evaluator v7 treats a checked-out source path as disambiguating context only
  when the exact cited excerpt independently overlaps at least one bounded set
  of distinctive claim terms. A filename alone cannot ground a claim. Large
  Highlight selections require a canonical count and SHA-256 digest; truncated
  preview attestations are not certified as exact.

The bounded critic retry follows OpenRouter's documented provider/model fallback
semantics: failover is reserved for unavailable or rate-limited providers, not
used as the primary route or as a substitute for rejected evidence.
[Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
and [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)
describe those platform behaviors.

## Evaluation method

All variants were scored against the same pinned commits of six real projects:
Backer, SoloPilot, CircleFund, Workbase, InsightUBC, and Amazon Marketplace
Analytics. The catalog spans six archetypes and five language families.

The v69 and original-main observations were rescored under the same
`repository-knowledge-evaluator-v7` quality semantics. The final result was
loaded directly from the database adapter so model identities, provider
attempts, policy versions, candidate partitions, and result attestations were
recertified rather than trusted from serialized JSON.

Final database-certified report SHA-256:
`245dd85d3a1e72953a6f9ba4df2de9544712e41d18e14c5de7f4c4fcaf372bc6`.

## Release checkpoints

| Checkpoint | Ref | Purpose |
|---|---|---|
| Original main | `checkpoint/repository-knowledge-main` (`e470dcb`) | Pre-orchestration implementation |
| Current orchestrated baseline | `checkpoint/repository-knowledge-current-v69` (`dcfe725`) | General v69 comparison point |
| Pre-efficiency quality release | `checkpoint/repository-knowledge-pre-efficiency-v86` (`b777b27`) | Comparison baseline requested for efficiency work |
| Accepted efficient release | `297d817` | Scope-calibrated, coverage-aware generalized main path |

## Progression on the five projects completed by original main

| Outcome | Original main | Orchestrated v69 | Pre-efficiency quality build |
|---|---:|---:|---:|
| Overall score | 0.482 | 0.799 | 0.869 |
| Repository knowledge | 0.195 | 0.762 | 0.877 |
| Highlight generation | 0.088 | 0.481 | 0.826 |
| Completed repositories | 5/6 | 6/6 | 6/6 |

Original main failed Amazon during inventory. The later variants completed it,
so the table uses the matched five for the three-way score comparison and
reports lifecycle completion separately.

## Pre-efficiency quality build versus the current v69 checkpoint

| Outcome | v69 | Pre-efficiency | Change |
|---|---:|---:|---:|
| Overall score | 0.804 | 0.870 | +0.066 |
| Repository knowledge | 0.773 | 0.880 | +0.107 |
| Highlight generation | 0.504 | 0.826 | +0.322 |
| Execution integrity | passed | passed | no regression |

Every project improved in overall score and repository-knowledge score at this
intermediate checkpoint.
Highlight generation improves on five projects and ties on CircleFund.

| Project | Overall v69 → pre-efficiency | Knowledge v69 → pre-efficiency | Highlights v69 → pre-efficiency | Count v69 → pre-efficiency |
|---|---:|---:|---:|---:|
| Backer | 0.857 → 0.894 | 0.920 → 0.934 | 0.542 → 0.907 | 6 → 18 |
| SoloPilot | 0.712 → 0.808 | 0.600 → 0.805 | 0.349 → 0.749 | 5 → 21 |
| CircleFund | 0.926 → 0.972 | 0.948 → 0.993 | 0.930 → 0.930 | 6 → 12 |
| Workbase | 0.753 → 0.828 | 0.710 → 0.825 | 0.342 → 0.770 | 6 → 26 |
| InsightUBC | 0.935 → 0.975 | 0.981 → 0.982 | 0.538 → 0.938 | 5 → 11 |
| Amazon analytics | 0.880 → 0.903 | 0.922 → 0.932 | 0.735 → 0.857 | 6 → 9 |

At this checkpoint, output counts varied naturally from 9 to 26 according to
the verified Fact surface. Count itself receives no score; the gain comes from
capability coverage, salience, grounding, domain breadth, and non-redundancy.

## Accepted efficiency result

The comparison uses the same six pinned projects, evaluator v7, model roles,
and database attestation path as the pre-efficiency build.

| Six-project outcome | Pre-efficiency | Accepted | Change |
|---|---:|---:|---:|
| Overall score | 0.870 | 0.887 | +1.95% |
| Repository knowledge | 0.880 | 0.895 | +1.69% |
| Highlight generation | 0.826 | 0.850 | +2.92% |
| Macro-average score | 0.897 | 0.920 | +2.59% |
| Minimum project score | 0.808 | 0.810 | +0.29% |
| Model calls | 364 | 333 | -8.52% |
| Tokens | 1,191,701 | 1,146,094 | -3.83% |
| Estimated cost | $2.239 | $2.121 | -5.28% |
| Duration | 2,481,160 ms | 2,188,180 ms | -11.81% |

The formal comparison passed. Execution integrity passed on every repository,
the exact model identities matched, and all fixture-level deltas were either
improvements or within the declared non-inferiority tolerances.

Highlight counts remained repository-shaped rather than fixed: Backer 14,
SoloPilot 21, CircleFund 15, Workbase 24, InsightUBC 8, and Amazon 11. Amazon's
Highlight score rose from 0.857 to 1.000 after scope calibration retained its
distinct product, purchase-order, and forecast workflows instead of a generic
collection-persistence item.

All accepted runs used the model-backed main path. There were no schema-repair
runs or deterministic semantic, synthesis, or planner fallbacks in the new live
runs. The suite's old absolute per-project time/call/token ceilings still make
the aggregate `hardBudgetPassed` flag false; the accepted claim is measured
relative efficiency with non-regressing quality, not that every legacy budget
ceiling has been met.

## Rejected efficiency experiment

The experiment preserved one-subsystem synthesis, but batched up to three
independent initial entailment critics with exact claim-key, subsystem, count,
and content-digest partitions. It also increased the already bounded Highlight
title-critic batch from 10 to 20. This followed the same partition-and-attest
pattern used by the evaluator rather than weakening evidence checks.

The exact-model comparison could not complete because the Luna route repeatedly
returned 429 responses, including with five-second pacing, and also produced one
unrepairable structured planner response. A clean Terra-routed six-project run
passed execution-integrity certification, but failed the quality gate:

| Six-project outcome | Certified release | Rejected candidate | Change |
|---|---:|---:|---:|
| Overall score | 0.870 | 0.853 | -0.017 |
| Repository knowledge | 0.880 | 0.845 | -0.035 |
| Highlight generation | 0.826 | 0.743 | -0.083 |
| Model calls | 364 | 269 | -26% |
| Tokens | 1,191,701 | 1,085,929 | -9% |
| Estimated cost | $2.239 | $2.731 | +22% |
| Duration | 2,481,160 ms | 2,125,163 ms | -14% |

The rejected database-certified report SHA-256 is
`0644f0464838e8f895ec5d560bfc725f8edc4695c730cb95e0e2b9824983f210`.
Its integrity status passed on all six repositories; the rejection is about
measured product quality and cost, not an invalid observation. OpenRouter's
error guidance identifies 429 as a platform or upstream rate-limit condition
and recommends honoring `Retry-After` with exponential backoff. That failure
motivated the accepted reactive cooldown and same-model bounded retry work;
critic batching itself remained rejected.
[Errors and debugging](https://openrouter.ai/docs/api/reference/errors-and-debugging)
and [rate limits](https://openrouter.ai/docs/api/reference/limits) document those
behaviors.

## Known residual gaps

- Backer still misses feed-model training, the investment-commitment workflow,
  and the DynamoDB repository layer in the curated recall oracle.
- SoloPilot meets its evidence and diversity floors but covers 19 of 20 desired
  samples in the large Email Intake domain; metadata/requirement extraction,
  PDF annotation/revision, response evaluation, and provider abstraction remain
  incomplete in the oracle.
- Workbase still misses commit inventory and artifact generation in the curated
  recall oracle.
- Lower-ranked semantic observations can remain outside the bounded synthesis
  notebook even when coverage certification passes.
- Amazon now recovers all curated capability keys and scores 1.000 for Highlight
  generation; two lower-level facts remain outside the evaluator's support
  oracle, so repository-knowledge grounding is 0.932 rather than perfect.
- Further optimization should target duplicated prompt context and provider-side
  cache reuse, and must pass this same exact-model comparison. It should not
  reduce sampling, weaken entailment, introduce a deterministic content
  fallback, or reinstate a fixed Highlight count.
