# Workbase

Workbase is an internal MVP for early-career CS students and engineers who want to turn real technical work into verified career content.

The prototype is built around one hard rule: Artifacts are generated from approved Claims only. Raw notes and source inputs never go straight into output generation.

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Prisma 7 with Neon/PostgreSQL
- Deterministic mock services for claim research, verification, and artifact generation
- Vitest for domain tests

## Product loop

1. Complete onboarding for the demo user
2. Create a Work Item
3. Attach manual notes and optional GitHub repo placeholders
4. Generate candidate Claims with Evidence
5. Review, edit, approve, reject, or mark Claims as Sensitive
6. Generate resume bullets, a LinkedIn-style entry, or a short project summary from approved Claims only

## Local setup

1. Install dependencies

```bash
npm install
```

2. Create a local env file from the example

```bash
cp .env.example .env
```

3. Set `DATABASE_URL` to your Neon Postgres connection string in `.env`

4. Generate the Prisma client

```bash
npm run prisma:generate
```

5. Apply the schema to your database

```bash
npx prisma migrate dev --name init
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
```

## Included routes

- `/onboarding`
- `/dashboard`
- `/work-items/new`
- `/work-items/[id]`
- `/work-items/[id]/claims`
- `/work-items/[id]/artifacts/new`
- `/api/health`

## Testing focus

The test suite covers:

- claim status transitions
- artifact eligibility constraints
- claim regeneration behavior
- a server-side workflow from source notes to approved-claim artifact generation

## Notes

- GitHub support is intentionally limited to a stored repo URL placeholder in v1.
- Claim research, verification, and artifact generation live behind typed service interfaces in `src/services`.
- Sensitive or private claims are excluded from public-facing Artifact generation.
