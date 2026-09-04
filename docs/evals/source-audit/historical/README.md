# Historical main/highlights source-audit controls

These files preserve a conservative, source-audit-based adjudication of the
three pre-agentic database outputs that existed on `main` and the Highlights
visualization branch. They are historical product-output controls, not
certified executions of the current analysis path.

Every score was produced with `--historical-control`. Each report therefore
retains `certification.status = "historical_control"`,
`currentRunEligible = false`, and the original execution-integrity failures.
The flag does not promote an older run into a valid current run.

All legacy saved outputs now export with `claimState = "unknown"`. These rows
predate the versioned repository-knowledge metadata, so the observer does not
invent an `implemented` state for them. An adjudication marks state correct
only where the saved wording and pinned evidence themselves preserve the
audited current/future/absent distinction; silence about a constraint receives
no constraint credit.

The canonical packets carry source-audit manifest digest
`9c860d9c174729928698e03a6ce6b6a87f045bfb71ca127f42ef6bab1954d186`.
That digest includes the independent-review correction to the separate Otto
fixture. Backer, CircleFund, and SoloPilot retained exactly the same repository
identity, unit objects, unit IDs, and user-question sets, so their semantic
adjudications remain applicable; their packet and score digests were
regenerated from the corrected manifest.

## Controls

| Fixture | Work Item | Facts | Highlights | Weighted knowledge | Major knowledge | Weighted Highlight | Must Highlight | Question answerability | Highlight salience | Contradiction rate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Backer | `cmth3q1mn000021unt2y632kn` | 12 | 3 | 0.392857 | 0.388889 | 0.312500 | 0.312500 | 0.288462 | 0.500000 | 0.000000 |
| CircleFund | `cmth435y900oo21unrzvzptg9` | 15 | 2 | 0.525000 | 0.500000 | 0.450000 | 0.437500 | 0.312500 | 0.750000 | 0.000000 |
| SoloPilot | `cmth3va8j00a021unzd2mcuup` | 19 | 4 | 0.256098 | 0.265625 | 0.266667 | 0.275000 | 0.275000 | 0.250000 | 0.032258 |

None of the controls fully recovers a major audited unit or a complete user
question. Backer and CircleFund mainly preserve README/schema/UI slices.
SoloPilot allocates much of its output to a linting demonstration, Bedrock and
Serena utilities, and GitHub review publishing while omitting the central
email, proposal, and wireframe execution paths.

The apparent `matchedUnitGrounding = 1` in all three reports means only that
the exact attached ranges support the limited fragment that received nonzero
credit. It is not a completeness score. README-, schema-, type-, test-, or
helper-only fragments were capped at `tangential` unless the saved material
actually recovered a coherent portion of the audited operation.

## Provenance verification

The scorer verified every audit anchor against a clean checkout at the exact
fixture commit before emitting a report:

- Backer: `/Users/rafaykhurram/projects/Backer` at
  `b5e8e6574545475420b7d51f3b7c50e2a3602e5c`
- SoloPilot: detached disposable worktree
  `/tmp/workbase-source-audit/solopilot` at
  `46477b744db2aa61c53763c4832cad1b239e8ce5`
- CircleFund: detached disposable worktree
  `/tmp/workbase-source-audit/circlefund` at
  `22d1968ff13f649ad6ce06a07714b3ecc279121f`

Disposable worktrees were used for SoloPilot and CircleFund because the user's
normal checkouts contain tracked changes. Those changes were not touched.
Each score report records the verified root and computed source digest.

## Deliberately conservative calls for review

These are the closest rubric boundaries and should receive explicit reviewer
attention before the controls are frozen:

- Backer's feed-event/model unit receives `substantial` knowledge and
  Highlight credit. The saved README excerpts identify event capture, the
  operator training script, the persisted artifact, runtime loading, and
  fallback, but omit the tiny checked-in dataset. A strict production-code-only
  interpretation would lower this to `partial`.
- Backer's role, profile, and messaging units receive `partial` credit because
  direct schema/page/component evidence recovers real slices, not the audited
  end-to-end authorization or lifecycle boundaries.
- CircleFund circle creation receives `substantial` credit because the saved
  material enumerates the circle, rule, administrator membership, invite code,
  and policy values. It does not recover transactionality or collision retry.
- CircleFund account/session receives `partial` credit: the saved route test,
  repository helper, and README expose email-only sign-in, name-overwriting
  upsert behavior, and a signed HTTP-only cookie, but not normalization, HMAC
  details, expiry, or revocation limits.
- CircleFund's relational Highlight is a `supporting_insight`, not a major
  operation. A schema does not establish loan, cadence, membership-management,
  settlement, or reconciliation behavior.
- SoloPilot proposal generation and visual revision receive `partial` rather
  than `substantial` credit because the evidence is a high-level README view;
  it omits attachment selection and delivery, exact revision semantics,
  provenance, and duplicate suppression.
- SoloPilot's linting-demo material receives only partial/tangential unit
  credit and a `low_value` Highlight label. It overlaps code generation and
  review but does not recover the audited brief parser, milestone/TODO output,
  repository-context behavior, or reviewer bounds.
- SoloPilot has one explicit contradiction: the saved README-based Fact and
  Highlight assert that approved proposals feed PRD/planning and IDE export,
  while the pinned source audit establishes that no approval bridge, queue
  consumer, or export module exists. The contradiction is recorded on
  `solo.proposal-to-plan-export` and its corresponding user question.

## Artifact layout

For each repository, `*-packet.json` is the complete read-only database export,
`*-adjudication.json` contains an exact decision for every unit, saved
Highlight, and audit question, and `*-score.json` is the deterministic scorer
output. Packet and adjudication SHA-256 digests are stored in the score report.

Re-score a control with:

```sh
npm run --silent eval:repository-source-audit:score -- \
  --packet <packet.json> \
  --adjudication <adjudication.json> \
  --repository-root <clean-exact-checkout> \
  --historical-control
```
