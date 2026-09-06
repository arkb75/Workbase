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

1. Complete a live run once the review endpoint can serve requests reliably;
   retain the existing checkpoints and failed artifacts for diagnosis.
2. Export and inspect only its automatically applied, active Facts/Highlights.
3. Adjudicate against the frozen source units and questions, including material
   negative boundaries and evidence support.
4. Complete SoloPilot, Backer, and Otto on a consistently recorded implementation;
   compare the three matched projects against main's frozen historical controls.
5. Fix generalized semantic deficits that the saved-output comparison actually
   reveals. Do not declare success from item counts, a verifier pass, or tests alone.
