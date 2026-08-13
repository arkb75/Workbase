import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { prisma } from "@/src/lib/prisma";
import { lockKnowledgeWorkItemMutation } from "@/src/services/knowledge-mutation-lock-service";

const runLiveDatabaseLockTest =
  process.env.WORKBASE_RUN_LIVE_DATABASE_LOCK_TEST === "1" &&
  Boolean(process.env.DATABASE_URL);

describe.skipIf(!runLiveDatabaseLockTest)(
  "knowledge mutation/deletion lock order (live database)",
  () => {
    it("serializes a repository-style child mutation before deletion without deadlock or orphan rows", async () => {
      const suffix = randomUUID();
      const userId = `lock-user-${suffix}`;
      const workItemId = `lock-work-${suffix}`;
      const sourceId = `lock-source-${suffix}`;
      const deletionClient = new Client({
        connectionString: process.env.DATABASE_URL,
      });
      let releaseMutation = () => undefined;
      let mutationReleased = false;

      await prisma.user.create({
        data: {
          id: userId,
          email: `lock-order-${suffix}@workbase.invalid`,
          name: "Lock order regression",
          workItems: {
            create: {
              id: workItemId,
              title: "Lock order regression",
              type: "project",
              description: "Disposable two-connection concurrency fixture.",
              sources: {
                create: {
                  id: sourceId,
                  type: "github_repo",
                  label: "workbase/lock-order-regression",
                  externalId: suffix,
                },
              },
            },
          },
        },
      });
      await deletionClient.connect();

      try {
        let signalMutationLocked!: () => void;
        const mutationLocked = new Promise<void>((resolve) => {
          signalMutationLocked = resolve;
        });
        const holdMutation = new Promise<void>((resolve) => {
          releaseMutation = () => {
            mutationReleased = true;
            resolve();
          };
        });

        const mutation = prisma.$transaction(async (tx) => {
          await lockKnowledgeWorkItemMutation(tx, workItemId);
          await tx.$queryRaw`
            SELECT "id" FROM "Source" WHERE "id" = ${sourceId} FOR UPDATE
          `;
          await tx.source.update({
            where: { id: sourceId },
            data: { label: "workbase/lock-order-mutated" },
          });
          signalMutationLocked();
          await holdMutation;
        }, { timeout: 10_000 });
        await mutationLocked;

        let deletionAcquiredParent = false;
        const deletion = (async () => {
          await deletionClient.query("BEGIN");
          await deletionClient.query("SET LOCAL lock_timeout = '5s'");
          await deletionClient.query(
            'SELECT "id" FROM "WorkItem" WHERE "id" = $1 FOR UPDATE',
            [workItemId],
          );
          deletionAcquiredParent = true;
          await deletionClient.query(
            'SELECT "id" FROM "Source" WHERE "workItemId" = $1 FOR UPDATE',
            [workItemId],
          );
          await deletionClient.query(
            'DELETE FROM "WorkItem" WHERE "id" = $1',
            [workItemId],
          );
          await deletionClient.query("COMMIT");
        })();

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(deletionAcquiredParent).toBe(false);

        releaseMutation();
        await Promise.all([mutation, deletion]);

        expect(deletionAcquiredParent).toBe(true);
        await expect(prisma.workItem.count({ where: { id: workItemId } }))
          .resolves.toBe(0);
        await expect(prisma.source.count({ where: { id: sourceId } }))
          .resolves.toBe(0);
      } finally {
        if (!mutationReleased) releaseMutation();
        await deletionClient.query("ROLLBACK").catch(() => undefined);
        await deletionClient.end().catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }, 15_000);
  },
);
