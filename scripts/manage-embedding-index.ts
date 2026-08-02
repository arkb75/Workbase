import { readFile } from "node:fs/promises";
import {
  resolveConfiguredEmbeddingCandidate,
  resolveConfiguredEmbeddingChallenger,
} from "@/src/lib/embedding-config";
import { prisma } from "@/src/lib/prisma";
import {
  activateEmbeddingIndex,
  assertEmbeddingQualityValidationFence,
  backfillEmbeddingIndex,
  disableEmbeddingIndexWrites,
  listEmbeddingIndexes,
  recordEmbeddingQualityGate,
  reconcileEmbeddingIndex,
  registerEmbeddingIndexCandidate,
} from "@/src/services/embedding-index-service";

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string) {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function positiveNumberOption(name: string) {
  const raw = option(name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return value;
}

function json(value: unknown) {
  return JSON.stringify(
    value,
    (_, entry) => typeof entry === "bigint" ? Number(entry) : entry,
    2,
  );
}

function usage() {
  return `
Usage:
  npm run db:embedding-index -- list
  npm run db:embedding-index -- register [--provider openrouter] [--model openai/text-embedding-3-small] [--key KEY] [--challenger]
  npm run db:embedding-index -- backfill --key KEY [--batch-size 100] [--concurrency 4]
  npm run db:embedding-index -- reconcile --key KEY
  npm run db:embedding-index -- record-quality --key KEY --report report.json
  npm run db:embedding-index -- activate --key KEY --expected-epoch N
  npm run db:embedding-index -- rollback --key PREVIOUS_KEY --expected-epoch N
  npm run db:embedding-index -- disable-writes --key KEY
`.trim();
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help") {
    console.info(usage());
    return;
  }
  if (command === "list") {
    console.info(json(await listEmbeddingIndexes()));
    return;
  }
  if (command === "register") {
    const configured = process.argv.includes("--challenger")
      ? resolveConfiguredEmbeddingChallenger()
      : resolveConfiguredEmbeddingCandidate({
          provider: option("provider"),
          modelId: option("model"),
          key: option("key"),
        });
    console.info(json(await registerEmbeddingIndexCandidate(configured)));
    return;
  }
  if (command === "backfill") {
    const result = await backfillEmbeddingIndex({
      key: requiredOption("key"),
      batchSize: positiveNumberOption("batch-size"),
      concurrency: positiveNumberOption("concurrency"),
      onProgress(progress) {
        console.error(
          `[embedding-index] ${progress.kind}: +${progress.processed} (${progress.totalProcessed} total)`,
        );
      },
    });
    console.info(json(result));
    return;
  }
  if (command === "reconcile") {
    console.info(json(await reconcileEmbeddingIndex({ key: requiredOption("key") })));
    return;
  }
  if (command === "record-quality") {
    const report = JSON.parse(
      await readFile(requiredOption("report"), "utf8"),
    ) as { passed?: unknown; validationFence?: unknown };
    if (typeof report.passed !== "boolean") {
      throw new Error("Embedding quality report must include a boolean passed result.");
    }
    console.info(json(await recordEmbeddingQualityGate({
      key: requiredOption("key"),
      passed: report.passed,
      report,
      expectedValidationFence: assertEmbeddingQualityValidationFence(
        report.validationFence,
      ),
    })));
    return;
  }
  if (command === "activate" || command === "rollback") {
    console.info(json(await activateEmbeddingIndex({
      key: requiredOption("key"),
      expectedActivationEpoch: positiveNumberOption("expected-epoch") ??
        (() => {
          throw new Error("--expected-epoch is required.");
        })(),
    })));
    return;
  }
  if (command === "disable-writes") {
    console.info(json(await disableEmbeddingIndexWrites({
      key: requiredOption("key"),
    })));
    return;
  }
  throw new Error(`Unknown command "${command}".\n\n${usage()}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
