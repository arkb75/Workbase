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

### Live v31 Backer: completed product path; integrity and semantic gaps remain

Clean implementation `b4c4f8482e3d278e7b6350dfed3025e1bf4c62a0`;
artifact `/tmp/workbase-source-audit-v27.YaErOL/backer-v31-live.json`;
work item `cmtq27iox0000njsbc6omm12s`, refresh
`cmtq27jsj0002njsbif4jfhm8`. Duration 459,331 ms. No live process remains.
CircleFund and SoloPilot were not rerun on this version; Otto remains excluded.

The first candidate review (`cmtq2ca5m0053njsbrv56xgly`) passed all 15 required
reads with no submission rejection, and reported investment lifecycle and
non-atomic persistence gaps. Repair followed by the final review
(`cmtq2dv400057njsblzis83vk`) reached `satisfied`; the refresh completed and
reconciled. Investigation used 42 calls, 305,709 semantic tokens, 61 inspections,
and $0.67787928. Reported synthesis/review cost was another $0.131497855; these
are reported text-model costs, not an all-service billing total.

The refresh's broad counts include seed records. The exported, refresh-scoped
automatic saved output is **27 Facts and 13 Highlights**, with 43 evidence
references. Diagnostic packet:
`/tmp/workbase-source-audit-v27.YaErOL/backer-v31-packet.json`.
It remains **ineligible**, not a passing source-audit score.

The completed path exposed these independently diagnosable integrity problems:

1. The two-phase evaluator compared the count of visible read ranges with the
   count of unique evidence IDs. The blind checkpoint legitimately has 11
   disjoint/expanded ranges across seven evidence blobs. The evaluator now
   compares unique ID counts, while retaining the complete range digest and
   enclosing-read checks. Tests reject omitted ranges, duplicate or unknown
   IDs, and changed digests; no source requirement was weakened.
2. The evaluator does not recognize the existing `limitation_entailment_critic`
   phase (`cmtq2gpvp006mnjsbv95c41xc`) and consequently also checks its configured
   verification model against the synthesis model. This needs phase-specific
   attestation validation, not a blanket exemption or a provider/model switch.
3. Database export found truncated investigator read-set attestations. For
   example, generation `cmtq2afwy004ynjsbffmtlo2y` retains 20 entries followed by
   the string `[4 more items]`; subsequent cumulative attestations have the same
   problem. This is not an observed wrong commit or blob: the diagnostic
   predicate fails on the non-record truncation marker. Preserve exact bounded
   source attestations durably before another paid run; do not ignore markers
   or overwrite old attestations/artifacts to manufacture eligibility.

The saved text also does not yet match the independent audit: founder profile
coverage reduces to a required-field check, media uploads and offline feed
training are absent, and invitations/product administration omit important
ownership and lifecycle boundaries. Investment limitations are materially
better represented, but many Highlights still describe separate API steps.
These are qualitative observations of saved text, not certified numerical
coverage or a non-regression claim. Fixing integrity alone cannot satisfy the
goal; investigate retention and workflow-level coverage next without feeding
project-specific expected units into the extraction agent.

Verification after the range-count correction: 2,179 tests passed, one skipped;
typecheck, changed-file lint, and diff whitespace checks passed. The original
live artifact is unchanged and still records its original integrity failure.

### v47 / synthesis v78: exact provenance and actionable claim repair

The investigator now uses the existing bounded lossless-attestation option.
Cumulative read sets no longer pass through the event-preview serializer's
20-item truncation. The 128 KiB audit-envelope cap remains; an oversized record
fails explicitly rather than silently losing evidence. Backer's complete final
checkpoint source inspection measured 23,455 bytes. Tests include a 35-entry
attestation; old records are neither overwritten nor treated as complete.

The limitation entailment critic now records its exact claim payload and output
digest. The evaluator recognizes this phase and validates its fact-only claim
keys, subsystem membership, count, content digest, assessment keys, output
digest, and configured verification model. Merely naming this phase does not
exempt a run: missing or altered attestations still fail. This does not make
the earlier v31 record retrospectively eligible.

Tracing Backer's founder-onboarding operation located a real retention failure:
the investigation notebook retained the full handler at lines 11–79, initial
synthesis described its profile-creation and invitation calls, then critique
rejected it and the revision reduced it to a required-field guard. New critic
output requires a bounded reason identifying the unsupported clause and source
boundary, carried into the existing revision slots. Repairs are instructed to
retain the supported central operation, describe visible invocations without
inventing callee internals, and not substitute an incidental guard for the
workflow. Old persisted code-only assessments remain readable, while the new
model schema requires the reason. Verdict and source-support checks are not
relaxed. Tests verify reason retention and continued rejection of unsupported
claims. This is a hypothesis for improving semantic retention, not proof yet.

The design follows the concrete-feedback refinement loop in
[Anthropic's agent guidance](https://www.anthropic.com/engineering/building-effective-agents)
and its emphasis on preserving useful state in
[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
No new harness, model, or fallback path is introduced. Missing independent
subsystems remain a separate investigation/review-breadth problem; this change
does not purport to solve them through formatting alone.

Verification: full suite 2,181 passed, one skipped; focused synthesis/audit
tests, typecheck, changed-file lint, and diff whitespace checks passed.

### Live v32 Backer: review capacity exhausted, before synthesis

Implementation `d7b7d576be3c555dd03e29a8b1ab025862548cb9`;
artifact `/tmp/workbase-source-audit-v27.YaErOL/backer-v32-live.json`;
work item `cmtq34pfx0000tcsbpaw336vr`, refresh
`cmtq34qrc0002tcsblsevpj70`. The process ended with exit 1 after
399,301 ms. No current coverage score is eligible from this run.

Initial investigation produced 35 provisional findings and consumed 321,962
semantic tokens. Blind review completed. First candidate review
`cmtq3bufv005ftcsbun6enjsr` completed all 16 required reads with no submission
errors, identifying investment lifecycle and non-atomic-write boundaries.
Repair added two findings. Re-review `cmtq3d5ac005jtcsb7p36p1mq` stopped with
`verifier_phase_budget_exhausted`, 15 of 16 required reads completed; the
remaining range was `lib/db/types.ts:1–22`. Final usage was 55 calls, 464,540
semantic tokens, 95 inspections and $1.18693701 reported text-model cost. The
last in-flight response crossed the 460,000-token allowance. This was not a
funding error or a rejected review payload.

Read-set records beyond 20 entries remained intact, exercising the v47 fix.
The run never reached synthesis, so it supplies no live evidence for v78 claim
repair. Provisional findings are not saved, reviewed output and are not scored.
CircleFund and SoloPilot were not rerun unchanged. Otto remains excluded.

### v48: concise source results, unchanged durable proof

The model-facing exact-source segment now retains its citation/expansion
evidence ID, pinned target, original line bounds, total line count, truncation
flag, complete visible source with line addresses, and citation byte limit.
It omits repeated host-only hashes, IDs, command strings, and version metadata.
Raw evidence, visible-range tracking, durable attestations and all source gates
are unchanged. This follows the high-signal tool-response guidance in
[Anthropic's tool engineering article](https://www.anthropic.com/engineering/writing-tools-for-agents).

Tests preserve Unicode, blank lines, partial-range expansion and input
immutability, and verify that the projected payload is smaller. This is a
bounded efficiency change, not a claim that review capacity or independent
coverage parity has been achieved. No budget, output-count target, model,
fallback or project-specific rule was added.

Verification: 2,182 tests passed, one skipped; typecheck, changed-file lint and
diff whitespace checks passed. Live effectiveness remains to be measured.

### Live v33: three retained repositories, no eligible parity result

All three ran on `80def1d1d617afdd77e822317fa87bcb61b8d5e5`, with the same
models and budgets. All processes are terminal. Artifacts remain in
`/tmp/workbase-source-audit-v27.YaErOL/`; Otto was not accessed.

| Repository | Artifact | Work item / refresh | Outcome |
| --- | --- | --- | --- |
| Backer | `backer-v33-live.json` | `cmtq3pofl0000vksbnavms2k8` / `cmtq3ppjq0002vksbgdxtm662` | Completed, degraded; original live integrity failed |
| CircleFund | `circlefund-v33-retry-live.json` | `cmtq3qncl0000uosbpw3grhi1` / `cmtq3qob20002uosbsaji4276` | Remaining membership-lifecycle gap, insufficient repair budget |
| SoloPilot | `solopilot-v33-live.json` | `cmtq3ppjf00002dsbudoiwkhe` / `cmtq3pql400022dsbxmw44d1t` | Three repeated no-progress checkpoints; no review or synthesis |

CircleFund's original `circlefund-v33-live.json` records a database setup
transaction conflict, before a refresh or model analysis. It was retried once
after setup contention ended; the failed artifact and temporary work item
`cmtq3poum0000wcsboim47ml6` were preserved, not relabeled or deleted.

Backer completed in 560,890 ms (558,074 ms refresh duration). Investigation
used 56 calls, 453,179 semantic tokens, 79 inspections and $1.12722974. The
exported observer reports $1.34380330 across text generation phases, 104 model
calls, and 1,049,980 total tokens (a different measure from uncached semantic
work). Scoped active output is 29 Facts and 17 Highlights, 54 evidence links.
The diagnostic packet `backer-v33-packet.json` is **ineligible**, not scored.
Founder onboarding now retains its central creation and invitation invocations;
media upload, profile updates and invitation transitions are present. This is
qualitative evidence, not a matched score or proof of the cause of improvement.
Offline feed training and important negative/security boundaries remain absent
from active output. The upload summary also ends mid-clause and needs tracing.

CircleFund completed all 16 required reads in its final review
`cmtq3wx3n002vuosbzbj1qpxr` with no submission rejection. It still requested a
concrete membership suspension/status-transition boundary. Usage reached 35
calls, 275,433 semantic tokens, 73 inspections and $0.50789196, leaving 4,567
tokens below the repair reserve. Duration was 343,180 ms. It did not synthesize.

SoloPilot stopped after 205,604 ms with 28 calls, 228,444 semantic tokens, 38
inspections and $0.73580710. It still had 231,556 semantic tokens available, so
this is not a funding or capacity failure. Waves 4–6 retained 13 findings and
the same three material questions. Tool records show repeated whole-file
queries returning sparse windows: gateway lines 1–19, 296–332 and 608–625
omit the global API-key requirement at lines 22–23; repeated management Lambda
windows omit most of approval delivery (send call at 684), proposal generation
(1343 onward), and wireframe generation (1945 onward). Some inspection calls
were invalid, but stored trace hashes do not establish their exact bad inputs.
Do not invent a specific schema error from those hashes.

The next source-access change should let the agent request a bounded line
range directly on a pinned file query, reusing the existing Git reader,
budget and evidence callbacks. It should not depend on guessing why an earlier
call failed, or on project-specific expected source paths. Existing expansion
handles remain useful. Do not remove the no-progress guard or inflate budgets
to hide this source-navigation failure.

### JSONB-stable limitation assessment hashing

The original Backer integrity error was the limitation critic's assessment
digest. Rebuilding its exact schema property order reproduces the original
stored hash `650f774b18f4545a018f592d6003ebd542db44f76d48cac7c4c0982987b211f5`;
hashing database-returned property order produces a different digest. This is
consistent with PostgreSQL's documented
[JSONB key-order normalization](https://www.postgresql.org/docs/current/datatype-json.html),
confirmed through Context7. A shared domain helper now reconstructs only the
critic schema's property order. It preserves all values, reason text, issue
and assessment array order, and rejects unknown fields. Producer and evaluator
use the same function. Tests accept reordered object keys and reject modified
reasons, verdicts, issues, claim keys and malformed records. Original live
artifacts and database attestations remain unchanged.

After this correction, database export exposes two other issues, not a pass:

1. The exact no-auth upload and missing founder/product-association limitations
   exist as draft **quarantined** Facts (`04a4ee12-b5aa-4df0-be9a-6a42a3b94660`
   and `dd53a5df-e070-4a00-87d6-48ab668d532a`). They were not overwritten.
   The observer sees neither active persistence nor an explicit synthesis
   rejection. Inspect the sensitivity classification and disposition contract;
   do not silently count quarantined knowledge or disable privacy controls.
2. The last investigator attests `lib/db/repository.ts:1818–1897`, but its final
   materialized limitation cites the contained range 1839–1867. The observer
   requires an exact range/hash tuple and finds none. Earlier-wave claim ranges
   are reconstructed into carried attestations; final-wave narrow claims do
   not necessarily receive the same record. Preserve host-validated atomic
   citation attestations in the producing phase, with enclosure and exact-byte
   tests; do not replace content verification with range containment alone.

Separately, the limitation critic rejected claims about an unshown PENDING
declaration and callee persistence not shown by a route-only citation. These
are retained as explicit synthesis gaps. The audit remains incomplete; neither
smaller tool output nor a completed Backer refresh establishes source parity.

Verification after JSONB hashing correction: 2,183 tests passed, one skipped;
132 focused synthesis/attestation tests, typecheck, changed-file lint and diff
whitespace checks passed. No further paid run was started on this correction.

### v49: directed reads and same-wave atomic citation attestation

The existing inspection tool now accepts `range: { startLine, maxLines }` on a
pinned `show HEAD:path` query. `range: null` retains overview/discovery behavior.
This follows the small offset/line-limit interface used by
[OpenCode's source reader](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/read.ts),
without adopting another harness or adding a new retrieval service. The host
still fetches and redacts the immutable blob, retains raw evidence, and applies
existing query, per-result byte and per-phase byte limits. Ranges on discovery
or another commit, nonpositive bounds, and empty ranges fail explicitly.
Canonical source hashes and line offsets are unchanged. Required verifier
prefetches also request their known source ranges directly.

The investigator now merges its validated atomic notebook citation ranges
into partial checkpoint, final checkpoint and generation attestations in the
same wave. Previously, the larger inspected window was attested immediately,
but a narrow final claim range could appear only in the next wave's carried
notebook attestation. The producer now records both. Citation resolution still
requires visible pinned source before notebook acceptance; no source check was
replaced by containment-only verification.

Verification: 2,187 tests passed, one skipped; typecheck, changed-file lint and
diff whitespace checks passed. Generic Git fixtures exercise direct line
selection, raw-source preservation, query/byte bounds, and rejection of
non-pinned or invalid requests. Notebook tests cover a narrow last-wave
citation and reject unobserved source.

Sensitivity policy is unchanged. The user has been asked whether verified
security limitations should be usable for private project Q&A while remaining
blocked from public outputs pending review. Until answered, quarantined
findings remain excluded from active-output coverage; no score is inflated by
counting them as available knowledge.

### v34 SoloPilot outcome and v50 navigation-memory correction

The clean `e7583342a3215789fa3b34bf0385d8bfee8a62db` SoloPilot run
(`solopilot-v34-live.json` in `/tmp/workbase-source-audit-v27.YaErOL`, refresh
`cmtq4kerc00028ysbgc85h8jo`, work item `cmtq4kdo200008ysbwsul0xe8`) ended
insufficient-context after 177,560 ms. It used 22 calls, 194,225 semantic tokens,
27 inspections and $0.61886420, with 265,775 semantic tokens still available.
This was not a funding failure and has no eligible current source-audit score.

Directed reads reached proposal lines 1343–1462 and wireframe API lines
1945–2102. However, waves 3–5 retained 14 findings and three unresolved areas:
developer pipeline completion, email approval/delivery, and durable wireframe
generation. The final wave read new source (management API 470–584 and intake
Lambda 740–894), but the incomplete-investigator convergence identity ignored
source exploration. Meanwhile the next wave's carried source inspection was
reconstructed from claim citations only: unclaimed source ranges were absent.
These are observable state/termination defects, not evidence that the agent's
14 provisional findings are sufficient coverage. Some invalid tool inputs
also remain in traces; hashes alone do not establish their exact arguments.

v50 carries the preceding validated source-inspection checkpoint into the next
wave and binds it to the investigation input digest. The model receives only
compact path/range navigation; exact source must still be reread before adding
or revising a claim. Merged inspected intervals also enter the incomplete
investigator's convergence identity. New source can therefore count as
exploration progress without a new claim; duplicate, contained or differently
split reads cannot. Existing spending bounds, review requirements and the
three-repeat guard remain. No private/public sensitivity policy was changed.

This is a lightweight application of the reference-preserving continuation
approach in [Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
not another harness or project-specific navigation rule. Focused tests cover
unclaimed-source checkpoint restoration, stale-snapshot rejection, lack of
citation authority from navigation alone, and normalized exploration identity.
Otto remains excluded; no access attempt or pass/fail result is implied.

Verification: 2,189 tests passed, one skipped; all 86 investigator tests,
typecheck, changed-file lint and diff whitespace checks passed. Live coverage
parity remains unproven.

### v35 outcome: investigation advances, audit submission remains incomplete

`solopilot-v35-live.json` ran clean commit
`4d2e2071c8967d5dced64312fdf90c2f7409caf5`, refresh
`cmtq4yblf0002rrsbc8bjst1m`, work item `cmtq4yaig0000rrsb2letc1el`.
After 378,162 ms it remained insufficient-context, not a coverage pass. The
investigator reached done with 25 provisional findings and no unresolved areas
after seven waves (38 calls, 322,368 semantic tokens, 42 inspections,
$1.02575940). The navigation correction therefore reached review where v33/v34
stalled; this is a process improvement, not a semantic score.

Blind review `cmtq53sdb007nrrsb5gv8rowa` completed 14 observations. Candidate
review `cmtq55403007orrsbjcqr9sb4` completed all 16 required exact reads, but its
first schema-valid submission duplicated an observation and failed the exact
14-observation disposition contract. The bounded phase then exhausted its
34,614-token allowance at 63,230 actual tokens during the correction attempt.
Total investigation/review usage was 48 calls, 454,616 semantic tokens, 73
inspections and $1.07576605; 5,384 semantic tokens remained. No synthesis or
eligible current score exists. Empty missingOperations in the host-generated
incomplete audit is not evidence of complete coverage.

v51 reuses the existing host-required representative-check pattern for
independent observations: required obs_1/obs_2/etc. fields replace the model's
free-form identity array. The host converts these judgments back into the
existing durable array/digest contract. It does not select verdicts, create
missing operations, skip fresh reads, or relax semantic links. Tests cover all
14 required slots, missing/extra slots, rejection of the old free-form model
array, unchanged verdict binding and continued exact-source validation. No
further paid run is implied by these tests.

Additional read-only diagnosis of Backer's upload fragment: the exact saved
revision patch already has a 500-character statement ending in `with S`.
The synthesis statement schema validates a maximum of 500; its materializer
passes the candidate through. The stored raw provider preview is itself
truncated, so it does not independently expose the full original response.
This is not merely display clipping. No historical output was rewritten.

v51 verification: 2,190 tests passed, one skipped; typecheck, changed-file lint
and diff whitespace checks passed. The adjudication guide now shows the
explicit user-requested Otto exclusion instead of instructing a four-project
current run. The frozen manifest and historical scores remain unchanged.

### v36: valid audit submissions, one unresolved verifier gap at the budget boundary

The clean `bdce78eb1f1837d1140c30115b0a9b6bcc46ac5e` run
`solopilot-v36-live.json` finished after 360,463 ms with insufficient context.
Refresh: `cmtq5dpzr0002cnsb3i5h9ey6`; work item:
`cmtq5dpgl0000cnsbgk4rvnw8`. Both candidate audits submitted valid contracts;
the previous duplicate/missing observation failure did not recur.

The first audit (`cmtq5j17b007ocnsbnd4mxozw`) reported nine gaps. Repairs raised
the provisional notebook from 22 to 30 findings. Final audit
`cmtq5kze1007vcnsbowl9jvvn` resolved eight of the nine and retained
`approval_reviewer_ownership_boundary`. Total usage: 51 calls, 450,661 semantic
tokens, 91 inspections, $1.06741843; 9,339 semantic tokens remained, below the
existing repair-plus-reaudit admission requirement. Termination followed a
completed gaps verdict, not malformed output or a no-progress stop. The live
process is terminal; no other paid evaluation was launched during this turn.

Source inspection confirms this remaining topic is material but the verifier's
citation is too narrow for its entire explanation. `approve_reply` selects the
conversation using caller-supplied `conversation_id` at lines 493–521, while
caller-supplied `reviewed_by` is recorded at 704 and again in outbound-history
metadata around 800. The final candidate describes the outer Lambda's lack of
identity validation but not that specific attribution boundary. A repair should
inspect and retain the correct bounded clauses; do not treat lines 493–521 as
proof of the later reviewer-assignment statement or generalize this into a
repository-wide access claim. The checked-in API Gateway contract must also be
considered before describing the deployed authentication boundary.

The investigator's approval-delivery finding also bundles earlier validation
and proposal selection with a citation to lines 657–706, which directly shows
delivery and status mutation rather than every preceding validation action.
Later synthesis critique must not silently promote all those clauses on that
single citation. These are diagnostic observations about provisional output,
not a scored persisted result. There is still no eligible current three-project
comparison or independently established source parity.

Main and origin/main remain `e470dcb3534ee8eb9c0c1030a4a58adc9c25f404`;
both local and origin highlights-visualization refs remain
`d9f6c2dbc4c4b138dd30fdb7c7d9ae2b64df82bc`. User-owned untracked skill
directories are unchanged. The private-Q&A sensitivity-policy question remains
unanswered; quarantine has not been weakened to improve coverage scores.

### v52: preserve an identical source prefix for implicit caching

Context7's current [OpenRouter prompt-caching documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
and [ZDR caching policy](https://openrouter.ai/docs/guides/features/zdr) distinguish
transient implicit in-memory caching from retained prompt storage. OpenRouter
permits the former under ZDR routing. This change does not add explicit cache
breakpoints, TTLs, cache-control flags, provider/model changes, or weaker data
policies.

Candidate comparison previously placed changing candidate claims before fresh
source in the user message and embedded candidate-specific file/range details
in its tool schema. v52 keeps unchanged independent observations and fresh
source before the candidate, uses stable generic check-slot descriptions (the
exact candidate locations remain in the packet), and schedules the immutable
blind-review source targets before changing representative targets. Every
required source range is still checked; this is not verdict caching or reuse
of unverified prior source.

Only the redundant next-action instruction on successful host-prefetch result
wrappers is omitted from the model-facing projection. The phase prompt and
required-read gate retain that navigation responsibility. Source bytes, line
numbers, IDs, errors and host attestations are preserved. Tests check an exact
Unicode-containing source prefix across changed candidate statements and
source locations, stable tool schemas for the same slot cardinality, unchanged
source content, input immutability, and retained error instructions. This
establishes cacheability, not an observed cache hit or a measured cost saving.

Verification: 2,191 tests passed, one skipped; typecheck, changed-file lint and
diff whitespace checks passed. All spending limits and privacy controls remain
unchanged. Live efficiency and complete source coverage are still unproven.

### v37: repair exhausted the budget before a second audit

The clean `75b4f2f531aae193e934e5ba664fb104bfba4451` run
`/tmp/workbase-source-audit-v27.YaErOL/solopilot-v37-live.json` is terminal,
not still running. Refresh `cmtq64m0z000298sbk4gt8e2c`, work item
`cmtq64ktv000098sb17r89e3y`; elapsed 344,689 ms. The initial investigation
finished with 18 provisional findings. Candidate audit
`cmtq69k3s007l98sbl75ygkk6` submitted a valid gaps verdict with 12 missing
operations, including conversation reads, attachment persistence, reply-mode
updates, wireframe sharing, deployment tracking, and provider boundaries.

Three repair waves raised the provisional notebook to 34 findings, but final
usage was 49 model calls, 464,869 semantic tokens against a 460,000 allowance,
76 inspections and $1.16989553 reported cost. The last in-flight call crossed
the allowance; the host refused admission of the next independent verification
phase. No final coverage verdict or eligible saved-output score exists. The
repair's `done: true` is not independent verification of those findings.

Only one candidate audit ran, so cross-audit prefix reuse was not exercised.
Its first provider attempt reported 23,595 input tokens and zero cached input;
its second reported 26,269 input and 23,462 cached input tokens. This shows
within-phase reuse only, not an improvement over v36's already-working
within-phase caching. Do not claim a measured efficiency gain from v37.

The user reiterated that Otto must not be used. It remains explicitly excluded
from the comparison, with no access attempt or pass/fail score. CircleFund,
Backer and SoloPilot remain the retained scope; the source-parity goal is
still incomplete.

### v53: retain configured reasoning for OpenAI checkpoint submissions

The shared Converse loop removed `effort` whenever it forced a terminal tool,
including on OpenRouter/OpenAI. This copied the Bedrock/Anthropic restriction
into a route that supports the combination. v37's repair-wave terminal calls
also showed cache reuse dropping from preceding context-sized hits to about
2,388 tokens. That correlation does not prove the reason for the cache miss.

Following OpenRouter's [reasoning/tool continuity guidance](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
and [tool-choice documentation](https://openrouter.ai/docs/guides/features/tool-calling),
the OpenAI transport now opts into keeping the requested reasoning effort on
forced tools. The same-model retry wrapper forwards that capability. Other
transports retain existing behavior; no model switch, new retry path, spending
increase, source-gate relaxation, or privacy change is introduced.

Tests exercise the full loop-to-OpenRouter request body for both current model
profiles and the unchanged Anthropic case. Live forced-tool capability checks
passed on Azure for Terra (`gen-1788721416-Lkhsc9rEBCEaIsNAiKZC`, $0.000336)
and Luna (`gen-1788721418-16UtAcr5EIr2f2RTJA7q`, $0.00003696). These tiny
checks prove request compatibility, not repository coverage or cache savings.
The full suite passed 2,195 tests with one skipped; typecheck passed. A
same-budget repository run is still required to measure the effect.

### v38 / v54: do not mistake an early discovery checkpoint for final output

`solopilot-v38-live.json` on clean `7520f83aaf37dca27f01b7060005ad9bb52730e6`
stopped after 39,069 ms. Refresh `cmtq6ksnl0002hzsbqxlykhgl`, work item
`cmtq6ks2c0000hzsbc46vtnyg`. Its first wave performed three discovery searches
and durably saved three unresolved workflow leads, `done: false`, with no
findings yet. The post-phase guard then threw “no source-grounded knowledge”
despite the successful incomplete checkpoint. This is a harness lifecycle
error, not proof that the repository lacks knowledge. Recorded budget usage
was two calls, 26,007 semantic tokens, three inspections, $0.0729397.

v54 permits this existing `investigator_checkpoint_yield` state to continue.
The completed-notebook schema still requires source-grounded capabilities and
findings; candidate admission still rejects empty notebooks. The no-progress
guard and all shared budgets remain unchanged. A generic session-lifecycle
test covers checkpoint restoration, refusal to verify the empty candidate,
rejection of false completion, and later exact-source finding creation.
Targeted investigator tests: 89 passed; typecheck passed. No saved-output
coverage score or cache-efficiency claim is supported by v38.

### v39: cache continuity improved locally; end-to-end coverage still fails

The clean `3ac78faf64913e8d45255410d70cf46512ad0252` run
`/tmp/workbase-source-audit-v27.YaErOL/solopilot-v39-live.json` is terminal.
Refresh `cmtq6pwq50002xvsbp8nlwh4n`, work item
`cmtq6pw9c0000xvsbw4iqvirf`; elapsed 455,700 ms. Full tests on this version:
2,196 passed, one skipped; typecheck and changed-file lint passed.

Investigation reached 29 provisional findings and independent verification.
The valid candidate audit `cmtq6x0gm007oxvsbdbzyyx1y` found 13 material gaps
and a dispatch claim whose cited range did not cover its whole statement.
Repair reached 32 findings with 11 unresolved areas, including attachment
references, reply-mode validation, moderation reads/amendment, deployment
record/link behavior, and wireframe retrieval/export. No second audit or
synthesis completed. Final usage: 59 calls, 442,496 semantic tokens, 91
inspections, $1.30326773; 17,504 semantic tokens remained, below candidate
verification admission. These provisional counts are not coverage scores.

Within repair wave 8, cached input progressed from 2,516 on the initial
18,695-token request to 18,692, 20,588, 24,072, 25,916 and 27,590 on subsequent
requests. Thus context-sized cache hits persisted through this wave's
submission sequence. But total run time/cost did not improve versus v37, and
there was no re-audit to test v52 cross-audit reuse. Do not infer overall
efficiency or source parity from the local cache signal.

The final wave spent 17,820 semantic tokens without increasing findings or
inspection count. Its requests had 19,501/19,873 input tokens with
2,516/19,498 cached input. The fixed minimum phase admission is smaller than
the cost of entering this late notebook context, leaving almost no useful
work capacity. The next investigation should examine repeated context and
checkpoint overhead, not rerun this version unchanged or weaken the source
checks. All paid run handles from this turn are terminal. The comparison
against all three retained source audits and matched-main controls remains
incomplete; this experimental branch is not a verified replacement for main.

### v55: separate durable checkpoints from conversation resets

[Anthropic's context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
distinguishes regular external note-taking from compaction near context limits.
[OpenCode's compaction implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts)
similarly checks token pressure and retains recent context. The applicable
pattern here is continuity, not adopting another harness or its infrastructure.

Previously every third inspection forced a notebook update that also ended
the conversation. v55 still durably checkpoints after at most three inspection
calls but continues in the same transcript while capacity allows. A host
pressure check uses observed input/output usage, cumulative raw and semantic
usage, and remaining iteration/tool slots to leave room for inspection and
another checkpoint. Only a completed notebook or pressure-triggered checkpoint
ends the phase. This is a scheduling estimate, not a new spending allowance;
all runtime hard limits, shared reservations, source gates, snapshot binding,
and no-progress checks remain unchanged.

The production helper is exercised in a tool-loop test that performs six
inspections and two durable checkpoints in one growing transcript before
yielding. Separate tests cover raw-token, semantic-token, iteration, and tool
pressure, as well as continuing after an ordinary checkpoint. Full suite:
2,197 passed, one skipped; typecheck passed. Live coverage and relative
efficiency remain to be established on the same pinned repositories.

### v40: second audit completed, six gaps remain

`/tmp/workbase-source-audit-v27.YaErOL/solopilot-v40-live.json` on clean
`b4757a22589f83c71488ecb2c6f8685e2a13167e` finished after 437,768 ms.
Refresh `cmtq799h50002eysb32kz0bnu`, work item
`cmtq798a40000eysbftzx9a8t`. Initial investigation ended after five waves
with 18 provisional findings. The first valid candidate audit
`cmtq7f0xs007ieysb6qxoijcw` found 11 gaps. Repair reached 27 findings;
final valid audit `cmtq7hj6h007peysbe3swqjnr` retained six gaps:
conversation/reply routes, proposal/wireframe routes, pending-reply record,
inbound phase/message mappings, async annotation entry, and the bounded
authentication behavior of later mutation routes.

Final investigation/review usage: 54 calls, 458,557 semantic tokens, 88
inspections, $1.22610243. Only 1,443 semantic tokens remained. No synthesis or
eligible saved-output score exists. This is modestly cheaper/faster than v39
($1.30326773, 455,700 ms), but different model-selected findings and review gaps
mean this single run does not prove non-regressing quality or a general gain.

The re-audit's first call reported 23,859 input / 4,112 cached-input tokens;
its second reported 26,628 / 23,726. There was some cross-audit reuse, but not
full immutable-source-prefix reuse. The initial audit reported 21,950 / 0 then
24,691 / 21,817. All figures are provider-reported leaf attempt usage.

Direct independent inspection of the clean pinned SoloPilot source confirms
that `lambda_api.py:103–165` exposes additional concrete routes beyond a few
representative handlers. A route registry does not itself prove each handler's
downstream effects. `conversation_state.py:152–185` constructs a pending-reply
record and lists possible statuses in a comment; the DynamoDB append begins
later. Do not treat that comment alone as implementation of every transition,
or that range alone as proof of the append side effect. These distinctions
must remain in subsequent semantic review, not be flattened into keyword or
route-count coverage.

The source audits and historical-control refs remain unchanged. Next work
should distinguish actual working-context pressure from cumulative cached
replay, which still causes early phase resets. No further paid run was started
after this terminal result. The three-project source-parity goal remains
incomplete, and Otto remains excluded.
