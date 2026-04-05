import "dotenv/config";

import { Client } from "pg";

const connectionString =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  "postgresql://demo:demo@127.0.0.1:5432/workbase";

async function main() {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query("BEGIN");

    const demoUserResult = await client.query<{
      id: string;
    }>(
      `
        INSERT INTO "User" (
          "id",
          "email",
          "name",
          "careerStage",
          "currentGoal",
          "focusPreference",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT ("email")
        DO UPDATE SET
          "name" = EXCLUDED."name",
          "careerStage" = EXCLUDED."careerStage",
          "currentGoal" = EXCLUDED."currentGoal",
          "focusPreference" = EXCLUDED."focusPreference",
          "updatedAt" = NOW()
        RETURNING "id"
      `,
      [
        "sample-demo-user",
        process.env.WORKBASE_DEMO_USER_EMAIL ?? "demo@workbase.app",
        process.env.WORKBASE_DEMO_USER_NAME ?? "Workbase Demo User",
        "new_grad",
        "Turn recent projects into credible, recruiter-ready experience.",
        "both",
      ],
    );
    const demoUserId = demoUserResult.rows[0].id;

    await client.query(
      `
        INSERT INTO "WorkItem" (
          "id",
          "userId",
          "title",
          "type",
          "description",
          "startDate",
          "endDate",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "userId" = EXCLUDED."userId",
          "title" = EXCLUDED."title",
          "type" = EXCLUDED."type",
          "description" = EXCLUDED."description",
          "startDate" = EXCLUDED."startDate",
          "endDate" = EXCLUDED."endDate",
          "updatedAt" = NOW()
      `,
      [
        "sample-work-item",
        demoUserId,
        "Campus research search platform",
        "project",
        "Built a full-stack search tool that helps lab members find experiment metadata and annotate results.",
        new Date("2025-01-15"),
        new Date("2025-03-28"),
      ],
    );

    await client.query(
      `
        INSERT INTO "Source" (
          "id",
          "workItemId",
          "type",
          "label",
          "externalId",
          "rawContent",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "type" = EXCLUDED."type",
          "label" = EXCLUDED."label",
          "externalId" = EXCLUDED."externalId",
          "rawContent" = EXCLUDED."rawContent",
          "updatedAt" = NOW()
      `,
      [
        "sample-note-source",
        "sample-work-item",
        "manual_note",
        "Interview prep notes",
        null,
        `Built a Next.js dashboard for lab members to search experiment records.
Integrated Prisma with PostgreSQL and added role-aware filters for internal and public datasets.
Created background import scripts to normalize CSV uploads from multiple teams.
Worked with two classmates and the lab coordinator to tighten wording for sensitive data.`,
      ],
    );

    await client.query(
      `
        INSERT INTO "Source" (
          "id",
          "workItemId",
          "type",
          "label",
          "externalId",
          "metadata",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "type" = EXCLUDED."type",
          "label" = EXCLUDED."label",
          "externalId" = EXCLUDED."externalId",
          "metadata" = EXCLUDED."metadata",
          "updatedAt" = NOW()
      `,
      [
        "sample-github-source",
        "sample-work-item",
        "github_repo",
        "workbase/sample-research-search",
        "sample-research-search-repo",
        JSON.stringify({
          repository: {
            id: "sample-research-search-repo",
            fullName: "workbase/sample-research-search",
            owner: "workbase",
            name: "sample-research-search",
            description: "Campus research search demo repository",
            url: "https://github.com/workbase/sample-research-search",
            defaultBranch: "main",
            private: false,
            updatedAt: "2026-04-03T17:00:00.000Z",
          },
          importedAt: "2026-04-03T17:00:00.000Z",
          counts: {
            github_readme: 1,
            github_commit: 2,
            github_pull_request: 1,
            github_issue: 1,
            github_release: 1,
          },
          status: "imported",
        }),
      ],
    );

    await client.query(
      `
        INSERT INTO "EvidenceItem" (
          "id",
          "workItemId",
          "sourceId",
          "externalId",
          "type",
          "title",
          "content",
          "included",
          "metadata",
          "updatedAt"
        )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW()),
          ($10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW()),
          ($19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb, NOW()),
          ($28, $29, $30, $31, $32, $33, $34, $35, $36::jsonb, NOW()),
          ($37, $38, $39, $40, $41, $42, $43, $44, $45::jsonb, NOW()),
          ($46, $47, $48, $49, $50, $51, $52, $53, $54::jsonb, NOW()),
          ($55, $56, $57, $58, $59, $60, $61, $62, $63::jsonb, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "sourceId" = EXCLUDED."sourceId",
          "externalId" = EXCLUDED."externalId",
          "type" = EXCLUDED."type",
          "title" = EXCLUDED."title",
          "content" = EXCLUDED."content",
          "included" = EXCLUDED."included",
          "metadata" = EXCLUDED."metadata",
          "updatedAt" = NOW()
      `,
      [
        "sample-evidence-note-1",
        "sample-work-item",
        "sample-note-source",
        "sample-note-source:excerpt:0",
        "manual_note_excerpt",
        "Interview prep notes excerpt 1",
        "Built a Next.js dashboard for lab members to search experiment records.",
        true,
        JSON.stringify({ lineIndex: 0, sourceType: "manual_note" }),
        "sample-evidence-note-2",
        "sample-work-item",
        "sample-note-source",
        "sample-note-source:excerpt:1",
        "manual_note_excerpt",
        "Interview prep notes excerpt 2",
        "Integrated Prisma with PostgreSQL and added role-aware filters for internal and public datasets.",
        true,
        JSON.stringify({ lineIndex: 1, sourceType: "manual_note" }),
        "sample-evidence-note-3",
        "sample-work-item",
        "sample-note-source",
        "sample-note-source:excerpt:2",
        "manual_note_excerpt",
        "Interview prep notes excerpt 3",
        "Created background import scripts to normalize CSV uploads from multiple teams.",
        true,
        JSON.stringify({ lineIndex: 2, sourceType: "manual_note" }),
        "sample-evidence-note-4",
        "sample-work-item",
        "sample-note-source",
        "sample-note-source:excerpt:3",
        "manual_note_excerpt",
        "Interview prep notes excerpt 4",
        "Worked with two classmates and the lab coordinator to tighten wording for sensitive data.",
        false,
        JSON.stringify({ lineIndex: 3, sourceType: "manual_note" }),
        "sample-evidence-readme",
        "sample-work-item",
        "sample-github-source",
        "readme:README.md",
        "github_readme",
        "sample-research-search README",
        "Campus research search demo with Next.js, Prisma, PostgreSQL, and CSV import workflows.",
        true,
        JSON.stringify({ path: "README.md", importedAt: "2026-04-03T17:00:00.000Z" }),
        "sample-evidence-commit",
        "sample-work-item",
        "sample-github-source",
        "commit:abc123",
        "github_commit",
        "Add import worker",
        "Add import worker for CSV normalization and queue retries.",
        true,
        JSON.stringify({
          sha: "abc123",
          changedFiles: ["src/import-worker.ts", "src/retries.ts"],
          importedAt: "2026-04-03T17:00:00.000Z",
        }),
        "sample-evidence-pr",
        "sample-work-item",
        "sample-github-source",
        "pull:12",
        "github_pull_request",
        "PR #12: Tighten access filters",
        "Clarifies internal/public dataset filtering at the query layer.",
        true,
        JSON.stringify({
          number: 12,
          changedFiles: ["src/access.ts", "src/queries.ts"],
          importedAt: "2026-04-03T17:00:00.000Z",
        }),
      ],
    );

    await client.query(
      `
        INSERT INTO "EvidenceCluster" (
          "id",
          "workItemId",
          "title",
          "summary",
          "theme",
          "confidence",
          "metadata",
          "updatedAt"
        )
        VALUES
          ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW()),
          ($8, $9, $10, $11, $12, $13, $14::jsonb, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "title" = EXCLUDED."title",
          "summary" = EXCLUDED."summary",
          "theme" = EXCLUDED."theme",
          "confidence" = EXCLUDED."confidence",
          "metadata" = EXCLUDED."metadata",
          "updatedAt" = NOW()
      `,
      [
        "sample-cluster-platform",
        "sample-work-item",
        "Search dashboard and platform surface",
        "UI and repo evidence both point to dashboard and search work for lab metadata.",
        "full_stack",
        "high",
        JSON.stringify({ strategy: "seed_demo" }),
        "sample-cluster-data",
        "sample-work-item",
        "Data pipeline and access control",
        "Database integration, import scripts, and access filters cluster around data handling work.",
        "backend",
        "medium",
        JSON.stringify({ strategy: "seed_demo" }),
      ],
    );

    await client.query(
      `
        INSERT INTO "EvidenceClusterItem" (
          "id",
          "clusterId",
          "evidenceItemId",
          "relevanceScore",
          "createdAt"
        )
        VALUES
          ($1, $2, $3, $4, NOW()),
          ($5, $6, $7, $8, NOW()),
          ($9, $10, $11, $12, NOW()),
          ($13, $14, $15, $16, NOW()),
          ($17, $18, $19, $20, NOW()),
          ($21, $22, $23, $24, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "clusterId" = EXCLUDED."clusterId",
          "evidenceItemId" = EXCLUDED."evidenceItemId",
          "relevanceScore" = EXCLUDED."relevanceScore"
      `,
      [
        "sample-cluster-item-1",
        "sample-cluster-platform",
        "sample-evidence-note-1",
        0.96,
        "sample-cluster-item-2",
        "sample-cluster-platform",
        "sample-evidence-readme",
        0.82,
        "sample-cluster-item-3",
        "sample-cluster-platform",
        "sample-evidence-pr",
        0.78,
        "sample-cluster-item-4",
        "sample-cluster-data",
        "sample-evidence-note-2",
        0.92,
        "sample-cluster-item-5",
        "sample-cluster-data",
        "sample-evidence-note-3",
        0.89,
        "sample-cluster-item-6",
        "sample-cluster-data",
        "sample-evidence-commit",
        0.86,
      ],
    );

    await client.query(
      `
        INSERT INTO "Claim" (
          "id",
          "workItemId",
          "text",
          "category",
          "confidence",
          "ownershipClarity",
          "sensitivityFlag",
          "verificationStatus",
          "visibility",
          "risksSummary",
          "missingInfo",
          "rejectionReason",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "text" = EXCLUDED."text",
          "category" = EXCLUDED."category",
          "confidence" = EXCLUDED."confidence",
          "ownershipClarity" = EXCLUDED."ownershipClarity",
          "sensitivityFlag" = EXCLUDED."sensitivityFlag",
          "verificationStatus" = EXCLUDED."verificationStatus",
          "visibility" = EXCLUDED."visibility",
          "risksSummary" = EXCLUDED."risksSummary",
          "missingInfo" = EXCLUDED."missingInfo",
          "rejectionReason" = EXCLUDED."rejectionReason",
          "updatedAt" = NOW()
      `,
      [
        "sample-approved-claim",
        "sample-work-item",
        "Built a Next.js search dashboard that helps lab members find experiment metadata faster.",
        "full_stack",
        "high",
        "clear",
        false,
        "approved",
        "resume_safe",
        "Outcome speedup should be verified before being used publicly.",
        "Add the specific search workflow or dataset size if it is safe to share.",
        null,
      ],
    );

    await client.query(
      `
        INSERT INTO "EvidenceCard" (
          "id",
          "claimId",
          "evidenceSummary",
          "rationaleSummary",
          "sourceRefs",
          "verificationNotes",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
        ON CONFLICT ("claimId")
        DO UPDATE SET
          "evidenceSummary" = EXCLUDED."evidenceSummary",
          "rationaleSummary" = EXCLUDED."rationaleSummary",
          "sourceRefs" = EXCLUDED."sourceRefs",
          "verificationNotes" = EXCLUDED."verificationNotes",
          "updatedAt" = NOW()
      `,
      [
        "sample-approved-evidence-card",
        "sample-approved-claim",
        "Supported by the Work Item description and the manual note about the Next.js dashboard.",
        "The wording stays within implementation scope and is backed by the attached notes.",
        JSON.stringify([
          {
            sourceId: "sample-note-source",
            sourceLabel: "Interview prep notes",
            sourceType: "manual_note",
            excerpt:
              "Built a Next.js dashboard for lab members to search experiment records.",
          },
        ]),
        "Approved because the wording stays concrete and avoids unsupported metrics.",
      ],
    );

    await client.query(
      `
        INSERT INTO "Claim" (
          "id",
          "workItemId",
          "text",
          "category",
          "confidence",
          "ownershipClarity",
          "sensitivityFlag",
          "verificationStatus",
          "visibility",
          "risksSummary",
          "missingInfo",
          "rejectionReason",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "text" = EXCLUDED."text",
          "category" = EXCLUDED."category",
          "confidence" = EXCLUDED."confidence",
          "ownershipClarity" = EXCLUDED."ownershipClarity",
          "sensitivityFlag" = EXCLUDED."sensitivityFlag",
          "verificationStatus" = EXCLUDED."verificationStatus",
          "visibility" = EXCLUDED."visibility",
          "risksSummary" = EXCLUDED."risksSummary",
          "missingInfo" = EXCLUDED."missingInfo",
          "rejectionReason" = EXCLUDED."rejectionReason",
          "updatedAt" = NOW()
      `,
      [
        "sample-rejected-claim",
        "sample-work-item",
        "Revolutionized experiment search for the entire lab.",
        "general",
        "low",
        "partial",
        false,
        "rejected",
        "private",
        "Overstates impact and lacks evidence for the scope of change.",
        "Add the exact system change and your individual contribution.",
        "Too strong. The evidence supports implementation work, not lab-wide impact.",
      ],
    );

    await client.query(
      `
        INSERT INTO "EvidenceCard" (
          "id",
          "claimId",
          "evidenceSummary",
          "rationaleSummary",
          "sourceRefs",
          "verificationNotes",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
        ON CONFLICT ("claimId")
        DO UPDATE SET
          "evidenceSummary" = EXCLUDED."evidenceSummary",
          "rationaleSummary" = EXCLUDED."rationaleSummary",
          "sourceRefs" = EXCLUDED."sourceRefs",
          "verificationNotes" = EXCLUDED."verificationNotes",
          "updatedAt" = NOW()
      `,
      [
        "sample-rejected-evidence-card",
        "sample-rejected-claim",
        "Based on the same dashboard notes, but the phrasing overreaches beyond the evidence.",
        "The claim describes impact that is not directly supported by the available sources.",
        JSON.stringify([
          {
            sourceId: "sample-note-source",
            sourceLabel: "Interview prep notes",
            sourceType: "manual_note",
            excerpt:
              "Built a Next.js dashboard for lab members to search experiment records.",
          },
        ]),
        "Rejected because the wording claims lab-wide impact without supporting evidence.",
      ],
    );

    await client.query(
      `
        INSERT INTO "Artifact" (
          "id",
          "userId",
          "workItemId",
          "type",
          "targetAngle",
          "tone",
          "content",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "userId" = EXCLUDED."userId",
          "workItemId" = EXCLUDED."workItemId",
          "type" = EXCLUDED."type",
          "targetAngle" = EXCLUDED."targetAngle",
          "tone" = EXCLUDED."tone",
          "content" = EXCLUDED."content",
          "updatedAt" = NOW()
      `,
      [
        "sample-artifact",
        demoUserId,
        "sample-work-item",
        "resume_bullets",
        "full_stack",
        "concise",
        "- Built a Next.js search dashboard that helps lab members find experiment metadata faster.",
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
