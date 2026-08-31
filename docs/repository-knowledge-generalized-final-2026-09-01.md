# Generalized repository knowledge: final quality checkpoint

Date: 2026-09-01

## Decision

The generalized main path is a quality improvement over both the original
`main` / `feature/highlights-atlas-coverage` extractor and the v69 orchestrated
checkpoint. It should replace the current extractor for product testing.

It is not yet an efficiency improvement. The final six-repository suite passes
execution-integrity certification but still fails the existing model-call,
token, and duration ceilings. Those limits have not been relaxed to make the
result appear green.

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
`db351fcbf58ca796e660922e2410c524eb03fa948e5abe0d6b6ced8ed6e34c58`.

## Progression on the five projects completed by original main

| Outcome | Original main | Orchestrated v69 | Final generalized |
|---|---:|---:|---:|
| Overall score | 0.482 | 0.799 | 0.869 |
| Repository knowledge | 0.195 | 0.762 | 0.877 |
| Highlight generation | 0.088 | 0.481 | 0.826 |
| Completed repositories | 5/6 | 6/6 | 6/6 |

Original main failed Amazon during inventory. The later variants completed it,
so the table uses the matched five for the three-way score comparison and
reports lifecycle completion separately.

## Final versus the current v69 checkpoint

| Outcome | v69 | Final | Change |
|---|---:|---:|---:|
| Overall score | 0.804 | 0.870 | +0.066 |
| Repository knowledge | 0.773 | 0.880 | +0.107 |
| Highlight generation | 0.504 | 0.826 | +0.322 |
| Execution integrity | passed | passed | no regression |

Every project improves in overall score and repository-knowledge score.
Highlight generation improves on five projects and ties on CircleFund.

| Project | Overall v69 → final | Knowledge v69 → final | Highlights v69 → final | Count v69 → final |
|---|---:|---:|---:|---:|
| Backer | 0.857 → 0.894 | 0.920 → 0.934 | 0.542 → 0.907 | 6 → 18 |
| SoloPilot | 0.712 → 0.808 | 0.600 → 0.805 | 0.349 → 0.749 | 5 → 21 |
| CircleFund | 0.926 → 0.972 | 0.948 → 0.993 | 0.930 → 0.930 | 6 → 12 |
| Workbase | 0.753 → 0.828 | 0.710 → 0.825 | 0.342 → 0.770 | 6 → 26 |
| InsightUBC | 0.935 → 0.975 | 0.981 → 0.982 | 0.538 → 0.938 | 5 → 11 |
| Amazon analytics | 0.880 → 0.903 | 0.922 → 0.932 | 0.735 → 0.857 | 6 → 9 |

The output counts now vary naturally from 9 to 26 according to the verified
Fact surface. Count itself receives no score; the gain comes from capability
coverage, salience, grounding, domain breadth, and non-redundancy.

## Cost and latency

| Six-project operation | v69 | Final | Change |
|---|---:|---:|---:|
| Model calls | 204 | 364 | +78% |
| Tokens | 733,477 | 1,191,701 | +62% |
| Estimated cost | $1.387 | $2.239 | +61% |
| Duration | 1,508,398 ms | 2,481,160 ms | +64% |

All six final runs used the model-backed main path. There were no schema-repair
runs, deterministic semantic fallbacks, deterministic synthesis fallbacks, or
planner fallbacks in the certified runs. The added cost buys materially broader
knowledge and Highlights, but it is too high to call the efficiency work done.

## Known residual gaps

- Backer still misses feed-model training, the investment-commitment workflow,
  and the DynamoDB repository layer in the curated recall oracle.
- SoloPilot meets its evidence and diversity floors but covers 19 of 20 desired
  samples in the large Email Intake domain; metadata/requirement extraction,
  PDF annotation/revision, response evaluation, and provider abstraction remain
  incomplete in the oracle.
- Workbase still misses commit inventory, semantic synthesis, and knowledge
  review as distinct operation families.
- Amazon still misses purchase-order management.
- Lower-ranked semantic observations can remain outside the bounded synthesis
  notebook even when coverage certification passes.

The next change should be an isolated efficiency experiment: batch compatible
claim verification while preserving claim-level digests and verdicts, then
rerun this exact six-project gate. It should not reduce sampling, weaken
entailment, introduce a deterministic fallback, or reinstate a fixed Highlight
count.
