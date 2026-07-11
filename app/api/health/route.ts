import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/prisma";

export async function GET() {
  try {
    const [schema] = await prisma.$queryRaw<Array<{
      projectFactsReady: boolean;
      agentHarnessReady: boolean;
    }>>`
      SELECT
        to_regclass('public."ProjectFact"') IS NOT NULL AS "projectFactsReady",
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'AgentRun'
            AND column_name = 'harnessVersion'
            AND column_default LIKE '%v3%'
        ) AS "agentHarnessReady"
    `;
    if (!schema?.projectFactsReady || !schema.agentHarnessReady) {
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
      schema: "agent-harness-v3",
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
