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
- repository-path validity and claim-to-evidence compatibility;
- supported knowledge-item precision, so irrelevant output volume hurts;
- implemented-versus-planned classification;
- near-duplicate Highlight rate and domain diversity;
- static, semantic, and knowledge coverage calibration;
- generated/tooling artifact exclusion from analyzed and semantic paths;
- capability-map precision, generic-token false positives, and granularity
  explosion (for example, `Model.java` is not automatically an AI runtime);
- bounded duration, model calls, tokens, and estimated cost.

The aggregate is a macro average with a worst-project floor. A strong score on
Workbase cannot hide a failure on a small finance app or a Java repository.
Reports retain raw Highlights/Facts, capability assignments, and provenance
paths so a scalar score is always auditable.

## Obtain an observation from a branch

For a product-level run, use the branch normally:

1. Import or refresh the target repository through the ordinary application
   flow and wait for repository refresh to finish.
2. Run the database adapter. It reads the latest analyzed snapshot, active
   commit-validated Highlights and Project Facts, their evidence, the
   capability ledger, path dispositions, semantic statuses, and generation
   usage. It does not call a model or mutate product state.

```bash
npm run eval:repository-knowledge -- --from-database-all > /tmp/branch-report.json
```

Use one or more `--from-database <fixture-id>` flags for a subset. The six real
fixture IDs are listed above. The output contains one stable JSON profile and
report per repository plus the aggregate and the normalized observations.

For full provenance validation, point each profile at the corresponding local
checkout. This expands the compact fixture inventory so evidence from any real
file—not only a representative fixture path—can be validated. Quoted evidence
is read only from referenced files and is bounded to 512 KiB per file.

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
malformed provenance fail before scoring. `--compact` emits single-line JSON.

## CI boundary

`npm run test:eval` runs the deterministic scorer, fixture catalog audit, and
adversarial regressions offline. Live repository import and model synthesis
remain opt-in because they require GitHub, model, and database credentials.
The exact same evaluator and profiles must score each competing branch; only
the branch-produced observation changes.
