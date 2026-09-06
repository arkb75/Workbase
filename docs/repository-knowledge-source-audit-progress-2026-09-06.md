# Source-audit evaluation checkpoint — 2026-09-06

The source-audit comparison is **not complete**. There is no certified current
four-repository result, and this checkpoint does not claim parity with the
independent source audits or a regression-free improvement over main.

## Implemented and verified

Commit `fa2e0f4f84a62f13840688bb2c5d5d7898d39959` on
`feature/generalized-repository-knowledge-v2` removes an unnecessary verifier
constraint: a missing operation need not duplicate the exact citation of the
independent observation that led to it. A declaration and its consumer can
provide different evidence. Both citations still require fresh, pinned source
reads, and the observation must link to a submitted missing-operation ID.

The regression test covers different-file evidence, missing links, and unread
citations. Full suite: 2,158 passed, one skipped; typecheck and changed-file lint
passed. These are implementation checks, not evidence of extraction quality.

## Live CircleFund attempt v19

- Implementation: `fa2e0f4f84a62f13840688bb2c5d5d7898d39959`.
- Source: `arkb75/CircleFund@22d1968ff13f649ad6ce06a07714b3ecc279121f`.
- Work item: `cmtp89u6z0000bzsbnkgddnaf`.
- Refresh: `cmtp89uyd0002bzsbzwwmlfjf`.
- Independent-review generation: `cmtp8cx7y002mbzsbaocvqxl7`.
- Live artifact: `/tmp/workbase-source-audit-v27.YaErOL/circlefund-v19-live.json`.
- Started 03:04:07 UTC; finished 03:15:32 UTC; failed after about 11.4 minutes.

Four investigator waves completed, retaining 19 provisional findings. The
independent review then repeatedly received HTTP 429 from OpenRouter for
`openai/gpt-5.6-luna`. All three bounded runner attempts were exhausted. The
saved investigation checkpoints were reused between attempts; the completed
investigation was not rerun. This was not an out-of-credit response, a failed
source check, or an exhausted investigation budget.

The refresh's recorded investigation budget was 45/71 model calls,
84,895/280,000 semantic-accounting tokens, and 24/110 inspection operations.
Reported cost was $0.34051014, but this is **known cost only**, not a complete
bill: some rate-limited attempts have unknown metering. No provider/model
substitution was introduced for this run.

The work item contains **zero saved Facts and zero saved Highlights**. The
candidate audit and synthesis were not reached. Do not grade the provisional
notebook or interpret the failure as a semantic coverage score.

## Source check retained for eventual adjudication

Direct inspection of the pinned CircleFund source confirms that invite joins
create a membership only when none exists. A suspended existing membership is
rejected; a pending existing membership remains pending. The provisional
investigator summary says the join otherwise creates an active member, which
glosses over this distinction. This is an external-audit concern for the final
saved output, not a finding injected into the live investigation. It has not
yet passed through verification or synthesis.

## Metering correction

The database observer previously added `estimatedCostUsd ?? 0`, allowing an
unknown charge to masquerade as a complete total. The accompanying reporting
change preserves null for incomplete token/cost totals; it retains known token
totals when only the charge is missing and accepts explicitly reported zero
cost. It does not change generation behavior or relax execution/source gates.

OpenRouter notes that some failed requests, including certain 429 cases, can
consume credits, so a failed-request ID or a missing generation lookup is not
proof of zero charge. See [OpenRouter's reliability guidance](https://openrouter.ai/blog/insights/reliability-failover/).
Outcome verification and cost/latency diagnostics are distinct dimensions in
[Anthropic's agent-evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Remaining work

### Same-model routing diagnosis, 03:20–03:22 UTC

A single no-retry request on the default review route reproduced an embedded
429 error in an HTTP 200 response (`gen-1788664822-FXDoKqbMbtfLU9ukD0hy`). The
provider explicitly described the model as rate-limited upstream. Model-wide
availability did not imply that an endpoint eligible for this request was healthy.

Changing `max_completion_tokens` to `max_tokens` was tested and rejected: the
result had no endpoint matching the existing zero-data-retention policy. The
client's current parameter spelling is deliberate and remains unchanged.

Explicitly selecting `azure/eu` for the **same** `openai/gpt-5.6-luna` model did
work with ZDR and strict parameter support still enabled. Both a plain response
(`gen-1788664902-PhCjGeSMgIPBlbmAlV3N`) and strict tool submission
(`gen-1788664933-ePCh782NYi5QBSxBwMYs`) succeeded. Reported costs were $0.00000858
and $0.00003344 respectively. This validates availability/tool protocol, not
repository coverage. The endpoint's listed per-token price was 10% above the
default Azure endpoint at inspection time.

The local configuration now sets
`WORKBASE_OPENROUTER_PROVIDER_ORDER_VERIFICATION="azure/eu"`. A new optional
per-profile routing preference allows this without changing the primary or
synthesis route, models, or privacy policy. Blank profile preferences inherit
the existing global preference. No application-wide default endpoint is hardcoded.
Documentation used: OpenRouter's [provider preferences schema](https://github.com/openrouterteam/docs/blob/main/openapi/openapi.yaml),
retrieved through Context7, and the live per-model endpoint metadata.

The next full evaluation must still establish saved-output quality. The v19
failure above remains a failure; these probes do not retroactively certify it.

### Live v20 and host-bound citation fix

Live v20 ran on `ddbe6f6beb064dac1c294a03279d2796c40308ad`, with the review
preference above. Work item `cmtp90an30000jasbidbadlf9`, refresh
`cmtp90bc70002jasbf7wsfh2u`; artifact
`/tmp/workbase-source-audit-v27.YaErOL/circlefund-v20-live.json`.

The investigation finished with 15 provisional findings. Independent review
completed, and both review stages had complete usage evidence: the upstream
rate-limit obstruction was resolved for this attempt. The candidate audit read
all 15 required exact source targets but failed after two submissions because
one check copied the dashboard claim's range incorrectly. The required range
was already visible: `src/server/services/circle-dashboard-service.ts:57-125`.
This was a contract failure, not evidence that the review lacked source access.
The run lasted 225,843 ms and stopped before saved-output synthesis. Its recorded
investigation usage was 33 model calls, 174,455 semantic-accounting tokens,
44 inspection operations, and $0.39482057 reported cost.

Version `repository-knowledge-investigator-v36-host-bound-review-citations`
removes model-written citation fields from checks of known candidate claims and
known independent observations. The host binds those IDs to the required ranges
only when the fresh read set proves matching source, repository, commit, blob,
path, and full range. The full persisted audit retains those exact citations;
all original verdict, link, completeness, and evidence-validation checks remain.
New missing operations still require model-chosen source citations. No retry
ceiling or semantic threshold was increased.

This is an application of reducing unnecessary agent-side tool bookkeeping,
consistent with [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents).
It does not retroactively certify v20; a fresh live result is still required.

### Live v21 and short review references

Live v21 on `fa06ff44b77bb734df496ed89572a4ec6440fcbe` ran for 209,978 ms
with work item `cmtp9exsv00006dsb688ghojc` and refresh
`cmtp9eyih00026dsbn9f4bw4p`. Artifact:
`/tmp/workbase-source-audit-v27.YaErOL/circlefund-v21-live.json`.
Investigation retained 20 provisional findings; independent review succeeded.
The candidate verifier completed all 20 required exact reads but failed before
saved synthesis. It copied one observation digest with `...93a9...` instead of
`...93c9...`. This unknown ID was misleadingly reported as a missing exact read.
The recorded investigation usage was 31 calls, 155,789 semantic-accounting
tokens, 48 inspection operations, and $0.33871648 with complete usage evidence.

Version `repository-knowledge-investigator-v37-short-review-references` exposes
short packet-local observation IDs (`obs_1`, `obs_2`, etc.) instead of requiring
the model to transcribe SHA-256 hashes. The host resolves each known ID to the
unchanged full persisted digest and binds its fresh citation as before. Unknown
references are rejected explicitly; duplicate/omitted observations and source,
verdict, and link checks remain enforced by the existing final contract.
This follows the same [tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents),
which specifically recommends interpretable or indexed IDs over cryptic ones.
It changes the interface, not the semantic success criteria or retry limits.

### Live v22: review works, repair exhausts its allowance

Live v22 on `8bcd370bf1e650572f158d283c89c308f376d561` ran from 03:44:29
to 03:50:44 UTC (375,068 ms), with work item `cmtp9pqjv0000rnsbf61u903g`
and refresh `cmtp9pr6h0002rnsbx0a3pafd`. Artifact:
`/tmp/workbase-source-audit-v27.YaErOL/circlefund-v22-live.json`.
Both candidate audits accepted their contracts. The first identified nine
source-grounded omissions; after two short repair phases the last audit still
identified eight. Neither repair phase saved a new finding. Their termination
was `token_limit_exceeded`, after two and one model calls respectively. The
final recorded shared usage was 50 calls, 284,283 semantic-accounting tokens,
84 inspection operations, and $0.62090423. Finalization failed before synthesis;
this is not an eligible saved-output comparison.

Code inspection found that investigator phases, unlike both verifier phases,
clipped their raw cumulative context-token limit to the remaining *uncached*
semantic-work allowance. This creates premature phase boundaries when context
is cached and can consume the remaining allowance restarting short phases.
Version `repository-knowledge-investigator-v38-consistent-phase-accounting`
uses the existing separate raw and semantic limits for the investigator too.
The shared 280,000-token allowance, raw 110,000-token small-project ceiling,
model-call/inspection limits, and reserved re-audit allowance are unchanged.
A regression test covers cached repair work retaining the re-audit reserve and
rejecting admission when that reserve cannot be protected. Live efficacy is
not yet established; the change does not retroactively certify v22.
Verification: 2,164 tests passed, one skipped; typecheck and changed-file lint
passed. No source-audit fixture or historical baseline was changed.

### Live v23: repair completes, one reviewer gap remains

Live v23 on `3966828c95b4d4ccb1efaa4cca88b8643778330e` ran for 344,590 ms
with work item `cmtpa1q840000stsbxqptw22z` and refresh
`cmtpa1quu0002stsblp2u4zla`; artifact
`/tmp/workbase-source-audit-v27.YaErOL/circlefund-v23-live.json`.
The first audit returned six gaps. Repair completed in four model calls and
retained five additional findings. Re-audit accepted its contract but retained
one membership-lifecycle gap, so finalization correctly remained failed and no
saved-output comparison is certified. Shared usage: 50 calls, 236,452 semantic
tokens, 68 inspection operations, $0.59565826; 43,548 semantic tokens remained.
This shows a completed repair in this attempt, not a controlled estimate of the
accounting fix's causal effect on quality or cost.

The remaining objection overlaps two existing candidate statements: declared
membership states versus active creation, and a repository-module boundary that
exposes only circle-domain creates/reads rather than edits or deletion. The
first statement's own citation covers only the enums, however, so exact source
support still needs checking across the related claims; this is not an excuse
to override the reviewer verdict. The candidate packet previously omitted the
source locations of all but three representative checks. Version
`repository-knowledge-investigator-v39-candidate-evidence-pointers` includes
each claim's concise path/blob/range pointers and asks the reviewer to inspect
those ranges when reconciling apparent gaps across related claims. It retains
the same source gates, verdict rules, repair ceiling, and semantic thresholds;
no excerpts or trusted prior tool results cross the phase boundary.
The compact-packet test checks those pointers, absence of copied source/tool
attestations, and explicit instructions that pointers are not proof.

### Live v24: ambiguous decision-link feedback

Live v24 on `1a1e3e0f4875659f026473625bb774c4c2ef48f5` ended after
274,266 ms, with work item `cmtpad0yu00009fsbkofx8cf5`, refresh
`cmtpad1i100029fsbtuwfrm8d`, and candidate audit `cmtpahk91002n9fsbe8lyw5of`.
Artifact: `/tmp/workbase-source-audit-v27.YaErOL/circlefund-v24-live.json`.
All 16 required source ranges were freshly read. Both candidate submissions
failed the observation decision/link contract; the last rejection identified
four array positions but repeated one generic explanation for every invalid
combination. Raw submissions were not retained, so the specific conflicting
field values cannot be reconstructed from this record. Recorded usage was
33 calls, 171,559 semantic tokens, 51 inspections, and $0.41349599. This is
another failed run, not a coverage score or an out-of-credit condition.

Version `repository-knowledge-investigator-v40-explicit-review-link-contract`
specifies the exclusive link fields for each verdict in the prompt and tool
field descriptions, including how to describe partial coverage. Rejection
messages now identify the short observation ID, the specific rule, and the
submitted link values. This retains the existing allowed combinations rather
than silently clearing contradictory fields or weakening the coverage gate.
The regression test exercises all six invalid combinations. Full suite:
2,164 passed, one skipped; typecheck and changed-file lint passed. All 304
frozen source anchors across the four repositories still match their digests.
No source-audit expectations or historical controls were changed.

### Live v25: accepted review, insufficient repair headroom

Live v25 on `b5d387a770d494cc0a4f850bc3319c17b7891174` ran from
04:14:10 to 04:40:10 UTC (1,560,285 ms). Work item:
`cmtparwy20000gdsbdcdrf7b6`; refresh: `cmtparxi00002gdsbznsxs5tl`;
artifact: `/tmp/workbase-source-audit-v27.YaErOL/circlefund-v25-live.json`.
The investigator retained 23 provisional findings. Independent review completed.
Candidate comparison encountered provider errors, then resumed on the same
refresh and ultimately accepted a `gaps` submission. Its correction diagnostics
concerned duplicate/omitted checks, not the exclusive-link rejection in v24.
This is a successful protocol submission in one run, not proof of reliability.

The reviewer reported four omissions: server-side session expiry/state checks,
dashboard approval/voting/reserve transition boundaries, contribution payment
side-effect boundaries, and contribution relation deletion semantics. These are
reviewer findings, not an independent saved-output adjudication. The retained
candidate must still be inspected for overlap and actual source support.

Recorded shared usage reached 46 calls, 249,361 semantic tokens, and 77
inspections. The 30,639 remaining semantic tokens were below the existing
16,000 repair admission plus 18,000 reserved re-audit allowance. No repair
could start; finalization failed before saved-output certification. Reported
known cost was $0.54496936, **not a complete bill**, because failed attempts
had unknown usage. No budget ceiling or success threshold was changed.

Read-only OpenRouter metadata queries for the two available generation IDs
(`gen-1788668282-JxpmhWipDhM7XWLCFLAH` and
`gen-1788668899-2SZrbTzuHfcwmIQc4f9V`) showed successful Azure tool calls.
They do not identify the failed attempts, whose request IDs were absent.
The stored error has no HTTP status, so neither credit exhaustion nor a rate
limit is established. The lookup used the documented [generation metadata
endpoint](https://github.com/openrouterteam/docs/blob/main/openapi/openapi.yaml),
retrieved through Context7; no extra model generation was used for diagnosis.

The next work should address main-path investigation/review efficiency and
inspect the remaining semantic gaps before another full replay. Repeatedly
rerunning the same expensive path is not evidence of progress toward parity.

### Main-path efficiency: terminal durable checkpoints

Inspection of the v25 worker traces showed redundant post-checkpoint work.
Wave 1 saved nine findings at iteration 6, then requested another inspection
at iteration 7 and ended at a phase budget boundary. Other waves required
an additional model turn for a textual handoff after a saved checkpoint.
The host already had the continuation state; these calls were not needed to
transfer findings or source attestations.

Version `repository-knowledge-investigator-v41-terminal-durable-checkpoints`
uses the harness's existing terminal-tool mechanism for a successfully
persisted completed notebook or phase checkpoint. Rejected updates and failed
persistence remain nonterminal. The host also selects the notebook tool at
the existing three-inspection checkpoint boundary instead of asking the model
to choose it through a rejected inspection call. This does not change the
investigation scope, phase size, shared budget, source gates, or review criteria.
Six regression cases exercise terminal and nonterminal outcomes and the
inspection-to-checkpoint transition through the actual agent loop.

This follows [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
on durable notes and removing redundant interaction history, using existing
harness functionality rather than introducing another orchestration layer.
The live savings and saved-output quality still require verification.
Verification: 2,170 tests passed, one skipped with four workers; typecheck and
changed-file lint passed. An earlier concurrent-check run hit two unrelated
test timeouts; no timeout or assertion was weakened for the successful rerun.

### Live v26: checkpoint behavior works; credits stop both projects

Both attempts used clean implementation
`a6be56107c674af36e2ed6643fa38dda055b332e`.

- CircleFund: work item `cmtpw694q00008esbikjwp49j`, refresh
  `cmtpw69w600028esbdrn50fld`, artifact
  `/tmp/workbase-source-audit-v27.YaErOL/circlefund-v26-live.json`.
  Started 14:13:11 UTC, ended 14:17:51 UTC (279,877 ms).
- Backer: work item `cmtpwa6m300009bsbn8vd3122`, refresh
  `cmtpwa7bv00029bsbwo8kv4v0`, artifact
  `/tmp/workbase-source-audit-v27.YaErOL/backer-v26-live.json`.
  Started 14:16:14 UTC, ended 14:17:41 UTC (86,585 ms).

CircleFund completed three `investigator_checkpoint_yield` waves and one
`investigator_done` wave, retaining 18 provisional findings in 17 model calls,
122,665 semantic-accounting tokens, and $0.38758050. The prior v25 initial
investigation used 32 calls and retained 23 findings, so the lower call count
cannot be treated as a controlled quality-equivalent savings estimate.

Independent review and the first candidate audit succeeded. The latter
identified 11 gaps. A repair phase consumed 40,615 semantic tokens and ended at
a phase budget boundary with 18 findings retained; the final re-audit then
failed with an explicit insufficient-credit error. Shared recorded usage was
34 calls, 266,629 semantic tokens, 74 inspections, and $0.56179695 known cost;
the cost is incomplete because the failed attempt has unknown metering.
Backer completed one small checkpoint and then also failed with an explicit
insufficient-credit error. Neither run is eligible for semantic certification.
No further paid replays were started after these errors.

### Continuation payload reduction

Version `repository-knowledge-investigator-v42-lean-continuation-pointers`
keeps every retained finding, statement, operation key, implementation state,
facet, capability link, confidence, sensitivity marker, unresolved question,
and source path/blob/range in the model-facing continuation. It stops repeating
per-citation evidence IDs, source/commit IDs, snapshot IDs, hashes, and policy
versions already held in the host's full durable notebook and checkpoint.
New or revised claims still require fresh exact reads; the model is explicitly
told not to resubmit unchanged prior entries.

On the v25 final notebook, the same semantic content and source pointers use
15,385 bytes instead of 26,057 (41.0% smaller). This measures that packet only,
not whole-request tokens, paid cost, or extraction quality. A regression test
checks field preservation, absence of omitted metadata from the model packet,
retention of full evidence in the unmodified original notebook, and smaller
serialized size. Full checkpoint validation and source-audit gates are unchanged.
The reduction follows the same tool/context guidance cited above and reuses the
existing continuation projection; no new storage or orchestration layer is added.
Verification: all 2,170 tests passed (one skipped), the focused 74-test
investigator suite passed after final test cleanup, and typecheck and
changed-file lint passed. Live validation of this revision remains pending
available credits; the four-repository comparison remains incomplete.

### Live v27: funded runs expose review-interface failures

Read-only OpenRouter credit queries confirmed the user's top-up increased the
available balance from $0.611294705 to $10.611294705 before these attempts.
Both used clean implementation `c9cb2a45c43334ece41b786e4acf266eb6f56fb7`.

- CircleFund: work item `cmtpwsf810000q1sb5fqklo92`, refresh
  `cmtpwsgtf0002q1sb584daik7`; artifact
  `/tmp/workbase-source-audit-v27.YaErOL/circlefund-v27-live.json`.
  Ran 14:30:25–14:35:14 UTC (289,039 ms). Initial investigation retained
  25 provisional findings in 15 calls, 78,103 semantic tokens, and $0.281183.
  The first audit reported six gaps; repair retained 30 findings. Re-audit
  considered the original gap observations covered except for the remaining
  recording-user deletion constraint, but newly rejected two observations it
  had previously accepted: the production-only Secure cookie attribute and
  invite-code normalization. Final usage: 34 calls, 271,432 semantic tokens,
  64 inspections, $0.49430205. It stopped at the bounded repair ceiling and
  is not eligible for saved-output certification.
- Backer's simultaneous first setup hit `TransactionWriteConflict` before
  creating a refresh or doing model work; its failed artifact is retained as
  `backer-v27-live.json`. A staggered fresh attempt succeeded in setup:
  work item `cmtpwt7g600004psbhohp56m3`, refresh
  `cmtpwt87800024psb2850rtxs`, artifact `backer-v27-retry-live.json` in the same
  directory. It ran 14:31:02–14:34:52 UTC (229,797 ms). Investigation retained
  21 findings. Independent review failed before its correction submission:
  it cited 1–20 when the visible segment ended at 19, and a separate citation
  exceeded the 8,192-byte limit. After one source-repair call, cumulative raw
  replay admission hit the 270,000-token phase limit. Final shared usage was
  36 calls, 316,950 semantic tokens, 56 inspections, $0.69864250, with complete
  reported usage. No candidate audit or saved-output certification followed.

Neither failure is a credit error. Lower initial CircleFund cost is a diagnostic,
not proof of quality-equivalent savings or parity with the frozen source audit.

### Main-path review ergonomics and assessment continuity

Version `repository-knowledge-investigator-v43-line-addressable-review` adds
original line numbers to model-facing exact source snippets, including expanded
ranges. Previously the model had only segment start/end metadata and had to
count unnumbered source lines. The underlying evidence, hashes, visible ranges,
and source-validation rules remain unchanged. Tool and review instructions now
state the existing 8,192-byte citation limit; oversized-citation diagnostics
report actual and allowed bytes and explain that repeating the read cannot fix
an oversized citation. The host does not shorten or accept invalid citations.

Both review stages now receive the same materiality guidance as the investigator.
The candidate reviewer must explain which consequential project question an
omission would impair, distinguish incidental wording/detail from material
security, state, authorization, and data-integrity boundaries, and consider the
union of source-supported findings. A re-audit receives compact prior decisions
and gap reasons, retained across intermediate repair checkpoints. These are
explicitly context, not evidence or binding verdicts: fresh reads remain required
and the reviewer may correct its earlier judgment with a source-backed reason.
No independent-review source data is replaced with candidate data, and no source
audit expectations, retry ceiling, model, or budget was changed.

The changes follow [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents)
on actionable source presentation and errors, and its [agent-evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
on inspecting failed transcripts and calibrating model graders rather than
treating every rejection as reliable. They are small changes at existing seams,
not a new harness or a fallback. Verification: 2,173 tests passed, one skipped;
typecheck and changed-file lint passed. New tests cover numbered offset/blank-line/
Unicode projection without evidence mutation, unchanged oversized-citation
rejection, and compact non-authoritative prior assessment context. Live validation
and the four-repository saved-output comparison remain required.

1. Complete a live run with a valid source-grounded review;
   retain the existing checkpoints and failed artifacts for diagnosis.
2. Export and inspect only its automatically applied, active Facts/Highlights.
3. Adjudicate against the frozen source units and questions, including material
   negative boundaries and evidence support.
4. Complete SoloPilot and Backer on a consistently recorded implementation;
   compare the three matched projects against main's frozen historical controls.
5. Fix generalized semantic deficits that the saved-output comparison actually
   reveals. Do not declare success from item counts, a verifier pass, or tests alone.

### Explicit scope change: Otto excluded by the user

The user instructed us not to use Otto because repository access is unavailable.
No further access attempts or live runs will target it. It is neither a pass nor
a failure. The original four-repository frozen source audit remains unchanged;
the current comparison scope is CircleFund, Backer, and SoloPilot: 60 knowledge
units, 211 source anchors, and 35 questions. The comparator now accepts explicit
`--exclude-fixture fixture-id=reason` entries and records them in provenance while
preserving the full frozen-manifest digest. Missing retained fixtures, excluded
fixtures supplied as scores/required controls, unknown/duplicate exclusions, and
an empty retained scope are rejected. Per-unit and historical regression gates
for retained repositories are unchanged.

### Live v28: terminal results, no certified saved-output comparison

All three runs used clean implementation
`7c5539aed2d8117a4052e97c37d52601a99bb640`. Artifacts are retained under
`/tmp/workbase-source-audit-v27.YaErOL/{circlefund,backer,solopilot}-v28-live.json`.

- CircleFund: work item `cmtpx83yn00000psb7d90k5mk`, refresh
  `cmtpx84tp00020psb2fj9pw6g`, 288,312 ms. Repaired seven initial gaps, but final
  review introduced the omitted PostgreSQL persistence-provider boundary.
  Its exact-read gate passed all 23 required ranges. Final usage: 34 calls,
  275,494 semantic tokens, 68 inspections, $0.51888642. Repair ceiling reached;
  no eligible saved-output packet.
- Backer: work item `cmtpx8olf0000cmsb98op52m0`, refresh
  `cmtpx8p2v0002cmsbt4gs4szh`, 376,195 ms. First candidate review reported the
  declared investment-status lifecycle as a supporting gap. Re-audit exhausted
  its 30,070-token phase allowance at 46,658 reported semantic tokens, with
  19/21 required reads complete. Final shared usage: 53 calls, 476,588 semantic
  tokens, 93 inspections, $1.08694137. The shared limit was 460,000; an admitted
  in-flight response can overshoot it before reported usage is available.
  Host status is incomplete, not a satisfied audit with zero gaps.
- SoloPilot: work item `cmtpx96xb0000rgsbjgoualnx`, refresh
  `cmtpx980f0002rgsb4xog5785`, 229,080 ms. Seven investigation waves consumed
  368,880 semantic tokens before blind review; blind review then exceeded its
  remaining phase allocation. Final shared usage: 39 calls, 440,767 semantic
  tokens, 55 inspections, $1.14274291. No candidate audit or saved certification.

These are main-path capacity/coverage failures, not funding failures. None proves
parity with independently inspected source or non-regression against main.

### v44: fetch known candidate-review ranges without model bookkeeping

`repository-knowledge-investigator-v44-prefetched-candidate-source` batches known
representative and blind-observation read targets through the existing pinned
source inspection tool before the candidate model starts. The same raw evidence,
visible-range callbacks, per-phase and shared inspection budgets, redaction,
source attestation, and submission gates apply. The fetched source is presented
in the candidate's first request; no previous source evidence or judgment is
treated as a fresh read. Host calls are separately recorded and never counted as
model calls. At least one normal inspection call plus the existing repair
allowance remains available for reviewer-directed investigation. Failed or
unusually long reads stay unresolved, not accepted. The blind phase is unchanged.

This implements [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents)
on consolidating known multi-step retrieval at the tool boundary. It does not
raise budgets, relax materiality or coverage gates, or add a fallback. It targets
candidate-review overhead; SoloPilot's pre-review investigation cost remains a
separate unresolved main-path problem. Verification: 2,175 tests passed, one
skipped; typecheck and changed-file lint passed. Tests cover bounded/deduplicated
read planning, fresh snapshot/source identity, failed reads, expansion limits,
and explicit scope exclusion without weakening retained evaluation. Live
validation remains required before claiming efficiency or quality improvement.

### Live v29: fewer calls, still no certified saved output

Clean implementation `2f983d1c72d6c7677e3cf46d03294ab988402ba3`; artifacts:
`/tmp/workbase-source-audit-v27.YaErOL/circlefund-v29-live.json` and
`/tmp/workbase-source-audit-v27.YaErOL/backer-v29-live.json`.

- CircleFund: work item `cmtpxw67u00003wsbjmz4frdk`, refresh
  `cmtpxw6xg00023wsb7wtkj50i`, 268,837 ms. Both candidate audits used three
  host-prefetch calls and passed all 16 required reads. First review reported
  six gaps; after repair, re-review reported ordinary browser logout and the
  contribution input constraints as two supporting omissions. Final usage:
  24 model calls, 255,618 semantic tokens, 57 inspections, $0.44553732. It still
  failed the one-repair ceiling; 24,382 semantic tokens remained, insufficient
  for the existing minimum repair-plus-re-audit reservation anyway.
- Backer: work item `cmtpxx2mz0000fasbosu7chis`, refresh
  `cmtpxx3xu0002fasbfoiimle2`, 229,695 ms. Candidate review prefetched three
  batches but had only 19/20 required ranges visible. The unresolved observation
  required `prisma/schema.prisma:84–105`. The model submitted twice; the host
  treated missing source as a payload-contract failure rather than requiring
  inspection before submission. Final usage: 21 model calls, 200,120 semantic
  tokens, 41 inspections, $0.33210080. Remaining shared budget was 259,880
  semantic tokens, so this was a protocol defect, not a capacity/credit failure.

These are independent stochastic runs, not paired proofs of quality-equivalent
savings. No saved-output source-audit score or non-regression claim is available.
SoloPilot was not rerun on v44, which did not address its pre-candidate failure.

### v45: actionable source requirements, lean map, budget-bounded repair

`repository-knowledge-investigator-v45-actionable-source-gates` exposes the exact
missing pinned paths/ranges in the candidate's initial request and subsequent
inspection instructions. When the source gate is incomplete, tool choice now
requires inspection before submission even before the last normal call; blind
review likewise cannot submit before its existing provenance gate is met.
Known-range binding errors identify the required path and line numbers. No
missing source is accepted and no inspection allowance is increased.

The navigation map omits database row IDs and only the mechanically generated
`Defines …` description that exactly repeats the displayed symbols. It retains
paths, those symbols, dependency descriptions, unique responsibilities, and
capability hints, with unchanged scoring and byte ceiling. A read-only projection
of SoloPilot's 243 analyzed paths measured 37,165 bytes before its header versus
59,975 bytes for the old complete map (approximately 38% smaller). This is a
payload measurement, not a token/cost or quality guarantee.

The separate exactly-one-repair policy is removed. The existing shared
call/token/inspection limits, minimum repair-plus-re-audit admission, phase
capacity stops, and repeated-convergence-signature stop remain. This lets
productive follow-up repairs use remaining budget without resetting allowances
or accepting incomplete knowledge. It follows the simple feedback loop in
[Anthropic's evaluator–optimizer guidance](https://www.anthropic.com/engineering/building-effective-agents).
Tests cover multiple repairs consuming the original allowance, source readiness
forcing inspection, exact missing-range reporting, and preservation of map
content and input data while removing duplication. Live validation on all three
retained repositories remains necessary.

Verification for v45: all 2,177 tests passed, one skipped; typecheck,
changed-file lint, and diff whitespace checks passed.

### Live v30: all three terminal, parity remains unproven

All three runs used clean implementation
`8c2d13c330dc73a74d005641ab4cc222a99dd1f2`. Artifacts remain at
`/tmp/workbase-source-audit-v27.YaErOL/{circlefund,backer,solopilot}-v30-live.json`.
No run is eligible for a certified saved-output score. No live process remains.

| Repository | Work item / refresh | Duration | Final semantic tokens | Calls | Inspections | Reported cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| CircleFund | `cmtq1fwhc0000c2sbmndd07dd` / `cmtq1fxky0002c2sbk5jn030g` | 241,754 ms | 267,922 | 29 | 63 | $0.43403044 |
| Backer | `cmtq1gycn0000mksbnqqbvx3u` / `cmtq1gz6a0002mksbwco38fky` | 279,075 ms | 318,393 | 34 | 57 | $0.66819068 |
| SoloPilot | `cmtq1hcsd0000wysbrxymnhl7` / `cmtq1he540002wysbnqjp6knf` | 339,403 ms | 389,561 | 44 | 66 | $0.92335275 |

- CircleFund's first candidate audit passed 20/20 required reads and reported
  four gaps. It corrected one omitted representative-check submission. Repair
  retained 18 findings. Re-audit passed its read gate but still reported browser
  logout and executable policy-transition boundaries as missing. Only 12,078
  semantic tokens remained, below the existing repair-plus-re-audit minimum.
  The removed fixed repair-count ceiling was not the stop this time. Inspection
  of the provisional notebook shows the repair captured dashboard display and
  missing schema entities, but did not directly retain the requested service
  execution boundary. That is a semantic repair deficit, not just formatting.
- Backer's candidate read gate passed all 16 ranges, resolving the preceding
  missing-read failure. Its submission still omitted the required
  `project_domain:messaging:messaging_conversation_creation_role_policy` check
  after correction. It made three submission attempts: one schema-invalid and
  two contract-invalid. Final audit `cmtq1lanv0053mksbi8essw2k` failed with 141,607
  shared semantic tokens remaining; this was not a token or credit failure.
- SoloPilot completed six investigation waves (262,424 semantic tokens), then
  completed blind review (56,012). Candidate review passed all 15 required reads
  but submitted a new `proposal_version_soft_delete` gap using lines 200–222
  outside its visible source. The two submissions failed the source contract;
  final audit `cmtq1nd2d007lwysbcxmlx1op` ended with 70,439 shared semantic tokens
  remaining. It got past v28's blind-review budget failure, but that is execution
  progress, not proof that its knowledge coverage is sufficient.

Fresh direct checks of the pinned repository sources confirmed Backer's runtime
DynamoDB investment-intent writes, SoloPilot's lint-assisted skeleton/TODO output
and new milestone-directory context, and CircleFund's transaction authorization
and stateless cookie boundaries. Frozen unit expectations were not changed.

Next main-path work should address the actual review interface: let the host
carry the identities of mandatory representative checks so the model supplies
judgments rather than repeatedly transcribing long identifiers. Investigation
of SoloPilot's source-repair admission is still needed: the code already routes
typed citation diagnostics to source inspection, so adding that routing is not
the missing fix. The final attestation retains `evidence_range_not_visible`
alongside `coverage_contract_invalid`, zero source-repair inspections, and
`submissionNeedsSourceRepair: false`; it does not retain the earlier rejection
sequence needed to establish why the repair was not taken.
Do not weaken either source support or completeness checks. CircleFund also
needs the investigator to repair the stated missing operation rather than only
adjacent declarations/display surfaces. Do not launch another identical paid
run or score provisional notebooks as saved knowledge.

### v46: mandatory host-bound representative judgments

`repository-knowledge-investigator-v46-host-bound-review-checks` gives the
candidate reviewer a required `representativeChecks` object with `check_1`,
`check_2`, etc. for the host-selected claims. Each requires an explicit verdict
and reason; omitted checks are invalid tool input, not an audit that gets as far
as the semantic contract. The host supplies the already-known capability and
finding identities. Optional extra judgments remain a separately bounded array.
The persisted audit shape, source-read gates, exact citation resolution, and
unsupported-claim rejection are unchanged. No judgment is synthesized.

This follows the narrow tool-interface principle in
[Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents):
avoid making an agent repeat known identifier bookkeeping. Required object
properties also use the existing strict function-tool schema mechanism described
in [OpenRouter's tool-calling documentation](https://github.com/openrouterteam/docs/blob/main/guides/features/tool-calling.mdx).
No new framework, model, provider, budget, or evaluator threshold is introduced.

Tests exercise three generic API/worker/firmware claims, missing and unknown
keys, unsupported judgments, additional checks, input immutability, and the full
binding-to-fresh-citation validation path (including stale or absent reads).
Backer is the targeted next live diagnostic because its preceding run failed on
an omitted mandatory judgment. It is not yet evidence of saved-output parity.

Verification: 2,178 tests passed, one skipped; typecheck, changed-file lint, and
diff whitespace checks passed.
