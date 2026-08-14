# Live lifecycle release gate

`work-item-lifecycle.live.spec.mjs` is an opt-in Playwright test against a
configured Workbase server, real database, real workflow worker, and connected
GitHub account. It is skipped unless `WORKBASE_LIFECYCLE_LIVE_E2E=1`; a skipped
run is not live evidence and must not be reported as a pass.

The suite creates uniquely named evaluation Work Items and records four
release-blocking observations. It exercises a manual-notes-only create through
its terminal durable AgentRun, create with repository attach, repository attach
to an existing item that already has manual-managed automatic Highlights, and
delete/re-add of the same repository. It only deletes Work Items whose exact
title starts with the random prefix created by that test process.

The repository does not make Playwright a production dependency. To run the
scaffold in an evaluation checkout, install the documented test runner and its
Chromium binary without saving it to `package.json`:

```bash
npm install --no-save @playwright/test@1.61.0
npx playwright install chromium
```

Start Workbase and its local workflow runtime with the provider being measured,
then configure the live fixture:

```bash
export WORKBASE_LIFECYCLE_LIVE_E2E=1
export WORKBASE_APPLICATION_EVAL_BASE_URL=http://127.0.0.1:3000
export WORKBASE_LLM_PROVIDER=openrouter
export WORKBASE_LIVE_REPOSITORY_ID='the GitHub repository ID'
export WORKBASE_LIVE_REPOSITORY_FULL_NAME='owner/repository'
export WORKBASE_LIVE_EXPECTED_HEAD_SHA='40-character commit SHA'
export WORKBASE_TESTED_GIT_COMMIT="$(git rev-parse HEAD)"
# Use the same safe deterministic prefix for both sides of a paired run.
export WORKBASE_LIFECYCLE_TITLE_PREFIX='Lifecycle eval paired Resume abc1234'
export WORKBASE_LIFECYCLE_OBSERVATIONS_OUTPUT=/tmp/openrouter-lifecycle.json
# Defaults shown here are release bounds; tune the long stages deliberately.
export WORKBASE_LIFECYCLE_EVIDENCE_READY_SLO_MS=120000
export WORKBASE_LIFECYCLE_MANUAL_AGENT_RUN_TERMINAL_SLO_MS=120000
export WORKBASE_LIFECYCLE_REFRESH_TERMINAL_SLO_MS=600000
export WORKBASE_LIFECYCLE_HIGHLIGHTS_TERMINAL_SLO_MS=600000
export WORKBASE_LIFECYCLE_TOTAL_SLO_MS=600000
npx playwright test --config playwright.lifecycle.config.mjs
```

For paired provider runs, `WORKBASE_LIFECYCLE_TITLE_PREFIX` must be identical
in both isolated database clones. The retained Work Item title is visible to
the answering system and therefore belongs in the accomplishments comparison
identity. Standalone runs may omit it and retain the random collision-resistant
default.

For a separate retained chat-quality benchmark, run one explicitly selected
scenario with `WORKBASE_LIFECYCLE_RETAIN_CREATED_WORK_ITEMS=1`. This flag is
off by default and must not be used for the four-scenario release run above;
the retained item is evaluation data that must be deleted explicitly after the
paired provider report is captured.

The repository ID is the stable release-gate identity. Workbase resolves that
ID through the authenticated GitHub connection and the gate uses the returned
canonical `owner/repository` name for its UI, import, and current-head checks.
`WORKBASE_LIVE_REPOSITORY_FULL_NAME` records the expected name for diagnostics;
a legitimate GitHub rename or transfer cannot make the gate look for a stale
checkbox label or submit stale repository metadata.

Raw observations and evaluated reports use
`workbase-work-item-lifecycle-release-gate-v4`. Version 4 requires the manual
fixture's exact extractive strategy/policy and one exact Evidence citation. The
observation records a SHA-256 digest of that cited Evidence body, never the raw
manual note, so the offline gate can prove the known paragraph-shaped fixture
without copying private source text into the report. Version 3 output predates
this proof and must be rerun instead of being guessed forward.

Action acknowledgement and durable Source reservation are hard-gated at five
seconds and are not configurable upward. The manual path additionally hard
gates durable AgentRun reservation at five seconds, requires terminal
`completed`/`ready` state, and proves successful provider-attributed drafting
and verification GenerationRuns. Multi-batch verification audits every metered
provider batch and separately validates the deterministic authoritative
aggregate linked from the AgentRun result. At least one resulting Highlight must be
active, grounded only in the reserved manual Evidence, managed by
`manual_evidence_highlight_workflow`, and left `pending_review`; safe
quarantined siblings remain visible to the audit.

The repository output separately records `sourceReserved` and `evidenceReady`;
creating the placeholder Source is not treated as a completed import. The gate
also requires at least one successful `semantic_extraction` run, zero failed
semantic-extraction runs, the existing deep-synthesis attribution and usage
contract, exact current-head validation, and no normalized duplicate active
Highlight text. The existing-attach scenario snapshots every pre-attach
manual-managed automatic Highlight and requires every final row to be either
that preserved/explicitly transitioned baseline or a new current-head
`repository_knowledge_sync` row. Unknown ownership, dropped baseline IDs,
ungrounded current-head transitions, and active duplicates fail the gate.
Every current-lineage GenerationRun is summarized with actual/configured
provider and model, sanitized token usage, request and attempt identity, failed
attempt count, truncation state, usage completeness, and measured cost. The
delete/re-add scenario captures the first completed lineage's run telemetry
before cascade deletion; missing semantic, synthesis, manual, or deleted-lineage
cost evidence fails closed.

Use a fresh database clone for each provider. Restart the server and workflow
runtime with `WORKBASE_LLM_PROVIDER=bedrock` for the Bedrock control; never
change only the label passed to the test. Provider/model attribution in the
paired quality report remains authoritative.

Evaluate the recorded lifecycle observations:

```bash
npx tsx scripts/evaluate-work-item-lifecycle-release-gate.ts \
  --input /tmp/openrouter-lifecycle.json \
  --output /tmp/openrouter-lifecycle-gate.json
```

The browser spec records raw Highlight text so duplicate detection is exact.
It does not serialize cited manual Evidence bodies: only their SHA-256 digests
cross the observation boundary. Treat its output as evaluation data and keep
it out of source control.

## Exact repository accomplishments benchmark

Run the literal accomplishments prompt and its exact freshness follow-up
against one explicitly named Work Item/repository pair. Repository-specific
capability expressions and item thresholds are part of the comparison profile,
so use the same arguments for both providers:

```bash
npx tsx scripts/evaluate-project-chat-application.ts \
  --provider openrouter \
  --work-item-exact CircleFund \
  --repository-exact arkb75/CircleFund \
  --required-capability-regex 'circle|membership|invite' \
  --required-capability-regex 'contribution|lending|fund' \
  --forbidden-answer-regex "Workbase(?:['’]s)? documented product flow|career artifacts from approved" \
  --forbidden-answer-regex 'src/lib/bedrock-converse-agent\.ts|\bline\s+956\b' \
  --min-primary-items 3 \
  --max-primary-items 5 \
  --min-developed-items 3 \
  --min-cited-items 3 \
  > /tmp/openrouter-accomplishments.json
```

The equivalent long threshold names are `--minimum-primary-items`,
`--maximum-primary-items`, `--minimum-developed-items`, and
`--minimum-cited-items`. The CLI rejects unknown options, missing values, and
duplicate aliases rather than silently falling back to profile defaults. A
repeatable `--forbidden-answer-regex` fails answers that match known
cross-repository contamination patterns and is part of the paired comparison
identity. A
JSON object or path passed with `--accomplishments-config` can set the same
camel-case fields (`workItemTitle`, `repository`,
`requiredCapabilityPatterns`, `forbiddenAnswerPatterns`,
`includeFreshnessFollowUp`, `minimumPrimaryItems`, `maximumPrimaryItems`,
`minimumDevelopedItems`, `minimumCitedItems`, `minimumCharacters`, and
`maximumCharacters`); unknown profile fields are also rejected.

## Model-led project-chat semantic robustness

The application catalog includes the literal “What models are used for what?”
regression and a same-thread model-role grid paraphrase. Both must let the primary answer model inspect the
attached repository through `inspect_project` with bounded
read-only Git queries, persist an audited `primary_answer` run, and record
`answerCompositionMode=model_tool_loop`. There is no host-runtime shortcut:
the answer must reflect the project source the user attached, and
`deterministic_source_synthesis` is not an acceptable substitute.
The same top-level inspector also supports durable knowledge searches; live
observations record whether each call used `knowledge`, `repository`, or both,
so a memory-only call cannot satisfy a current-source gate. If an initial draft
publishes a central limitation that an authorized inspection could resolve,
the semantic verifier may authorize exactly one smaller evidence continuation.
It may not prescribe exact Git commands, and a second continuation is rejected.
The verifier emits a versioned internal claim ledger rather than one
answer-wide veto. Live observations require at least one retained audited claim
and an explicit `answered` or `answered_with_gaps` publication outcome.
Supported claims survive qualification or removal of a peripheral claim; a
second verifier criticism cannot become a generic refusal.

The broader semantic observation contract lives in
`src/evals/project-chat-semantic-robustness.ts`. It covers freshness
paraphrases, current-source investigation, durable-memory questions, prior-turn
provenance, artifact actions, formatting, conversation, and unsupported
metrics, plus partial-support and reasonable-inference cases across web,
mobile, CLI, ML, infrastructure, scientific, data,
compiler, game, and design-system repositories. Answers are scored by an
attributed semantic judge and compared with a same-model direct Codex/agent
control. The gate describes outcomes and capabilities; it does not match
expected answer phrases, fixed queries, or routing regexes. Evaluate a
collected observation set with:

```bash
npm run eval:project-chat:semantic-robustness -- \
  --input /tmp/project-chat-semantic-observations.json \
  --output /tmp/project-chat-semantic-report.json
```

The command exits `0` only when every semantic, grounding, format, tool-choice,
model-composition, and direct-agent non-inferiority check passes. Exit `2`
means valid evidence with a quality failure; exit `1` means malformed or
incomplete evidence.

## Paired quality comparison

Assemble each provider report from the evaluated lifecycle gate, its raw
observation evidence (needed for model/cost attribution), and the exact
repository accomplishments report:

```bash
npx tsx scripts/assemble-provider-quality-report.ts \
  --provider openrouter \
  --git-commit "$TESTED_GIT_COMMIT" \
  --lifecycle-gate /tmp/openrouter-lifecycle-gate.json \
  --lifecycle-observations /tmp/openrouter-lifecycle.json \
  --accomplishments /tmp/openrouter-accomplishments.json \
  --output /tmp/openrouter-quality.json
```

The assembler rejects commit metadata, repository heads, providers, scenario
sets, and gate/observation telemetry that do not match. All three input
artifacts must embed the same full Git commit; `--git-commit` is an assertion,
not a substitute for artifact identity. Repeat it for the
Bedrock control, then compare the two `workbase-provider-quality-report-v1`
files:

The Bedrock control may be a quality-failing but telemetry-authoritative
baseline. In that case the lifecycle evaluator, accomplishments evaluator, or
assembler can write complete JSON and exit with status 2; preserve the output
and continue to the paired comparator after validating its schema. Status 1 is
an execution/harness error and is never baseline evidence. OpenRouter must exit
0 and pass every absolute gate.

```bash
npx tsx scripts/compare-provider-quality.ts \
  --bedrock /tmp/bedrock-quality.json \
  --openrouter /tmp/openrouter-quality.json \
  --rubric-margin 0.25 \
  --output /tmp/provider-quality-comparison.json
```

The comparator requires the same code commit, repository heads, and scenario
set. OpenRouter must pass every absolute gate, use no fallback, have complete
attribution, retain perfect grounded-claim precision, meet or exceed Bedrock
capability recall, and remain within the rubric margin in every dimension of
every scenario. Every scenario and report must have complete usage and cost
coverage, and OpenRouter's matched measured total cost must not exceed
Bedrock's. The output reports lifecycle, accomplishments, and combined cost
and latency deltas/ratios; latency remains governed by the absolute lifecycle
SLOs rather than a relative faster-than-Bedrock requirement. Aggregate wins
cannot hide an individual regression.
