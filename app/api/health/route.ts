import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function GET() {
  try {
    const [schema] = await prisma.$queryRaw<Array<{
      projectFactsReady: boolean;
      agentHarnessReady: boolean;
      repositoryKnowledgeReady: boolean;
    }>>`
      SELECT
        to_regclass('public."ProjectFact"') IS NOT NULL AS "projectFactsReady",
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'AgentRun'
            AND column_name = 'harnessVersion'
            AND column_default LIKE '%v4%'
        ) AS "agentHarnessReady",
        to_regclass('public."KnowledgeRefreshRun"') IS NOT NULL
          AND to_regclass('public."RepositorySnapshot"') IS NOT NULL
          AND to_regclass('public."KnowledgeChange"') IS NOT NULL AS "repositoryKnowledgeReady"
    `;
    if (!schema?.projectFactsReady || !schema.agentHarnessReady || !schema.repositoryKnowledgeReady) {
      return NextResponse.json(
        {
          status: "not_ready",
          product: "Workbase",
          reason: "database_schema_out_of_date",
          recovery: "Run npm run db:prepare and restart the application.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({
      status: "ok",
      product: "Workbase",
      database: "ready",
      schema: "repository-knowledge-v4",
    });
  } catch {
    return NextResponse.json(
      {
        status: "not_ready",
        product: "Workbase",
        reason: "database_unavailable",
      },
      { status: 503 },
    );
  }
}
