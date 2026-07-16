import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateProjectChatSuite,
  validateProjectChatScenarioFixtures,
  type ProjectChatScenarioObservation,
} from "../src/evals/project-chat-evaluation";
import { projectChatEvaluationFixtures } from "../src/evals/project-chat-fixtures";

function usage() {
  return [
    "Usage: npm run eval:project-chat:suite -- [observations.json]",
    "",
    "Without a file, validates and prints the provider-independent scenario contracts.",
    "With a file, evaluates one observation for every scenario and exits non-zero on any failure.",
    "The JSON may be an observation array or { \"observations\": [...] }.",
  ].join("\n");
}

async function loadObservations(filePath: string): Promise<ProjectChatScenarioObservation[]> {
  const parsed: unknown = JSON.parse(await readFile(resolve(filePath), "utf8"));
  const observations = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "observations" in parsed
      ? (parsed as { observations: unknown }).observations
      : null;
  if (!Array.isArray(observations)) throw new Error("Observation JSON must be an array or an object with an observations array.");
  return observations as ProjectChatScenarioObservation[];
}

async function main() {
  const argument = process.argv.slice(2).find((entry) => entry !== "--");
  if (argument === "--help" || argument === "-h") {
    console.log(usage());
    return;
  }

  const fixtureErrors = validateProjectChatScenarioFixtures();
  if (fixtureErrors.length) {
    console.error("Invalid project-chat scenario contracts:\n" + fixtureErrors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  if (!argument) {
    console.log("Project-chat scenario contracts are valid (no application runs were measured).\n");
    console.table(projectChatEvaluationFixtures.map((fixture) => ({
      id: fixture.id,
      route: fixture.expected.route,
      lifecycle: fixture.expected.lifecycle.join(" | "),
      maxSeconds: fixture.envelope.maxLatencyMs / 1_000,
      maxModelCalls: fixture.envelope.maxModelCalls,
      maxTokens: fixture.envelope.maxTotalTokens,
      maxCostUsd: fixture.envelope.maxEstimatedCostUsd,
    })));
    console.log("\n" + usage());
    return;
  }

  const observations = await loadObservations(argument);
  const result = evaluateProjectChatSuite(observations);
  const failures = result.results.flatMap((scenario) => scenario.checks
    .filter((entry) => !entry.passed)
    .map((entry) => ({ scenario: scenario.scenarioId, code: entry.code, message: entry.message, actual: entry.actual, expected: entry.expected })));
  console.log(JSON.stringify({
    passed: result.passed,
    evaluatedScenarios: result.evaluatedScenarios,
    passedScenarios: result.passedScenarios,
    failedScenarios: result.failedScenarios,
    missingScenarioIds: result.missingScenarioIds,
    duplicateScenarioIds: result.duplicateScenarioIds,
    aggregateMetrics: result.aggregateMetrics,
    failures,
  }, null, 2));
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
