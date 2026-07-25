import { Prisma } from "@/src/generated/prisma/client";
import { classifyWorkflowFailure } from "@/src/lib/error-message";
import { prisma } from "@/src/lib/prisma";

export type ApplicationReadiness =
  | { ready: true }
  | {
      ready: false;
      reason:
        | "runtime_schema_mismatch"
        | "database_schema_out_of_date"
        | "runtime_configuration_missing"
        | "database_unavailable";
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
        embeddingIndexReady: boolean;
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
          AND to_regclass('public."KnowledgeChange"') IS NOT NULL
          AND to_regclass('public."GitHubWebhookDelivery"') IS NOT NULL AS "repositoryKnowledgeReady",
        to_regclass('public."EmbeddingIndexVersion"') IS NOT NULL
          AND to_regclass('public."EmbeddingIndexControl"') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'HighlightEmbedding'
              AND column_name = 'indexVersionId'
          ) AS "embeddingIndexReady"
      `),
    ]);
    if (
      !schema?.agentHarnessReady ||
      !schema.repositoryKnowledgeReady ||
      !schema.embeddingIndexReady
    ) {
      return {
        ready: false,
        reason: "database_schema_out_of_date",
        message: "Workbase's database migrations are not current.",
        recovery: "Run npm run db:prepare, restart the application, and retry.",
        retryable: false,
      };
    }
    const runtimeIndexes = await client.$queryRaw<Array<{
      provider: string;
      status: string;
      dimensions: number;
      isActive: boolean;
    }>>(Prisma.sql`
      SELECT
        version."provider",
        version."status"::text AS "status",
        version."dimensions",
        (version."id" = control."activeVersionId") AS "isActive"
      FROM "EmbeddingIndexControl" AS control
      INNER JOIN "EmbeddingIndexVersion" AS version ON
        version."id" = control."activeVersionId"
        OR (
          version."writeEnabled" = true
          AND version."status" IN ('building', 'ready')
        )
      WHERE control."id" = 'default'
    `);
    const activeIndex = runtimeIndexes.find((index) => index.isActive);
    if (activeIndex?.status !== "active" || Number(activeIndex.dimensions) !== 512) {
      return {
        ready: false,
        reason: "database_schema_out_of_date",
        message: "Workbase's active embedding index is not initialized.",
        recovery: "Run npm run db:prepare, restore the active embedding index, and retry.",
        retryable: false,
      };
    }
    const missingCredentialProvider = runtimeIndexes.find(
      (index) =>
        index.provider === "openrouter" &&
        !process.env.OPENROUTER_API_KEY?.trim(),
    )?.provider;
    if (missingCredentialProvider) {
      return {
        ready: false,
        reason: "runtime_configuration_missing",
        message:
          "A write-enabled OpenRouter embedding index has no API credential.",
        recovery: "Set OPENROUTER_API_KEY, restart the application, and retry.",
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
