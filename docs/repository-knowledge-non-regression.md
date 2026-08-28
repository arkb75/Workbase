# Repository knowledge non-regression gate

The comparison command consumes evaluator JSON files, so it is independent of
the extraction implementation and does not contain repository-specific rules.
Score every variant with the same fixture catalog and evaluator before running
the gate.

```bash
npm run --silent eval:repository-knowledge:compare -- \
  --candidate hybrid=/tmp/hybrid-report.json \
  --baseline orchestrated=/tmp/orchestrated-report.json \
  --baseline previous=/tmp/previous-report.json \
  > /tmp/hybrid-comparison.json
```

It aligns fixtures by `fixtureId` and compares:

- aggregate score, macro average, worst-project floor, and passing-fixture rate;
- per-fixture score, capability recall, knowledge-item and evidence precision,
  claim-state correctness, and inventory hygiene;
- summed and per-fixture model attempts/calls, tokens, estimated cost, and
  duration when the evaluator observations report them.

A missing candidate fixture, a pass-to-fail change, lost baseline telemetry, or
a movement beyond tolerance fails the command with exit code `1`. A fixture
that was already below the evaluator's absolute release bar is still compared
normally; it is not mislabeled as a new regression unless it loses quality or
crosses another configured bound. Invalid input exits with code `2`.

Defaults allow a 0.02 aggregate-score drop, 0.03 per-fixture score drop, 0.05
per-fixture metric drop, and 25% operational increase. These are explicit and
can be tightened for a release:

```bash
npm run --silent eval:repository-knowledge:compare -- \
  --candidate hybrid=/tmp/hybrid-report.json \
  --baseline control=/tmp/control-report.json \
  --aggregate-quality-tolerance 0 \
  --fixture-score-tolerance 0.01 \
  --fixture-metric-tolerance 0.02 \
  --operational-tolerance 0.10
```

The command writes auditable JSON containing every aggregate and per-fixture
delta, its configured tolerance, and a compact regression list for each named
baseline. `--compact` emits one-line JSON for automation.
