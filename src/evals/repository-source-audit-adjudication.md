# Repository source-audit adjudication

This procedure compares saved repository knowledge against an independently
authored, commit-pinned source audit. It evaluates semantic coverage; it does
not infer quality from item count, file count, keyword overlap, or refresh
completion alone.

## Inputs and provenance gate

Use one source-audit repository entry, one completed database observation, and
one human adjudication record. Before scoring:

1. Require the observation repository and commit to equal the audit entry.
2. Verify the audit source digest against a clean checkout at that commit.
3. Require database execution integrity to pass. For agentic runs this includes
   exact source, commit, blob, range, excerpt-hash, investigator-read-set, and
   independent-verifier attestations.
4. Grade only current active, automatically applied Facts and Highlights that
   the selected refresh created or revalidated. The observer excludes
   user-authored rows so manual editing cannot inflate extraction quality. Do
   not grade provisional notebooks or model self-reports.

A failed provenance gate is an invalid run, not a low semantic score.

## Frozen audit universe

The `2026-09-04` source-audit fixture covers four independently inspected,
commit-pinned repositories. These counts describe the scoring universe rather
than targets for generated output; in particular, they do not impose a fixed
number of Highlights.

| Repository fixture | Units | Implemented | Partial | Planned | Absent | Major | Supporting | Must Highlight | Should Highlight | Not expected | Anchors | Questions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SoloPilot | 31 | 22 | 3 | 1 | 5 | 20 | 11 | 10 | 10 | 11 | 108 | 10 |
| Backer | 17 | 12 | 0 | 0 | 5 | 12 | 5 | 8 | 4 | 5 | 52 | 13 |
| CircleFund | 12 | 6 | 0 | 1 | 5 | 7 | 5 | 4 | 2 | 6 | 51 | 12 |
| Otto | 24 | 13 | 0 | 0 | 11 | 16 | 8 | 8 | 5 | 11 | 93 | 17 |
| **Total** | **84** | **53** | **3** | **2** | **26** | **55** | **29** | **30** | **21** | **33** | **304** | **52** |

The state columns partition all 84 units. Importance partitions them
independently into 55 major and 29 supporting units. Highlight relevance is a
separate expectation: only source-confirmed implemented units may be marked
`must` or `should`; partial, planned, and absent units are never rewarded as
implementation Highlights.

## Unit fidelity rubric

For every audited knowledge unit, compare the union of saved Fact and Highlight
text, summaries, and attached evidence with the audited claim and uncertainty.
Use the same scale for `knowledgeCoverage`, `highlightCoverage`, and (when the
unit has an `uncertainty`) `qualifierCoverage`:

| Label | Value | Meaning |
| --- | ---: | --- |
| `full` | 1.00 | The central operation and its material boundary are recoverable. |
| `substantial` | 0.75 | The central operation is recoverable with one material omission. |
| `partial` | 0.50 | A meaningful subsystem slice is present, but not the end-to-end capability. |
| `tangential` | 0.25 | Only a helper, schema, test, README signal, or similarly indirect fragment is present. |
| `none` | 0.00 | No saved item faithfully represents the unit. |

`knowledgeCoverage` may use Facts and Highlights together.
`highlightCoverage` may use Highlights only. One coherent item may cover
multiple units, and multiple fragments may combine into one unit score. Do not
award implementation coverage merely because a README, type, route test, or
database field names the concept.

Set the other unit fields as follows:

- `evidenceSupported`: true only when the attached pinned-source ranges support
  every material clause used for the unit score. Citation existence alone is
  insufficient.
- `stateCorrect`: true when the saved knowledge that addresses the unit
  preserves implemented, partial, planned, or absent state.
- `qualifierCoverage`: grade the material boundary in `uncertainty`; use null
  only when the audited unit has no uncertainty.
- `contradictsAudit`: true when any current saved item materially asserts the
  opposite of the audited source truth.

Silence is neutral for state precision but receives no recall. In particular,
an unmentioned absent or planned unit does not receive constraint credit.

The aggregator reports:

- major and importance-weighted knowledge recall;
- must and relevance-weighted Highlight recall;
- semantic grounding over faithfully matched units;
- state correctness over addressed units;
- qualifier preservation;
- constraint recall over all planned or absent units;
- constraint correctness over addressed planned or absent units; and
- contradiction rate over the frozen audit universe.

## Highlight salience

Adjudicate every saved Highlight exactly once:

- `major_operation`: a coherent, source-faithful central operation;
- `supporting_insight`: useful supporting architecture, integration, data, or
  operational detail; or
- `low_value`: a tangential fragment, misleading abstraction, or attention that
  should not displace a central operation.

Record every audited unit it faithfully covers in `matchedUnitIds`. Set
`semanticDuplicateOf` when a Highlight adds no material operation or boundary
beyond another saved Highlight. A duplicate receives zero effective salience,
regardless of its label.

`highlightSalience` averages 1.0 for non-duplicate major operations, 0.5 for
non-duplicate supporting insights, and 0 otherwise across all saved
Highlights. `majorHighlightAllocationRate` and `duplicateHighlightRate` expose
the allocation separately. This prevents a larger output count from masking
atomization or repetition. It does not impose a target Highlight count.

## User-question answerability

Adjudicate every independently authored `userQuestions` entry exactly once.
Ask: could a competent answerer, using only the saved Facts and Highlights,
give a correct answer that includes the material negative, security, state, and
constraint boundaries? Apply the same five-point fidelity scale and identify
the relevant audit units in `supportingUnitIds`.

Set `evidenceSupported`, `stateCorrect`, and `contradictsAudit` for the proposed
answer. The reported `questionAnswerability` gives a question zero credit when
any of those gates fails. `fullyAnswerableQuestionRate` is the stricter share of
questions receiving a grounded, correct 1.00.

This measures knowledge-base answerability, not chat-model fluency: do not ask a
second model to fill gaps from its own repository access.

## Aggregation data shape

Export a packet for any audited fixture, including fixtures that are not part
of the legacy repository-evaluation catalog:

```sh
npx tsx --env-file=.env scripts/export-repository-source-audit-packet.ts \
  --fixture <source-audit-fixture-id> \
  --work-item <work-item-id> \
  --compact
```

The exporter is read-only and does not trigger repository analysis or a model
call. It emits source units, questions, saved Facts and Highlights, line ranges,
quotes, execution integrity, and blank adjudication arrays. An integrity-failed
run is still inspectable, but `observation.adjudicationEligible` remains false
and its semantic score must not be presented as a certified main-path result.

Copy `adjudicationTemplate` into a separate JSON file and fill every entry,
leaving the three top-level arrays named `unitAdjudications`,
`highlightAdjudications`, and `questionAdjudications`. Score it with:

```sh
npm run --silent eval:repository-source-audit:score -- \
  --packet <packet.json> \
  --adjudication <filled-adjudication.json> \
  --repository-root <clean-checkout-at-audited-commit>
```

The scorer requires the repository root itself (not a directory inside it), a
clean tracked working tree, and `HEAD` at the audited commit. It recomputes the
digest from every pinned audit range before emitting a verified score. It also
validates packet identity and saved-output counts, then requires an exact
adjudication set for all audited units, independently authored questions, and
actually saved Highlights. The resulting artifact includes deterministic input
digests, repository and Work Item provenance, execution certification, the
normalized per-unit/per-question decisions needed for later comparison,
diagnostics, and semantic outcome metrics. It has no target Highlight count and
treats all output counts as diagnostics only.

An ineligible packet is rejected by default. For a pre-attestation baseline
that is intentionally being retained as a historical output-quality control,
add `--historical-control`. The resulting report remains labeled
`historical_control`; the flag does not convert it into a certified current
main-path run.

## Comparing the current suite with source truth and historical controls

After scoring every current run and the three commit-matched historical
controls, compare the complete frozen suite with:

```sh
npm run --silent eval:repository-source-audit:compare -- \
  --manifest src/evals/fixtures/repository-source-audits-v1.json \
  --current-score <solopilot-current-score.json> \
  --current-score <backer-current-score.json> \
  --current-score <circlefund-current-score.json> \
  --current-score <otto-current-score.json> \
  --historical-score <solopilot-historical-score.json> \
  --historical-score <backer-historical-score.json> \
  --historical-score <circlefund-historical-score.json> \
  --require-historical solopilot-agent-documents \
  --require-historical backer-marketplace \
  --require-historical circlefund-fintech
```

The comparator fails closed unless the current score set exactly covers the
frozen manifest and every score carries matching clean-checkout source
verification. It reports:

- direction-aware gaps from source truth for every semantic metric;
- the exact incomplete or incorrect source units and user questions;
- per-metric, per-unit, and per-question changes for every matched historical
  control;
- Otto (or any other unmatched current fixture) in a separate current-only
  holdout section; and
- whether the declared comparison gate passes.

The default comparison gate requires substantial-or-better coverage for every
major implemented/partial unit, every must-Highlight unit, and every grounded,
state-correct audit question; no contradictions; and no semantic regression
against a matched control. `--require-historical` makes missing baselines fail
the gate rather than disappear from the comparison.

Fact and Highlight counts remain in `diagnostics` only. They never contribute
to a source-truth gap, a regression decision, or the comparison gate. Thus a
run with five or fifty Highlights wins only by representing the audited project
more faithfully, not by producing more records.

Pass the audited repository entry and the current Highlight IDs to
`aggregateRepositorySourceAuditOutcome` with this shape:

```ts
{
  repository,
  unitAdjudications: [{
    unitId,
    knowledgeCoverage,
    highlightCoverage,
    evidenceSupported,
    stateCorrect,
    qualifierCoverage,
    contradictsAudit,
  }],
  observedHighlightIds,
  highlightAdjudications: [{
    highlightId,
    matchedUnitIds,
    salience,
    semanticDuplicateOf,
  }],
  questionAdjudications: [{
    question,
    answerability,
    supportingUnitIds,
    evidenceSupported,
    stateCorrect,
    contradictsAudit,
  }],
}
```

The function rejects missing, duplicate, or unknown units, questions, and
Highlights so a favorable subset cannot be reported as a complete run.
