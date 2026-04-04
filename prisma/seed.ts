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
          "rawContent",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "type" = EXCLUDED."type",
          "label" = EXCLUDED."label",
          "rawContent" = EXCLUDED."rawContent",
          "updatedAt" = NOW()
      `,
      [
        "sample-note-source",
        "sample-work-item",
        "manual_note",
        "Interview prep notes",
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
          "metadata",
          "updatedAt"
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
        ON CONFLICT ("id")
        DO UPDATE SET
          "workItemId" = EXCLUDED."workItemId",
          "type" = EXCLUDED."type",
          "label" = EXCLUDED."label",
          "metadata" = EXCLUDED."metadata",
          "updatedAt" = NOW()
      `,
      [
        "sample-github-source",
        "sample-work-item",
        "github_repo",
        "GitHub repo placeholder",
        JSON.stringify({
          repoUrl: "https://github.com/workbase/sample-research-search",
          status: "placeholder",
        }),
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
