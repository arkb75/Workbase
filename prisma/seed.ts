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

    const sampleEvidenceItems = [
      {
        id: "sample-evidence-note-1",
        workItemId: "sample-work-item",
        sourceId: "sample-note-source",
        externalId: "sample-note-source:excerpt:0",
        type: "manual_note_excerpt",
        title: "Interview prep notes excerpt 1",
        content: "Built a Next.js dashboard for lab members to search experiment records.",
        searchText:
          "Interview prep notes excerpt 1 Built a Next.js dashboard for lab members to search experiment records.",
        parentKind: "source",
        parentKey: "sample-note-source",
        included: true,
        metadata: { lineIndex: 0, sourceType: "manual_note" },
      },
      {
        id: "sample-evidence-note-2",
        workItemId: "sample-work-item",
        sourceId: "sample-note-source",
        externalId: "sample-note-source:excerpt:1",
        type: "manual_note_excerpt",
        title: "Interview prep notes excerpt 2",
        content:
          "Integrated Prisma with PostgreSQL and added role-aware filters for internal and public datasets.",
        searchText:
          "Interview prep notes excerpt 2 Integrated Prisma with PostgreSQL and added role-aware filters for internal and public datasets.",
        parentKind: "source",
        parentKey: "sample-note-source",
        included: true,
        metadata: { lineIndex: 1, sourceType: "manual_note" },
      },
      {
        id: "sample-evidence-note-3",
        workItemId: "sample-work-item",
        sourceId: "sample-note-source",
        externalId: "sample-note-source:excerpt:2",
        type: "manual_note_excerpt",
        title: "Interview prep notes excerpt 3",
        content: "Created background import scripts to normalize CSV uploads from multiple teams.",
        searchText:
          "Interview prep notes excerpt 3 Created background import scripts to normalize CSV uploads from multiple teams.",
        parentKind: "source",
        parentKey: "sample-note-source",
        included: true,
        metadata: { lineIndex: 2, sourceType: "manual_note" },
      },
      {
        id: "sample-evidence-note-4",
        workItemId: "sample-work-item",
        sourceId: "sample-note-source",
        externalId: "sample-note-source:excerpt:3",
        type: "manual_note_excerpt",
        title: "Interview prep notes excerpt 4",
        content: "Worked with two classmates and the lab coordinator to tighten wording for sensitive data.",
        searchText:
          "Interview prep notes excerpt 4 Worked with two classmates and the lab coordinator to tighten wording for sensitive data.",
        parentKind: "source",
        parentKey: "sample-note-source",
        included: false,
        metadata: { lineIndex: 3, sourceType: "manual_note" },
      },
      {
        id: "sample-evidence-readme",
        workItemId: "sample-work-item",
        sourceId: "sample-github-source",
        externalId: "readme:README.md",
        type: "github_readme",
        title: "sample-research-search README",
        content:
          "Campus research search demo with Next.js, Prisma, PostgreSQL, and CSV import workflows.",
        searchText:
          "sample-research-search README Campus research search demo with Next.js, Prisma, PostgreSQL, and CSV import workflows.",
        parentKind: "repository",
        parentKey: "sample-research-search-repo",
        included: true,
        metadata: { path: "README.md", importedAt: "2026-04-03T17:00:00.000Z" },
      },
      {
        id: "sample-evidence-commit",
        workItemId: "sample-work-item",
        sourceId: "sample-github-source",
        externalId: "commit:abc123",
        type: "github_commit",
        title: "Add import worker",
        content: "Add import worker for CSV normalization and queue retries.",
        searchText: "Add import worker Add import worker for CSV normalization and queue retries.",
        parentKind: "repository",
        parentKey: "sample-research-search-repo",
        included: true,
        metadata: {
          sha: "abc123",
          changedFiles: ["src/import-worker.ts", "src/retries.ts"],
          importedAt: "2026-04-03T17:00:00.000Z",
        },
      },
      {
        id: "sample-evidence-pr",
        workItemId: "sample-work-item",
        sourceId: "sample-github-source",
        externalId: "pull:12",
        type: "github_pull_request",
        title: "PR #12: Tighten access filters",
        content: "Clarifies internal/public dataset filtering at the query layer.",
        searchText:
          "PR #12 Tighten access filters Clarifies internal/public dataset filtering at the query layer.",
        parentKind: "repository",
        parentKey: "sample-research-search-repo",
        included: true,
        metadata: {
          number: 12,
          changedFiles: ["src/access.ts", "src/queries.ts"],
          importedAt: "2026-04-03T17:00:00.000Z",
        },
      },
    ] as const;

    for (const item of sampleEvidenceItems) {
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
            "searchText",
            "parentKind",
            "parentKey",
            "included",
            "metadata",
            "updatedAt"
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
          ON CONFLICT ("id")
          DO UPDATE SET
            "workItemId" = EXCLUDED."workItemId",
            "sourceId" = EXCLUDED."sourceId",
            "externalId" = EXCLUDED."externalId",
            "type" = EXCLUDED."type",
            "title" = EXCLUDED."title",
            "content" = EXCLUDED."content",
            "searchText" = EXCLUDED."searchText",
            "parentKind" = EXCLUDED."parentKind",
            "parentKey" = EXCLUDED."parentKey",
            "included" = EXCLUDED."included",
            "metadata" = EXCLUDED."metadata",
            "updatedAt" = NOW()
        `,
        [
          item.id,
          item.workItemId,
          item.sourceId,
          item.externalId,
          item.type,
          item.title,
          item.content,
          item.searchText,
          item.parentKind,
          item.parentKey,
          item.included,
          JSON.stringify(item.metadata),
        ],
      );
    }

    const sampleEvidenceTags = [
      { id: "sample-evidence-tag-1", evidenceItemId: "sample-evidence-note-1", dimension: "domain", tag: "full_stack", score: 0.92 },
      { id: "sample-evidence-tag-2", evidenceItemId: "sample-evidence-note-2", dimension: "domain", tag: "backend", score: 0.9 },
      { id: "sample-evidence-tag-3", evidenceItemId: "sample-evidence-note-3", dimension: "domain", tag: "data_engineering", score: 0.9 },
      { id: "sample-evidence-tag-4", evidenceItemId: "sample-evidence-note-4", dimension: "competency", tag: "communication", score: 0.78 },
      { id: "sample-evidence-tag-5", evidenceItemId: "sample-evidence-readme", dimension: "audience_fit", tag: "project_summary", score: 0.84 },
      { id: "sample-evidence-tag-6", evidenceItemId: "sample-evidence-commit", dimension: "emphasis", tag: "implementation", score: 0.88 },
      { id: "sample-evidence-tag-7", evidenceItemId: "sample-evidence-pr", dimension: "emphasis", tag: "reliability", score: 0.79 },
    ] as const;

    for (const tag of sampleEvidenceTags) {
      await client.query(
        `
          INSERT INTO "EvidenceTag" (
            "id",
            "evidenceItemId",
            "dimension",
            "tag",
            "score",
            "createdAt"
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT ("evidenceItemId", "dimension", "tag")
          DO UPDATE SET
            "id" = EXCLUDED."id",
            "evidenceItemId" = EXCLUDED."evidenceItemId",
            "dimension" = EXCLUDED."dimension",
            "tag" = EXCLUDED."tag",
            "score" = EXCLUDED."score"
        `,
        [tag.id, tag.evidenceItemId, tag.dimension, tag.tag, tag.score],
      );
    }

    const sampleHighlights = [
      {
        id: "sample-approved-claim",
        workItemId: "sample-work-item",
        text: "Built a Next.js search dashboard that helps lab members find experiment metadata faster.",
        summary:
          "Supported by the Work Item description and the manual note about the Next.js dashboard.",
        searchText:
          "Built a Next.js search dashboard that helps lab members find experiment metadata faster. Supported by the Work Item description and the manual note about the Next.js dashboard.",
        confidence: "high",
        ownershipClarity: "clear",
        sensitivityFlag: false,
        verificationStatus: "approved",
        visibility: "resume_safe",
        risksSummary: "Outcome speedup should be verified before being used publicly.",
        missingInfo: "Add the specific search workflow or dataset size if it is safe to share.",
        rejectionReason: null,
        verificationNotes:
          "Approved because the wording stays concrete and avoids unsupported metrics.",
        metadata: { legacyCategory: "full_stack", seeded: true },
      },
      {
        id: "sample-rejected-claim",
        workItemId: "sample-work-item",
        text: "Revolutionized experiment search for the entire lab.",
        summary:
          "Based on the same dashboard notes, but the phrasing overreaches beyond the evidence.",
        searchText:
          "Revolutionized experiment search for the entire lab. Based on the same dashboard notes, but the phrasing overreaches beyond the evidence.",
        confidence: "low",
        ownershipClarity: "partial",
        sensitivityFlag: false,
        verificationStatus: "rejected",
        visibility: "private",
        risksSummary: "Overstates impact and lacks evidence for the scope of change.",
        missingInfo: "Add the exact system change and your individual contribution.",
        rejectionReason:
          "Too strong. The evidence supports implementation work, not lab-wide impact.",
        verificationNotes:
          "Rejected because the wording claims lab-wide impact without supporting evidence.",
        metadata: { legacyCategory: "general", seeded: true },
      },
    ] as const;

    for (const highlight of sampleHighlights) {
      await client.query(
        `
          INSERT INTO "Claim" (
            "id",
            "workItemId",
            "text",
            "summary",
            "searchText",
            "confidence",
            "ownershipClarity",
            "sensitivityFlag",
            "verificationStatus",
            "visibility",
            "risksSummary",
            "missingInfo",
            "rejectionReason",
            "verificationNotes",
            "metadata",
            "updatedAt"
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, NOW()
          )
          ON CONFLICT ("id")
          DO UPDATE SET
            "workItemId" = EXCLUDED."workItemId",
            "text" = EXCLUDED."text",
            "summary" = EXCLUDED."summary",
            "searchText" = EXCLUDED."searchText",
            "confidence" = EXCLUDED."confidence",
            "ownershipClarity" = EXCLUDED."ownershipClarity",
            "sensitivityFlag" = EXCLUDED."sensitivityFlag",
            "verificationStatus" = EXCLUDED."verificationStatus",
            "visibility" = EXCLUDED."visibility",
            "risksSummary" = EXCLUDED."risksSummary",
            "missingInfo" = EXCLUDED."missingInfo",
            "rejectionReason" = EXCLUDED."rejectionReason",
            "verificationNotes" = EXCLUDED."verificationNotes",
            "metadata" = EXCLUDED."metadata",
            "updatedAt" = NOW()
        `,
        [
          highlight.id,
          highlight.workItemId,
          highlight.text,
          highlight.summary,
          highlight.searchText,
          highlight.confidence,
          highlight.ownershipClarity,
          highlight.sensitivityFlag,
          highlight.verificationStatus,
          highlight.visibility,
          highlight.risksSummary,
          highlight.missingInfo,
          highlight.rejectionReason,
          highlight.verificationNotes,
          JSON.stringify(highlight.metadata),
        ],
      );
    }

    const sampleHighlightEvidence = [
      {
        id: "sample-highlight-evidence-1",
        highlightId: "sample-approved-claim",
        evidenceItemId: "sample-evidence-note-1",
        relevanceScore: 0.96,
      },
      {
        id: "sample-highlight-evidence-2",
        highlightId: "sample-approved-claim",
        evidenceItemId: "sample-evidence-readme",
        relevanceScore: 0.82,
      },
      {
        id: "sample-highlight-evidence-3",
        highlightId: "sample-rejected-claim",
        evidenceItemId: "sample-evidence-note-1",
        relevanceScore: 0.88,
      },
    ] as const;

    for (const link of sampleHighlightEvidence) {
      await client.query(
        `
          INSERT INTO "HighlightEvidence" (
            "id",
            "highlightId",
            "evidenceItemId",
            "relevanceScore",
            "createdAt"
          )
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT ("highlightId", "evidenceItemId")
          DO UPDATE SET
            "id" = EXCLUDED."id",
            "highlightId" = EXCLUDED."highlightId",
            "evidenceItemId" = EXCLUDED."evidenceItemId",
            "relevanceScore" = EXCLUDED."relevanceScore"
        `,
        [link.id, link.highlightId, link.evidenceItemId, link.relevanceScore],
      );
    }

    const sampleHighlightTags = [
      {
        id: "sample-highlight-tag-1",
        highlightId: "sample-approved-claim",
        dimension: "domain",
        tag: "full_stack",
        score: 0.94,
      },
      {
        id: "sample-highlight-tag-2",
        highlightId: "sample-approved-claim",
        dimension: "audience_fit",
        tag: "resume_safe",
        score: 0.92,
      },
      {
        id: "sample-highlight-tag-3",
        highlightId: "sample-rejected-claim",
        dimension: "domain",
        tag: "general",
        score: 0.6,
      },
    ] as const;

    for (const tag of sampleHighlightTags) {
      await client.query(
        `
          INSERT INTO "HighlightTag" (
            "id",
            "highlightId",
            "dimension",
            "tag",
            "score",
            "createdAt"
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT ("highlightId", "dimension", "tag")
          DO UPDATE SET
            "id" = EXCLUDED."id",
            "highlightId" = EXCLUDED."highlightId",
            "dimension" = EXCLUDED."dimension",
            "tag" = EXCLUDED."tag",
            "score" = EXCLUDED."score"
        `,
        [tag.id, tag.highlightId, tag.dimension, tag.tag, tag.score],
      );
    }

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
