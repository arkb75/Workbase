# Repository knowledge comparison against `main`

Date: 2026-08-31

## Control and method

The control is the extraction implementation at `main` commit
`e470dcb3534ee8eb9c0c1030a4a58adc9c25f404`. The
`feature/highlights-atlas-coverage` branch changes UI and view-model files but
does not change inventory, semantic analysis, synthesis, reconciliation, or
provider code, so it has the same extraction behavior as this control.

Both variants ran the production repository lifecycle against the same pinned
repository commits. Their normalized observations were rescored with
`repository-knowledge-evaluator-v6`. The two outcome aggregates use 70% macro
average and 30% worst project. Within each outcome, harmonic means make a zero
required component visible instead of averaging it away.

The matched outcome comparison contains Backer, SoloPilot, CircleFund,
Workbase, and InsightUBC. The `main` run failed during Amazon inventory before
analysis, while the hybrid run completed Amazon; lifecycle completion is
therefore reported separately rather than silently dropping the failure.

## Product outcomes

| Outcome | `main` | Hybrid v69 | Change |
|---|---:|---:|---:|
| Repository Knowledge Score | 0.192 | 0.754 | +0.562 |
| Highlight Generation Score | 0.087 | 0.472 | +0.385 |
| Completed repositories | 5/6 | 6/6 | +1 repository |

The Repository Knowledge Score measures implemented capability/domain coverage,
grounding, and implemented-versus-planned correctness. The Highlight Generation
Score independently measures expected/major-capability salience, Highlight-only
grounding, domain coverage, and non-redundancy. Raw Highlight count is diagnostic
only and does not increase either score by itself.

## What improved

| Matched-five component (macro average) | `main` | Hybrid v69 | Change |
|---|---:|---:|---:|
| Knowledge coverage axis | 0.138 | 0.694 | +0.556 |
| Knowledge grounding axis | 0.692 | 0.933 | +0.241 |
| Implemented capability recall | 0.112 | 0.627 | +0.515 |
| Major capability recall | 0.107 | 0.643 | +0.537 |
| Domain recall | 0.333 | 1.000 | +0.667 |
| Highlight salience axis | 0.062 | 0.330 | +0.269 |
| Highlight capability recall | 0.057 | 0.316 | +0.259 |
| Major Highlight capability recall | 0.067 | 0.352 | +0.285 |
| Highlight grounding axis | 0.642 | 0.909 | +0.267 |
| Highlight presentation axis | 0.200 | 0.891 | +0.691 |
| Raw Highlights | 13 | 28 | +15 |

The largest knowledge gain is breadth: the hybrid system recovers substantially
more implemented and major capabilities across every expected domain. The
Highlight gain is also real, but smaller: the new path grounds and distributes
Highlights better while still selecting too few of the expected salient
capabilities in several repositories.

## Per-project outcomes

| Repository | Knowledge `main` → hybrid | Highlights `main` → hybrid | Highlight count `main` → hybrid |
|---|---:|---:|---:|
| Backer | 0.384 → 0.914 | 0.304 → 0.542 | 3 → 6 |
| SoloPilot | 0.000 → 0.595 | 0.000 → 0.348 | 4 → 5 |
| CircleFund | 0.546 → 0.940 | 0.000 → 0.882 | 2 → 6 |
| Workbase | 0.000 → 0.710 | 0.000 → 0.342 | 0 → 6 |
| InsightUBC | 0.440 → 0.949 | 0.316 → 0.523 | 4 → 5 |

The hybrid Amazon run scored 0.905 for repository knowledge and 0.730 for
Highlight generation with six Highlights. There is no comparable `main` score
because the control failed before producing knowledge.

## Cost and remaining regressions

| Matched-five operation | `main` | Hybrid v69 | Change |
|---|---:|---:|---:|
| Model calls | 30 | 179 | +149 (+497%) |
| Tokens | 109,241 | 648,092 | +538,851 (+493%) |
| Estimated cost | $0.314 | $1.238 | +$0.924 (+294%) |
| Duration | 1,351,351 ms | 1,350,694 ms | effectively flat |

The architecture materially improves repository understanding, but it is not a
release-quality efficiency result yet. The comparison gate correctly fails on
model calls, tokens, and cost. InsightUBC also regresses in Highlight grounding
(1.000 to 0.806), and coverage calibration declines on Backer, SoloPilot, and
Workbase. SoloPilot and Workbase remain the weakest Highlight-selection cases.

The recurring five-or-six output is not evidence of quality: the scorer does not
reward count, and Highlight salience remains only 0.330 on average. The next
optimization target should therefore be better evidence-backed salience per
call, followed by removal of redundant analysis/model passes—not a higher fixed
Highlight quota.

## Integrity note

The control observations came from fresh database-backed production lifecycle
runs. The final matched comparison consumed their serialized neutral observation
contract so both variants could be rescored under the same v6 policy. The
comparator therefore marks execution-integrity identity as self-attested at the
comparison stage. This does not invalidate the output-quality measurements, but
it means provider/policy identity is not a controlled ablation. The quality and
operational conclusions above should be read as product-behavior comparison,
not as a claim that orchestration alone caused every delta.
