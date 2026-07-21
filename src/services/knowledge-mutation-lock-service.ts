import type { Prisma } from "@/src/generated/prisma/client";

/**
 * Serializes every repository- and user-owned mutation of durable knowledge for
 * one Work Item. Repository refreshes already use this lock; review decisions
 * must share it so a decision cannot race a refresh that selected an older
 * version of the same row.
 */
export async function lockKnowledgeWorkItemMutation(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  workItemId: string,
) {
  await client.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(
      hashtextextended(${"workbase:knowledge-refresh:" + workItemId}, 0)
    )
  `;
}
