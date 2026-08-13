import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assembleProviderQualityReport } from "../src/evals/provider-quality-report-assembler";

function argumentValue(name: string) {
  const equalsPrefix = `--${name}=`;
  const equalsValue = process.argv.find((argument) =>
    argument.startsWith(equalsPrefix)
  );
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  return [
    "Usage: npx tsx scripts/assemble-provider-quality-report.ts --provider bedrock|openrouter --git-commit SHA --lifecycle-gate gate.json --lifecycle-observations observations.json --accomplishments accomplishments.json [--output report.json]",
    "",
    "The gate and raw observation report are both required: the gate supplies evaluated hard checks, while the observations preserve authoritative model, cost, latency, grounding, and repository-head evidence.",
    "All artifacts must describe the same provider, exact scenario set, and repository head.",
  ].join("\n");
}

async function loadJson(path: string) {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const provider = argumentValue("provider");
  const gitCommit = argumentValue("git-commit");
  const lifecycleGatePath = argumentValue("lifecycle-gate");
  const lifecycleObservationsPath = argumentValue("lifecycle-observations");
  const accomplishmentsPath = argumentValue("accomplishments");
  if (provider !== "bedrock" && provider !== "openrouter") {
    throw new Error("--provider must be bedrock or openrouter.\n\n" + usage());
  }
  if (
    !gitCommit || !lifecycleGatePath || !lifecycleObservationsPath ||
    !accomplishmentsPath
  ) {
    throw new Error(
      "--git-commit, --lifecycle-gate, --lifecycle-observations, and --accomplishments are required.\n\n" +
        usage(),
    );
  }
  const report = assembleProviderQualityReport({
    provider,
    gitCommit,
    lifecycleGate: await loadJson(lifecycleGatePath),
    lifecycleObservations: await loadJson(lifecycleObservationsPath),
    accomplishments: await loadJson(accomplishmentsPath),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = argumentValue("output");
  if (outputPath) await writeFile(resolve(outputPath), serialized, "utf8");
  process.stdout.write(serialized);
  if (!report.scenarios.every((scenario) => scenario.passed)) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Provider quality report assembly failed."}\n`,
  );
  process.exitCode = 1;
});
