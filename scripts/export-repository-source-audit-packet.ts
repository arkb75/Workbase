import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sourceAuditFixture from "@/src/evals/fixtures/repository-source-audits-v1.json";
import { prisma } from "@/src/lib/prisma";
import { repositoryKnowledgeObservationFromDatabase } from "@/src/evals/repository-knowledge-database-observation";
import {
  parseRepositorySourceAuditManifest,
} from "@/src/evals/repository-source-audit";
import {
  buildRepositorySourceAuditAdjudicationPacket,
  sourceAuditRepository,
} from "@/src/evals/repository-source-audit-packet";

type Options = {
  compact: boolean;
  fixtureId: string | null;
  help: boolean;
  liveRunPath: string | null;
  outputPath: string | null;
  workItemId: string | null;
};

const manifest = parseRepositorySourceAuditManifest(sourceAuditFixture);

function usage() {
  return `Export current saved Facts, Highlights, and exact evidence beside an independent source audit.

Usage:
  npx tsx --env-file=.env scripts/export-repository-source-audit-packet.ts \
    --fixture <fixture-id> --work-item <work-item-id> \
    --live-run <saved-live-run-v3.json> [--output <new-packet.json>] [--compact]

This command does not score or model-match outputs. It emits the complete packet
for human semantic adjudication, including a blank adjudication template. A
current eligible packet must match the saved live artifact exactly. Historical
ineligible controls may omit --live-run. --output refuses to overwrite a file.

Available audited fixtures:
${manifest.repositories.map((repository) =>
  `  ${repository.fixtureId} (${repository.repository}@${repository.commitSha})`
).join("\n")}`;
}

function optionValue(args: readonly string[], index: number, name: string) {
  const argument = args[index]!;
  const inline = argument.startsWith(`${name}=`)
    ? argument.slice(name.length + 1)
    : null;
  const value = inline ?? args[index + 1];
  if (!value?.trim() || (inline === null && value.startsWith("--"))) {
    throw new Error(`${name} requires a value.\n\n${usage()}`);
  }
  return { consumed: inline === null ? 1 : 0, value: value.trim() };
}

export function parseRepositorySourceAuditExportOptions(args: readonly string[]): Options {
  const options: Options = {
    compact: false,
    fixtureId: null,
    help: false,
    liveRunPath: null,
    outputPath: null,
    workItemId: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--compact") {
      options.compact = true;
      continue;
    }
    if (argument === "--fixture" || argument.startsWith("--fixture=")) {
      const resolved = optionValue(args, index, "--fixture");
      options.fixtureId = resolved.value;
      index += resolved.consumed;
      continue;
    }
    if (argument === "--work-item" || argument.startsWith("--work-item=")) {
      const resolved = optionValue(args, index, "--work-item");
      options.workItemId = resolved.value;
      index += resolved.consumed;
      continue;
    }
    if (argument === "--live-run" || argument.startsWith("--live-run=")) {
      const resolved = optionValue(args, index, "--live-run");
      if (options.liveRunPath) {
        throw new Error(`--live-run may only be supplied once.\n\n${usage()}`);
      }
      options.liveRunPath = resolve(resolved.value);
      index += resolved.consumed;
      continue;
    }
    if (argument === "--output" || argument.startsWith("--output=")) {
      const resolved = optionValue(args, index, "--output");
      if (options.outputPath) {
        throw new Error(`--output may only be supplied once.\n\n${usage()}`);
      }
      options.outputPath = resolve(resolved.value);
      index += resolved.consumed;
      continue;
    }
    throw new Error(`Unknown option: ${argument}.\n\n${usage()}`);
  }
  return options;
}

async function main() {
  const options = parseRepositorySourceAuditExportOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.fixtureId || !options.workItemId) {
    throw new Error(`--fixture and --work-item are required.\n\n${usage()}`);
  }
  const repository = sourceAuditRepository(manifest, options.fixtureId);
  const liveRun = options.liveRunPath
    ? JSON.parse(await readFile(options.liveRunPath, "utf8")) as unknown
    : undefined;
  const observation = await repositoryKnowledgeObservationFromDatabase(
    {
      id: repository.fixtureId,
      repository: repository.repository,
      snapshotCommit: repository.commitSha,
    },
    {
      workItemId: options.workItemId,
      tolerateIntegrityFailure: true,
    },
  );
  const packet = buildRepositorySourceAuditAdjudicationPacket({
    manifest,
    repository,
    observation,
    workItemId: options.workItemId,
    liveRun,
  });
  const serialized = `${JSON.stringify(packet, null, options.compact ? 0 : 2)}\n`;
  if (options.outputPath) {
    await writeFile(options.outputPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  process.stdout.write(serialized);
}

const executablePath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (executablePath === import.meta.url) {
  main()
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
