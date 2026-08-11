import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateWorkItemLifecycleReleaseGate } from "../src/evals/work-item-lifecycle-release-gate";

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
    "Usage: npx tsx scripts/evaluate-work-item-lifecycle-release-gate.ts --input observations.json [--output report.json]",
    "",
    "The input may be an observation array or { \"observations\": [...] }.",
    "This command evaluates recorded lifecycle evidence; it does not label a mocked observation as live.",
  ].join("\n");
}

function observationsFromJson(value: unknown) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "observations" in value) {
    const observations = (value as { observations?: unknown }).observations;
    if (Array.isArray(observations)) return observations;
  }
  throw new Error(
    "Lifecycle observation input must be an array or an object with an observations array.",
  );
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const inputPath = argumentValue("input");
  if (!inputPath) throw new Error("--input is required.\n\n" + usage());
  const parsed: unknown = JSON.parse(
    await readFile(resolve(inputPath), "utf8"),
  );
  const result = evaluateWorkItemLifecycleReleaseGate({
    observations: observationsFromJson(parsed),
  });
  const report = {
    schemaVersion: result.schemaVersion,
    passed: result.passed,
    evaluatedScenarios: result.results.length,
    missingScenarioIds: result.missingScenarioIds,
    duplicateScenarioIds: result.duplicateScenarioIds,
    aggregate: result.results.reduce((aggregate, entry) => {
      const observation = entry.observation;
      const repositoryTiming = observation.scenarioId === "manual_only_create"
        ? null
        : observation.timingsMs;
      const manualTiming = observation.scenarioId === "manual_only_create"
        ? observation.timingsMs
        : null;
      return {
        totalLatencyMs:
          aggregate.totalLatencyMs + observation.timingsMs.total,
        automaticHighlights:
          aggregate.automaticHighlights +
          observation.automaticHighlights.length,
        failedChecks:
          aggregate.failedChecks +
          entry.checks.filter((check) => !check.passed).length,
        maxActionAcknowledgedMs: Math.max(
          aggregate.maxActionAcknowledgedMs,
          observation.timingsMs.actionAcknowledged,
        ),
        maxSourceReservedMs: Math.max(
          aggregate.maxSourceReservedMs,
          observation.timingsMs.sourceReserved,
        ),
        maxEvidenceReadyMs: Math.max(
          aggregate.maxEvidenceReadyMs,
          repositoryTiming?.evidenceReady ?? 0,
        ),
        maxRefreshTerminalMs: Math.max(
          aggregate.maxRefreshTerminalMs,
          repositoryTiming?.refreshTerminal ?? 0,
        ),
        maxManualAgentRunReservedMs: Math.max(
          aggregate.maxManualAgentRunReservedMs,
          manualTiming?.agentRunReserved ?? 0,
        ),
        maxManualAgentRunTerminalMs: Math.max(
          aggregate.maxManualAgentRunTerminalMs,
          manualTiming?.agentRunTerminal ?? 0,
        ),
        maxAutomaticHighlightsTerminalMs: Math.max(
          aggregate.maxAutomaticHighlightsTerminalMs,
          observation.timingsMs.automaticHighlightsTerminal,
        ),
      };
    }, {
      totalLatencyMs: 0,
      automaticHighlights: 0,
      failedChecks: 0,
      maxActionAcknowledgedMs: 0,
      maxSourceReservedMs: 0,
      maxEvidenceReadyMs: 0,
      maxRefreshTerminalMs: 0,
      maxManualAgentRunReservedMs: 0,
      maxManualAgentRunTerminalMs: 0,
      maxAutomaticHighlightsTerminalMs: 0,
    }),
    scenarios: result.results.map((entry) => {
      const observation = entry.observation;
      const common = {
        id: entry.scenarioId,
        provider: observation.provider,
        passed: entry.passed,
        workItemId: observation.currentLineage.workItemId,
        automaticHighlightCount: observation.automaticHighlights.length,
        totalLatencyMs: observation.timingsMs.total,
        timingsMs: observation.timingsMs,
        sloMs: observation.sloMs,
        failedChecks: entry.checks.filter((check) => !check.passed),
      };
      return observation.scenarioId === "manual_only_create"
        ? {
            ...common,
            repository: null,
            expectedHeadSha: null,
            refreshRunId: null,
            repositoryImportStatus: null,
            manualAgentRunId: observation.manualAgentRun.id,
            manualAgentRunStatus: observation.manualAgentRun.status,
            semanticExtractionRunCount: 0,
            failedSemanticExtractionRunCount: 0,
          }
        : {
            ...common,
            repository: observation.repository.fullName,
            expectedHeadSha: observation.repository.expectedHeadSha,
            refreshRunId: observation.refresh.id,
            repositoryImportStatus: observation.repositoryImport.status,
            manualAgentRunId: null,
            manualAgentRunStatus: null,
            semanticExtractionRunCount:
              observation.automation.semanticExtractionRunIds.length,
            failedSemanticExtractionRunCount:
              observation.automation.failedSemanticExtractionRunIds.length,
          };
    }),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = argumentValue("output");
  if (outputPath) await writeFile(resolve(outputPath), serialized, "utf8");
  process.stdout.write(serialized);
  if (!report.passed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Lifecycle release-gate evaluation failed."}\n`,
  );
  process.exitCode = 1;
});
