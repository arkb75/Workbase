import { readFile, writeFile } from "node:fs/promises";
import {
  evaluateProjectChatSemanticRobustness,
  projectChatSemanticRobustnessObservationSchema,
} from "@/src/evals/project-chat-semantic-robustness";

function option(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function main() {
  const inputPath = option("--input");
  const outputPath = option("--output");
  if (!inputPath || !outputPath) {
    throw new Error(
      "Usage: evaluate-project-chat-semantic-robustness.ts --input observations.json --output report.json",
    );
  }
  const raw = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && "observations" in raw
      ? (raw as { observations: unknown }).observations
      : null;
  if (!Array.isArray(source)) {
    throw new Error("Semantic robustness input must be an observation array or { observations: [...] }.");
  }
  const observations = source.map((entry) =>
    projectChatSemanticRobustnessObservationSchema.parse(entry)
  );
  const report = evaluateProjectChatSemanticRobustness({ observations });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    passed: report.passed,
    scenarioCount: report.scenarioCount,
    failedChecks: report.checks.filter((check) => !check.passed).length,
    output: outputPath,
  })}\n`);
  if (!report.passed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
