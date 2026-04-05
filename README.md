# Workbase

Workbase is an internal MVP for early-career CS students and engineers who want to turn real technical work into verified career content.

The prototype is built around one hard rule: Artifacts are generated from approved Claims only. Raw notes and source inputs never go straight into output generation.

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
4. Review included Evidence and cluster it into work themes
5. Generate candidate Claims with Evidence
6. Review, edit, approve, reject, or mark Claims as Sensitive
7. Generate resume bullets, a LinkedIn-style entry, or a short project summary from approved Claims only

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

5. Generate the Prisma client

```bash
npm run prisma:generate
```

6. Apply the schema to your database

```bash
npx prisma migrate deploy
```

7. Seed the demo workspace

```bash
npm run db:seed
```

8. Start the app

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
- `/api/health`

## Testing focus

The test suite covers:

- claim status transitions
- GitHub connection encryption and OAuth exchange handling
- bounded GitHub repo import behavior
- evidence persistence refresh/dedupe behavior
- artifact eligibility constraints
- claim regeneration behavior
- a server-side workflow from source notes to approved-claim artifact generation

## Notes

- GitHub import is intentionally bounded: README, recent commits, PRs, issues, releases, and changed file paths only.
- Included evidence items are the source of truth for clustering and future claim generation.
- Claim research, verification, and artifact generation live behind typed service interfaces in `src/services`.
- Sensitive or private claims are excluded from public-facing Artifact generation.
