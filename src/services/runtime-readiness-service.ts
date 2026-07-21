import { Prisma } from "@/src/generated/prisma/client";
import { classifyWorkflowFailure } from "@/src/lib/error-message";
import { prisma } from "@/src/lib/prisma";

export type ApplicationReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "runtime_schema_mismatch" | "database_schema_out_of_date" | "database_unavailable";
      message: string;
      recovery: string;
      retryable: boolean;
    };

type ReadinessClient = {
  projectFact: {
    findFirst(input: {
      select: {
        id: true;
        productImportance: true;
        implementationBreadth: true;
        technicalDifficulty: true;
        distinctiveness: true;
      };
    }): Promise<unknown>;
  };
  $queryRaw<T>(query: unknown): Promise<T>;
};

export async function checkApplicationReadiness(client: ReadinessClient = prisma): Promise<ApplicationReadiness> {
  try {
    // This validates both the loaded Prisma runtime contract and the physical
    // ranking columns. A broad table-existence check cannot detect a stale HMR
    // singleton, which is the failure mode this guard is designed to catch.
    const [, [schema]] = await Promise.all([
      client.projectFact.findFirst({
        select: {
          id: true,
          productImportance: true,
          implementationBreadth: true,
          technicalDifficulty: true,
          distinctiveness: true,
        },
      }),
      client.$queryRaw<Array<{
        agentHarnessReady: boolean;
        repositoryKnowledgeReady: boolean;
      }>>(Prisma.sql`
      SELECT
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
      `),
    ]);
    if (!schema?.agentHarnessReady || !schema.repositoryKnowledgeReady) {
      return {
        ready: false,
        reason: "database_schema_out_of_date",
        message: "Workbase's database migrations are not current.",
        recovery: "Run npm run db:prepare, restart the application, and retry.",
        retryable: false,
      };
    }
    return { ready: true };
  } catch (error) {
    const failure = classifyWorkflowFailure(error);
    if (failure.code === "runtime_schema_mismatch") {
      return {
        ready: false,
        reason: "runtime_schema_mismatch",
        message: failure.message,
        recovery: failure.recovery!,
        retryable: false,
      };
    }
    return {
      ready: false,
      reason: "database_unavailable",
      message: "Workbase could not verify database readiness.",
      recovery: "Check the database connection and retry.",
      retryable: true,
    };
  }
}

export const runtimeReadinessService = { check: checkApplicationReadiness };
