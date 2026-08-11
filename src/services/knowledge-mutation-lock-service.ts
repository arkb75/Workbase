import type { Prisma } from "@/src/generated/prisma/client";

/**
 * Serializes every repository- and user-owned mutation of durable knowledge for
 * one Work Item. The parent row must always be acquired before the advisory
 * lock or any child-row lock. Work Item deletion uses that same parent-first
 * order, so a refresh, review, chat candidate, or manual-evidence workflow
 * cannot form a parent/child lock cycle with the deletion cascade.
 *
 * The parent can be absent after a concurrent deletion commits. We still take
 * the advisory lock so callers retain their knowledge-writer serialization;
 * their fenced child re-read or foreign key then makes the deletion terminal.
 */
export async function lockKnowledgeWorkItemMutation(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  workItemId: string,
) {
  await client.$queryRaw`
    WITH "lockedWorkItem" AS MATERIALIZED (
      SELECT "id"
      FROM "WorkItem"
      WHERE "id" = ${workItemId}
      FOR UPDATE
    )
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(
      hashtextextended(
        'workbase:knowledge-refresh:' ||
          COALESCE((SELECT "id" FROM "lockedWorkItem"), ${workItemId}),
        0
      )
    )
  `;
}
