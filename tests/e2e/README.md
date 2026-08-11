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
export WORKBASE_LIFECYCLE_OBSERVATIONS_OUTPUT=/tmp/openrouter-lifecycle.json
# Defaults shown here are release bounds; tune the long stages deliberately.
export WORKBASE_LIFECYCLE_EVIDENCE_READY_SLO_MS=120000
export WORKBASE_LIFECYCLE_MANUAL_AGENT_RUN_TERMINAL_SLO_MS=120000
export WORKBASE_LIFECYCLE_REFRESH_TERMINAL_SLO_MS=600000
export WORKBASE_LIFECYCLE_HIGHLIGHTS_TERMINAL_SLO_MS=600000
export WORKBASE_LIFECYCLE_TOTAL_SLO_MS=600000
npx playwright test --config playwright.lifecycle.config.mjs
```

The repository ID is the stable release-gate identity. Workbase resolves that
ID through the authenticated GitHub connection and the gate uses the returned
canonical `owner/repository` name for its UI, import, and current-head checks.
`WORKBASE_LIVE_REPOSITORY_FULL_NAME` records the expected name for diagnostics;
a legitimate GitHub rename or transfer cannot make the gate look for a stale
checkbox label or submit stale repository metadata.

Raw observations and evaluated reports use
`workbase-work-item-lifecycle-release-gate-v3`. Version 3 makes the configured
and canonical repository names plus the canonicalization flag part of the
required release-evidence contract. The evaluator safely normalizes v2 manual
observations and late v2 repository observations that already recorded those
fields; earlier v2 repository output cannot prove rename/transfer handling and
must be rerun instead of being guessed forward.

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
Treat its output as evaluation data and keep it out of source control.

## Paired quality comparison

After the same scenario/rubric process produces one `workbase-provider-quality-report-v1`
JSON file per provider, compare them with:

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
every scenario. Aggregate wins cannot hide an individual regression.
