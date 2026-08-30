# Generalized repository knowledge evaluation

This suite compares repository knowledge and Highlight extraction across
different implementations without importing either implementation. The shared
boundary is a versioned JSON observation: durable Highlights and Project Facts,
their repository provenance, the discovered capability map, analyzed paths,
reported coverage, and measured runtime usage.

## Project catalog

The deterministic catalog covers seven shapes rather than treating Workbase as
the default ontology:

| Fixture | Shape | Languages | Source |
| --- | --- | --- | --- |
| `backer-marketplace` | founder/investor SaaS marketplace | TypeScript | `arkb75/Backer` |
| `solopilot-agent-documents` | agent and document workflow | Python, TypeScript, JavaScript | `arkb75/SoloPilot` |
| `circlefund-fintech` | lending-circle group workflow | TypeScript, SQL | `arkb75/CircleFund` |
| `workbase-project-knowledge` | developer knowledge platform | TypeScript, SQL | `arkb75/Workbase` |
| `insightubc-dataset-platform` | dataset query and visualization app | TypeScript, JavaScript | `arkb75/InsightUBC` |
| `amazon-marketplace-analytics` | Java desktop analytics plus Python ML service | Java, Python, JSON | `arkb75/Amazon-Marketplace-Analytic-Software` |
| `cloudsync-cli-library` | CLI and embeddable library | TypeScript | synthetic offline archetype |

The real profiles record the commit used to curate representative capability
paths. They use regex families and evidence paths, not exact generated prose.
The suite has explicit planned-feature traps: CircleFund's future loan/review/
repayment lifecycle; SoloPilot's in-progress planning/export; and InsightUBC's
future CSV, broader visualization, loading, cache, and history work.

## What it scores

- weighted, major, and Highlight-specific implemented-capability recall;
- domain recall without requiring one fixed taxonomy;
- repository-path and exact-quote validity (including bounded, explicit secret
  redaction placeholders) plus deterministic claim-to-evidence relevance;
- open-world knowledge-item precision: legitimate additional capabilities are
  supported by their repository evidence rather than rejected for not appearing
  in the curated recall catalog, while unrelated claims still hurt;
- implemented-versus-planned classification;
- near-duplicate Highlight rate and domain diversity;
- static, semantic, and knowledge coverage calibration;
- generated/tooling artifact exclusion from analyzed and semantic paths;
- capability-map precision over asserted evidence mappings, blending valid,
  non-generated repository provenance with deterministic label-to-evidence
  relevance; an arbitrary label on a real path receives only partial credit,
  empty structural ledger placeholders are neutral for precision but still
  count toward a repository-size-calibrated granularity ceiling, and explicit
  generic-token false positives remain penalized (for example, `Model.java` is
  not automatically an AI runtime);
- bounded duration, model calls, tokens, and estimated cost.

The aggregate is a macro average with a worst-project floor. A strong score on
Workbase cannot hide a failure on a small finance app or a Java repository.
Reports retain raw Highlights/Facts, capability assignments, and provenance
paths so a scalar score is always auditable.

## Run the production lifecycle end to end

The opt-in live runner creates temporary project work items from the same real
fixture catalog, then executes the ordinary production sequence: start,
inventory, production-sized static chunks, coverage repair and finalization,
knowledge reconciliation, staleness reconciliation, and completion. It is
sequential by design so repository/provider budgets remain auditable. A variant
slug is required and is recorded in every temporary work-item title.

The certified main path uses native structured output with one provider attempt
per generation. Semantic planning and extraction, synthesis, and citation
entailment are recorded separately. Synthesis batches retain the 28 KiB,
two-subsystem, and ten-claim safety bounds while deterministically backfilling
compatible scopes. Entailment critics run on the verification profile rather
than the synthesis profile; database certification checks each phase against
its configured model identity and rejects silent provider/model substitution,
text-repair transport, failed attempts, or deterministic fallback output.

```bash
npm run eval:repository-knowledge:live -- \
  --variant adaptive \
  --fixture circlefund-fintech \
  --fixture amazon-marketplace-analytics
```

Omit `--fixture` to run all six real profiles. The evaluation user comes from
`WORKBASE_DEMO_USER_EMAIL`, or may be supplied with `--user-email`; that user
must already have a GitHub connection. The runner prints the work-item and
refresh-run IDs needed for database scoring and later cleanup. It does not
silently delete results. Cleanup requires each temporary work-item ID
explicitly, verifies the evaluation user owns it, refuses titles not marked as
an evaluation, and uses the ordinary fenced deletion lifecycle to cancel any
active work safely:

```bash
npm run eval:repository-knowledge:live -- \
  --cleanup-work-item <temporary-work-item-id> \
  --cleanup-work-item <another-temporary-work-item-id>
```

## Obtain an observation from a branch

For a product-level run, use the branch normally:

1. Import or refresh the target repository through the ordinary application
   flow and wait for repository refresh to finish.
2. Run the database adapter. It reads the latest analyzed snapshot, active
   commit-validated Highlights and Project Facts, their evidence, the
   capability ledger, path dispositions, semantic statuses, and generation
   usage. It does not call a model or mutate product state.

Every selected curated profile must be paired with `--repository-root` at its
exact clean pinned checkout. This is required for both database and serialized
observations; a compact fixture manifest alone is useful for offline scorer
tests, but cannot certify real-repository provenance.

When comparing variants in one database, scope every profile to the exact
work-item ID printed by its live run so a newer run cannot replace the intended
observation:

```bash
npm run eval:repository-knowledge -- \
  --from-database circlefund-fintech \
  --work-item circlefund-fintech=<temporary-work-item-id> \
  --repository-root circlefund-fintech=/tmp/repos/CircleFund
```

Use one or more `--from-database <fixture-id>` flags for a subset. The six real
fixture IDs are listed above. The output contains one stable JSON profile and
report per repository plus the aggregate and the normalized observations.

The required checkout expands the compact fixture inventory so evidence from
any real file—not only a representative fixture path—can be validated. It must
resolve to the fixture's pinned commit and have no tracked working-tree drift;
untracked files are excluded from the manifest. Every cited file is read for
source-grounding verification, bounded to 512 KiB per file, 2,000 files, and
32 MiB in total. The curated
capability patterns remain recall targets and planned-feature traps, not a
whitelist of everything a branch is allowed to discover.

For curated provenance, a file path alone is never evidence. A citation must
either declare a valid start and end line in the pinned blob, or provide an
exact excerpt with a unique deterministic anchor in that blob. Half-ranges,
missing files, ambiguous un-ranged excerpts, and quotes outside their declared
range fail grounding.

```bash
npm run eval:repository-knowledge -- \
  --from-database-all \
  --repository-root backer-marketplace=/tmp/repos/Backer \
  --repository-root solopilot-agent-documents=/tmp/repos/SoloPilot \
  --repository-root circlefund-fintech=/tmp/repos/CircleFund \
  --repository-root workbase-project-knowledge=/tmp/repos/Workbase \
  --repository-root insightubc-dataset-platform=/tmp/repos/InsightUBC \
  --repository-root amazon-marketplace-analytics=/tmp/repos/Amazon-Marketplace-Analytic-Software
```

## Score serialized branch output

An implementation may instead emit the neutral
`repository-knowledge-evaluation-v1` observation contract from
`src/evals/repository-knowledge-quality.ts`. Score one observation, an array,
or an object containing `runs` or `observations`:

```bash
npm run eval:repository-knowledge -- \
  --observation /tmp/branch-observations.json \
  --repository-root circlefund-fintech=/tmp/repos/CircleFund
```

Inputs are strict: unknown fields, out-of-range coverage, negative usage, and
malformed provenance fail before scoring. Serialized observations are useful
for quality diagnostics and branch-to-branch score comparisons, but their
execution-integrity fields are self-attested and are therefore ignored for
curated certification. Use `--from-database` to certify provider identity,
policy, fallback, and generation-chain integrity from persisted production
records. `--compact` emits single-line JSON.

## CI boundary

`npm run test:eval` runs the deterministic scorer, fixture catalog audit, and
adversarial regressions offline. Live repository import and model synthesis
remain opt-in because they require GitHub, model, and database credentials.
The exact same evaluator and profiles must score each competing branch; only
the branch-produced observation changes.
