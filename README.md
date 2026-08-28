# Workbase

Workbase helps early-career CS students and engineers turn real technical work into verified career content.

The product is built around one hard rule: public Artifacts are generated from approved, visibility-compatible Highlights only. Raw notes and repository files never go straight into public output generation.

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Prisma 7 with Neon/PostgreSQL
- Provider-neutral model runtime using OpenRouter strict-ZDR chat completions,
  role-specific model profiles, and a controlled Bedrock rollback path
- GitHub OAuth App integration with bounded REST ingestion
- Vitest for domain tests

## Product loop

1. Complete onboarding and set the workspace goal
2. Create a Work Item; its description and optional notes are persisted as
   private Sources/Evidence immediately, while provider work is reserved in a
   durable workflow before the action redirects
3. Attach manual notes and import a real GitHub repository; repository imports
   use their own request/workflow lineage and remain observable across reloads
4. Refresh commit-pinned repository knowledge and cluster Evidence into work themes
5. Auto-apply supported, non-sensitive Project Facts and Highlights as private
   project memory. Manual-note Highlights remain pending review and use a
   distinct producer/provenance class from repository reconciliation
6. Surface every new, revised, stale, or superseded item in the review inbox while quarantining unsafe or insufficiently supported candidates
7. Keep, edit, revert, retire, or sensitivity-classify those changes without blocking ordinary private project chat
8. Generate resume bullets, a LinkedIn-style entry, or a short project summary from approved, non-sensitive Highlights only

## Local setup

1. Install dependencies

```bash
npm install
```

2. Create a local env file from the example

```bash
cp .env.example .env
```

3. Set `DATABASE_URL` and `DIRECT_URL` to your Neon Postgres connection strings in `.env`
4. Add the OpenRouter API key, GitHub OAuth App, and encryption settings from
   `.env.example`

Validate every unique configured text model (including the cross-family
fallback) with strict structured output before starting the app:

```bash
npm run openrouter:preflight
```

Every OpenRouter request requires zero-data-retention routing and provider
support for all supplied parameters. `WORKBASE_LLM_PROVIDER=bedrock` plus the
retained `WORKBASE_BEDROCK_*` values provides the migration rollback switch.

Production and representative cold-import runs exercise both configured model
paths: `routing` for semantic work-package planning and `deep_synthesis` for
repository knowledge synthesis:

```bash
WORKBASE_REPOSITORY_SYNTHESIS_MODE=model
WORKBASE_SEMANTIC_PLANNER_MODE=model
```

The deterministic planner and synthesis modes are available only as explicit
debug/degraded alternatives. Neither can pass the representative live gate.

For proactive production refreshes, also set:

- `WORKBASE_GITHUB_WEBHOOK_URL` to the public HTTPS
  `/api/github/webhook` endpoint.
- `GITHUB_WEBHOOK_SECRET` to a random value of at least 32 characters.
- `WORKBASE_GITHUB_REQUEST_TIMEOUT_MS` to the bounded per-request GitHub REST
  deadline (the deployment default is 30 seconds).

Workbase registers a push-only repository webhook when an attached repository
is administered by the connected GitHub user. Repositories without webhook
administration permission continue to use the scheduled freshness scan.

The executable cold-lifecycle and provider-comparison runbook is in
[`tests/e2e/README.md`](tests/e2e/README.md). Migration decisions, historical
controls, privacy invariants, and embedding rollback procedure are recorded in
[`docs/openrouter-migration.md`](docs/openrouter-migration.md).
The implementation-neutral, multi-project repository extraction gate and its
local/serialized observation runner are documented in
[`docs/repository-knowledge-evaluation.md`](docs/repository-knowledge-evaluation.md).

5. Generate the Prisma client and apply committed migrations

```bash
npm run db:prepare
```

6. Seed the demo workspace

```bash
npm run db:seed
```

7. Start the app

```bash
npm run dev
```

The app uses a single demo user defined by `WORKBASE_DEMO_USER_EMAIL` and `WORKBASE_DEMO_USER_NAME`.

## Useful commands

```bash
npm run dev
npm run lint
npx tsc --noEmit
npm run test
npm run db:prepare
npm run openrouter:preflight
```

## Included routes

- `/onboarding`
- `/dashboard`
- `/work-items/new`
- `/work-items/[id]`
- `/work-items/[id]?tab=highlights`
- `/work-items/[id]?tab=artifacts`
- `/api/github/connect`
- `/api/github/callback`
- `/api/github/webhook`
- `/api/health`

## Testing focus

The test suite covers:

- claim status transitions
- GitHub connection encryption and OAuth exchange handling
- bounded GitHub repo import behavior
- four real cold lifecycle shapes: manual-only create, create-and-attach,
  attach to an existing manual item, and delete/re-add with disjoint lineage
- signed GitHub push delivery validation, redelivery deduplication, and
  proactive refresh coalescing
- evidence persistence refresh/dedupe behavior
- artifact eligibility constraints
- claim regeneration behavior
- multi-turn project chat, citation grounding, retrieval, and prior-turn provenance
- primary-model-led project chat planning, iterative tool selection, answer composition,
  semantic verification, and durable provider/model/usage attribution. Real
  providers do not use lexical routing or deterministic source-shaped prose
- semantic robustness families covering freshness and format paraphrases,
  elliptical follow-ups, current model-role questions, partial-support
  survival, reasonable inference, distractors, unsupported questions, and
  non-inferiority to a same-model direct-agent run
- exact same-thread accomplishments freshness follow-ups, including current-head
  breadth continuity and cross-repository contamination rejection
- commit-pinned repository refresh, semantic orchestration, reconciliation, and staleness
- generalized repository knowledge extraction across SaaS, agent/document,
  fintech, developer-tool, dataset, Java/ML, and CLI/library shapes, including
  coverage calibration, provenance precision, planned-feature traps, generated
  artifact pollution, generic-token false positives, and cluster granularity
- DLP-safe manual-note generation, content-addressed provenance/input fences,
  deterministic extractive recovery, and cited-source-only attribution
- durable chat and artifact workflows, including review/resume behavior
- a server-side workflow from source notes to approved-Highlight artifact generation
- paired Bedrock/OpenRouter non-inferiority, authoritative usage/cost coverage,
  and outage-safe embedding rollback gates

## Notes

- GitHub import is intentionally bounded, and repository research is read-only and limited to repositories attached to the project.
- Each GitHub REST request has a deadline; independent activity reads and
  bounded detail enrichment run concurrently with deterministic output order.
- Work Item deletion fences queued/running import, refresh, chat, artifact, and
  manual-highlight workflows and cancels accepted orphans, so re-adding the
  same repository cannot inherit the deleted lineage.
- Default-branch GitHub pushes proactively start a five-second coalescing
  window before durable repository refresh; chat still resolves the live head
  and joins or supersedes that work when freshness is explicitly required.
- Exact repository excerpts are immutable provenance beneath reviewed Project Facts or Highlights, not peer sources in chat.
- Safe repository knowledge is auto-applied for private use and marked for retrospective review; sensitive or weakly supported knowledge is quarantined.
- Project chat, research, review, retrieval, and artifact generation live behind typed service interfaces in `src/services`.
- The primary answer model owns conversation interpretation, evidence/tool
  selection, answer structure, and prose. Deterministic chat boundaries are
  intentionally narrow: authorization, side-effect admission, budgets,
  idempotency, citation syntax/provenance, current-head validation, and secret
  handling. Its four project-neutral choices are `inspect_project`,
  `refresh_project_knowledge`, `inspect_prior_turn`, and
  `create_project_artifact`. `inspect_project` combines conceptual search over
  durable project knowledge with bounded read-only Git inspection of an
  authorized pinned repository, so the model can use either evidence mode or
  both without choosing between overlapping tools. The Git capability accepts
  ordinary argument vectors but exposes no shell, mutation, network, or
  arbitrary host-filesystem access.
  Narrow lookups run directly. Broad, causal, or multi-step repository
  questions delegate to one fresh bounded research context, which can adapt
  across related Git queries without copying its tool transcript into the
  answer model. Full redacted Git results are archived outside model context;
  the worker returns exact citable excerpts with immutable hashes, output-line
  ranges, and expansion handles. Research has its own call/token budget and
  cannot consume the final tool-free answer turn.
  A semantic verifier sees a compact manifest of the entire frozen evidence
  set and records a versioned internal ledger for every material claim:
  direct support, multi-source synthesis, reasonable inference,
  qualification, citation repair, focused research, or high-confidence
  removal with the missing or contradicted premise. When a central evidence
  gap can be resolved by an authorized capability, it may authorize one
  smaller evidence continuation before a frozen rewrite. A final bounded
  projection preserves supported claims and removes only ledger-rejected
  content; completed runs persist the ledger history and distinguish
  `answered` from `answered_with_gaps`. The verifier never replaces the model
  answer with a canned template, and one peripheral issue cannot suppress the
  supported remainder. If a bounded research, continuation, or repair phase
  still fails, Workbase publishes the supported evidence-backed remainder
  instead of replacing it with an operational-failure message.
- Sensitive, private-only, or visibility-incompatible Highlights are excluded from public-facing Artifact generation.
