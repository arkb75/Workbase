# Workbase

Workbase is an internal MVP for early-career CS students and engineers who want to turn real technical work into verified career content.

The prototype is built around one hard rule: public Artifacts are generated from approved, visibility-compatible Highlights only. Raw notes and repository files never go straight into public output generation.

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Prisma 7 with Neon/PostgreSQL
- Bedrock-backed structured generation for claim research, verification, artifact drafting, and evidence clustering
- GitHub OAuth App integration with bounded REST ingestion
- Vitest for domain tests

## Product loop

1. Complete onboarding for the demo user
2. Create a Work Item
3. Attach manual notes and import a real GitHub repository
4. Refresh commit-pinned repository knowledge and cluster Evidence into work themes
5. Auto-apply supported, non-sensitive Project Facts and Highlights as private project memory
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
4. Add the GitHub OAuth App and encryption settings from `.env.example`

For proactive production refreshes, also set:

- `WORKBASE_GITHUB_WEBHOOK_URL` to the public HTTPS
  `/api/github/webhook` endpoint.
- `GITHUB_WEBHOOK_SECRET` to a random value of at least 32 characters.

Workbase registers a push-only repository webhook when an attached repository
is administered by the connected GitHub user. Repositories without webhook
administration permission continue to use the scheduled freshness scan.

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
```

## Included routes

- `/onboarding`
- `/dashboard`
- `/work-items/new`
- `/work-items/[id]`
- `/work-items/[id]/claims`
- `/work-items/[id]/artifacts/new`
- `/api/github/connect`
- `/api/github/callback`
- `/api/github/webhook`
- `/api/health`

## Testing focus

The test suite covers:

- claim status transitions
- GitHub connection encryption and OAuth exchange handling
- bounded GitHub repo import behavior
- signed GitHub push delivery validation, redelivery deduplication, and
  proactive refresh coalescing
- evidence persistence refresh/dedupe behavior
- artifact eligibility constraints
- claim regeneration behavior
- multi-turn project chat, citation grounding, retrieval, and prior-turn provenance
- commit-pinned repository refresh, semantic orchestration, reconciliation, and staleness
- durable chat and artifact workflows, including review/resume behavior
- a server-side workflow from source notes to approved-Highlight artifact generation

## Notes

- GitHub import is intentionally bounded, and repository research is read-only and limited to repositories attached to the project.
- Default-branch GitHub pushes proactively start a five-second coalescing
  window before durable repository refresh; chat still resolves the live head
  and joins or supersedes that work when freshness is explicitly required.
- Exact repository excerpts are immutable provenance beneath reviewed Project Facts or Highlights, not peer sources in chat.
- Safe repository knowledge is auto-applied for private use and marked for retrospective review; sensitive or weakly supported knowledge is quarantined.
- Project chat, research, review, retrieval, and artifact generation live behind typed service interfaces in `src/services`.
- Sensitive, private-only, or visibility-incompatible Highlights are excluded from public-facing Artifact generation.
