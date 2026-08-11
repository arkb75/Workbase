import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareProviderQualityReports } from "../src/evals/provider-quality-noninferiority";

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
    "Usage: npx tsx scripts/compare-provider-quality.ts --bedrock bedrock.json --openrouter openrouter.json [--rubric-margin 0.25] [--output comparison.json]",
    "",
    "Both reports must describe the same code revision, repository heads, and scenario set.",
    "Non-inferiority is enforced per scenario; a stronger aggregate cannot hide one regression.",
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
  const bedrockPath = argumentValue("bedrock");
  const openrouterPath = argumentValue("openrouter");
  if (!bedrockPath || !openrouterPath) {
    throw new Error("--bedrock and --openrouter are required.\n\n" + usage());
  }
  const marginValue = argumentValue("rubric-margin");
  const rubricMargin = marginValue == null ? undefined : Number(marginValue);
  const result = compareProviderQualityReports({
    bedrock: await loadJson(bedrockPath),
    openrouter: await loadJson(openrouterPath),
    rubricMargin,
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = argumentValue("output");
  if (outputPath) await writeFile(resolve(outputPath), serialized, "utf8");
  process.stdout.write(serialized);
  if (!result.passed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Provider quality comparison failed."}\n`,
  );
  process.exitCode = 1;
});
