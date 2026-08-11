# OpenRouter migration and validation

This is the implementation, live-validation, and rollback record for moving
Workbase text generation and embeddings from an AWS-only runtime to OpenRouter.
The Bedrock Sonnet 4.6 and Titan configuration remains available as a tested
rollback path.

## Selected production configuration

The final text routing is explicit in `.env.example` so deployment cannot
silently collapse specialized work back onto the base model.

| Workload profile | Selected model | Reason |
| --- | --- | --- |
| `primary_answer` | `openai/gpt-5.6-terra` | Frontier comparison winner |
| `deep_synthesis` | `openai/gpt-5.6-terra` | Frontier reasoning retained for the highest-complexity synthesis |
| `verification` | `openai/gpt-5.6-luna` | Passed the safety and exact-source verifier contracts at lower cost |
| `drafting` | `openai/gpt-5.6-luna` | Passed grounded artifact drafting and final verification |
| `code_extraction` | `openai/gpt-5.4-mini` | Passed extraction and structured-output contracts at lower cost |
| `routing` | `openai/gpt-5.6-luna` | GPT-5.4 nano failed one raw routing safety case; Luna passed all cases |
| `json_repair` | `openai/gpt-5.4-nano` | Passed the bounded JSON-repair contract |

`anthropic/claude-sonnet-5` remains the cross-family fallback, but runtime code
permits it only for `primary_answer` and `verification`, the two profiles where
it cleared the live gate. A retryable infrastructure failure may trigger that
fallback. Validation, moderation, schema, and caller-cancellation failures do
not. Every profile first receives OpenRouter's same-model provider failover.

The selected embedding model is `openai/text-embedding-3-small` at 512
dimensions. The reconciled Titan index remains ready and write-enabled for
immediate rollback. The evaluated `text-embedding-3-large` index remains ready
but write-disabled. This active/ready state was established on the isolated
validation clone. In any target database, `WORKBASE_EMBEDDING_PROVIDER` selects
the default candidate for registration; it does not bypass the database-backed
quality gate or change the active index by itself.

## Runtime and privacy invariants

- Every OpenRouter request requires zero-data-retention routing and support for
  every supplied parameter. These are hard-coded runtime invariants, not
  deployment switches.
- OpenRouter requests do not opt into provider prompt or response caching. The
  Bedrock rollback adapter retains its existing cache behavior.
- The text client uses `max_completion_tokens`, which the selected strict-ZDR
  endpoints advertise. A live preflight proved that `max_tokens` would exclude
  every eligible endpoint when strict parameter matching is enabled.
- Model reasoning details are replayed when a model continues a tool-use turn.
- External failures are normalized and sanitized before reaching application
  logs or user-visible state.
- Provider-reported OpenRouter cost is authoritative. Workbase retains token,
  cache, reasoning, actual-model, routed-provider, request-ID, failed-attempt,
  and fallback attribution. Missing usage is recorded as unknown rather than
  silently treated as zero.

Observed OpenRouter catalog rates on 2026-07-29 were:

| Model | Input / 1M tokens | Output / 1M tokens |
| --- | ---: | ---: |
| `openai/gpt-5.6-terra` | $1.25 | $7.50 |
| `anthropic/claude-sonnet-5` | $2.00 | $10.00 |
| `openai/gpt-5.6-luna` | $0.50 | $3.00 |
| `openai/gpt-5.4-mini` | $0.75 | $4.50 |
| `openai/gpt-5.4-nano` | $0.20 | $1.25 |

Terra and Luna were under a limited-time catalog promotion during validation,
so production accounting never assumes these observed rates remain current.
Observed embedding input rates were $0.02/1M tokens for
`text-embedding-3-small` and $0.13/1M for `text-embedding-3-large`.

## Validation isolation

The untouched baseline was captured from exact `origin/main` commit
`d862cb43321fbc2bd92b7e1c2ddf537943a38abd`. Integrated live validation used
the same repository snapshot and a fresh, auto-expiring Neon branch cloned
from the source database. The source database was not mutated. All 22 Prisma
migrations were current on the clone, and evaluation writes were scoped to one
known Work Item and cleaned up exactly.

## Untouched Bedrock baseline

| Check | Result |
| --- | --- |
| Unit tests | 93 files, 864 tests passed |
| Workflow tests | 1 file, 2 tests passed |
| Lint, TypeScript, production build | passed |
| Bedrock Sonnet 4.6 capability preflight | tool use, JSON Schema, adaptive effort, and prompt caching passed |
| Provider-independent scenario contracts | 27 valid |
| Evaluation tests | 38 passed |
| Legacy live project-chat benchmark | 17/17 checks, 16/16 quality checks, 4/4 diagnostics; 102,989 ms |
| Representative five-scenario application benchmark | 3/5 scenarios; 327,082 ms aggregate |
| Historical Titan retrieval fixture | recall@10 1.0000, MRR 0.8125, 742 ms mean latency |

The five representative scenarios covered strongest accomplishments, design
tradeoffs, missing-p95 safety, targeted repository research, and public
artifact generation:

- strongest accomplishments passed its answer checks with 10 citations but
  exceeded 30 seconds at 181,289 ms;
- design tradeoffs passed in 5,307 ms with 6 citations;
- missing-p95 safety passed in 5,549 ms with 2 citations and did not invent the
  absent production metric;
- targeted repository research passed in 21,865 ms with one tree lookup, two
  searches, two file reads, and 11,001 visible bytes; and
- artifact generation exceeded 25 seconds at 113,072 ms and ended in
  `insufficient_context` after the public-safety quarantine.

The historical evaluator reported zero model calls, tokens, and cost despite
the artifact path making at least a draft and verifier call. That telemetry
defect was fixed as part of this migration; baseline cost is therefore not
used for a false cost comparison.

A second Bedrock control on the integrated evaluator passed 4/5 representative
scenarios in 111,102 ms with 5 attributed model calls, 7,893 tokens, and an
estimated $0.070203. Artifact generation remained the one insufficient result
at 64,603 ms.

## Live text-model results

All five unique configured models—Terra, Sonnet 5, Luna, GPT-5.4 mini, and
GPT-5.4 nano—passed live JSON Schema and strict tool-use preflights with ZDR and
strict parameter matching. The preflight also checked the returned model
identity, routed provider, usage, and cost.

### Frontier comparison

| Candidate | Targeted profile checks | Elapsed | Tokens | Cost | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| `openai/gpt-5.6-terra` | 7/7 | 20,291 ms | 6,350 | $0.0376625 | selected |
| `anthropic/claude-sonnet-5` | 5/7 | 52,867 ms | 14,421 | $0.0639940 | fallback only |

Terra passed every targeted profile check while Sonnet 5 failed deep-output
validation and one raw routing-safety check. Terra was also about 41% cheaper
and 62% faster in this matched matrix.

The broader live application comparison confirmed the decision:

| Candidate | Application scenarios | Elapsed | Calls | Tokens | Cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Terra | 7/8 | 121,840 ms | 5 | 33,878 | $0.100808 |
| Sonnet 5 | 5/8 | 159,340 ms | 8 | 84,679 | $0.191118 |

Both runs had complete authoritative attribution and no fallback. Terra used
2.5 times fewer tokens, cost 47% less, and completed about 24% faster. Its one
failure exposed contradictory artifact-prompt pressure rather than a model
capability gap; the prompt and exact-approved-source contract were corrected
without weakening the fail-closed publication verifier.

### Specialized routing

An initial all-small matrix with GPT-5.4 nano as the router passed 6/7 checks
and was rejected because cost savings did not justify the routing-safety
regression. Replacing only that role with Luna produced the selected matrix:

| Configuration | Checks | Elapsed | Cost | Relative cost |
| --- | ---: | ---: | ---: | ---: |
| Terra for all profiles | 7/7 | 20,291 ms | $0.0376625 | baseline |
| Selected Terra/Luna/mini/nano routing | 7/7 | 28,030 ms | $0.02912255 | 22.7% lower |

The selected matrix had complete usage and model attribution, no failed
attempts, and no fallback. Smaller models were promoted only for profiles that
retained all quality, grounding, ownership, and structured-output checks.

### Final representative application suite

The final selected configuration passed all 40/40 live checks in 283,489 ms.
It made 5 model calls, used 33,567 total tokens, and cost $0.091530. Usage and
provider attribution were complete, configured and actual routing matched,
and there were no failed attempts or fallbacks.

This final run included real project-memory answers, comparison questions,
missing-data safety, repository research, long-thread behavior, and artifact
publication. The artifact scenario passed in 13,403 ms with one Luna draft and
one Luna verification call, 1,358 tokens, and $0.002408. Its single output
claim preserved the exact approved Highlight and remained backed by one
approved evidence source.

The previously used legacy project-chat benchmark also passed after migration:

- 20/20 total checks and 16/16 answer-quality checks;
- 3/3 available diagnostics passed;
- 10,170 ms, with 10 citations and no model call required for the answer; and
- the historical prioritized-ledger diagnostic was reported as unavailable,
  not failed, because the pinned historical refresh contains no ledger rows.

The zero-call result is authoritative: the answer hash and evidence-backed
output were verified, while token and cost attribution correctly remained
zero. This avoids turning deterministic retrieval into an artificial telemetry
failure.

## Live embedding decision

Each OpenRouter candidate was built beside Titan, dual-written, backfilled, and
reconciled across Highlights, Project Facts, Evidence, and Artifacts. The
validation clone contained 33 stored vectors—10 Highlights and 23 Project
Facts—and finished with no missing rows or input-hash mismatches.

| Index | Recall@10 | MRR | Required-source loss | Mean / p95 latency | Query cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Titan live control | 1.0000 | 0.8125 | — | 854.43 / 1,691.81 ms | unavailable |
| `text-embedding-3-small` | 1.0000 | 0.9375 | 0 | 610.50 / 1,263.33 ms | $0.00000202 |
| `text-embedding-3-large` | 1.0000 | 0.8750 | 0 | 625.69 / 1,235.84 ms | $0.00001313 |

`text-embedding-3-small` was activated because it had the best MRR and was
84.6% cheaper than the large candidate on the matched query set. Its full
6,604-token backfill cost $0.00013208; the large backfill cost $0.00085852.

After all final application writes, the active small index again passed at
recall@10 1.0000 and MRR 0.9375, with 657.56 ms mean and 1,410.35 ms p95
latency. Titan was then independently reconciled and passed the rollback gate
at recall@10 1.0000, MRR 0.8125, zero required-source loss, 676.99 ms mean, and
1,248.84 ms p95 latency. The final control state is:

| Index | State | Writes | Quality gate |
| --- | --- | --- | --- |
| `openrouter-openai-text-embedding-3-small-512` | active | enabled | passed |
| `legacy-bedrock-titan-v2-512` | ready rollback | enabled | passed |
| `openrouter-openai-text-embedding-3-large-512` | ready challenger | disabled | passed |

The activation epoch is 1 and the write-set epoch is 5. Retrieval embeds each
query with the active index identity and filters all vector scans to that same
version, so vectors from unrelated coordinate spaces cannot mix. The committed
fixture hash remained
`6829c0d73c2f76ffcf72e3b4bdd2281fe0575fbde25ca2a2bf2e23e1c184cf79`
through the selection, final active-index check, and rollback drill.

## Final deterministic validation

| Check | Result |
| --- | --- |
| Unit tests | 106 files, 1,174 tests passed |
| Workflow tests | 1 file, 2 tests passed |
| TypeScript | passed |
| ESLint | passed |
| Production build | passed; 33 workflow steps across 3 workflows and 9 static pages |
| Live selected application suite | 40/40 checks passed |
| Live legacy benchmark | 20/20 checks passed |
| Live embedding activation and rollback gates | passed |

## Embedding lifecycle

Candidate indexes are never activated merely because a backfill command
finished. The lifecycle is:

1. register at the current activation epoch;
2. dual-write the active and every enabled building index;
3. backfill all four knowledge types;
4. reconcile writes that landed during the build;
5. require complete coverage and matching input hashes;
6. run and record the retrieval-quality gate;
7. activate with an epoch fence in one transaction; and
8. retain and write the previous index through the rollback window.

Use `npm run db:embedding-index -- list` to inspect the active identity and
epochs. A production promotion uses the exact sequence below, substituting the
current epoch from `list` and retaining the report with the deployment record:

```bash
npm run db:embedding-index -- register --provider openrouter --model openai/text-embedding-3-small --key openrouter-openai-text-embedding-3-small-512
npm run db:embedding-index -- backfill --key openrouter-openai-text-embedding-3-small-512
npm run db:embedding-index -- reconcile --key openrouter-openai-text-embedding-3-small-512
npm run eval:embeddings -- --fixture src/evals/embedding-retrieval-fixtures.json --candidate openrouter-openai-text-embedding-3-small-512 --mode promotion --record --output embedding-small-promotion.json
npm run db:embedding-index -- activate --key openrouter-openai-text-embedding-3-small-512 --expected-epoch N
```

Do not activate if the evaluation fails or its validation fence is stale. The
`record-quality`, `rollback`, and `disable-writes` subcommands support manual
report attachment, rollback, and retirement after the observation window.

## Rollback

For text rollback, set `WORKBASE_LLM_PROVIDER=bedrock`, retain the committed
`WORKBASE_BEDROCK_*` model and region values, restart the application, and
confirm `/api/health` reports Bedrock for every text profile before reopening
traffic.

For embedding rollback:

1. leave the active-index control row unchanged while Titan is checked;
2. backfill and reconcile `legacy-bedrock-titan-v2-512`;
3. run the rollback-mode embedding quality gate and require zero missing rows,
   zero input-hash mismatches, and no missing fixture-required source groups;
4. read the current activation epoch with the `list` command;
5. atomically run `rollback --key legacy-bedrock-titan-v2-512
   --expected-epoch N`; and
6. restart the application and confirm Titan is active and write-enabled.

Rollback-mode evaluation embeds queries only with the requested rollback
candidate and searches only that candidate's stored vectors. It does not call
the active embedding provider, so a complete OpenRouter outage cannot prevent
Titan from being re-gated. The recorded report marks `activeQueried: false`,
leaves active baseline metrics and telemetry as `null`, and compares candidate
recall/MRR with the fixture's recorded absolute thresholds. Every required
fixture source group must also have at least one candidate hit in the top 10.
Promotion mode continues to query both indexes and enforce active-index as well
as historical non-inferiority.

The readiness endpoint proves database and text-runtime readiness; the
embedding-index `list` command is authoritative for embedding identity. Neither
rollback requires deleting OpenRouter vectors or rewriting knowledge rows.
