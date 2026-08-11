import {
  projectChatApplicationScenarios,
  type ProjectChatApplicationScenarioId,
} from "@/src/evals/project-chat-application-runner";

export interface ProjectChatApplicationCliOptions {
  provider: "mock" | "bedrock" | "openrouter";
  workItemTitle: string;
  scenarioIds: ProjectChatApplicationScenarioId[];
  keepData: boolean;
  compact: boolean;
  accomplishmentsConfig: string | null;
  exactWorkItemTitle: string | null;
  exactRepository: string | null;
  requiredCapabilityPatterns: string[];
  includeFreshnessFollowUp: boolean | null;
  minimumPrimaryItems: number | null;
  maximumPrimaryItems: number | null;
  minimumDevelopedItems: number | null;
  minimumCitedItems: number | null;
}

const booleanOptions = new Set([
  "--keep",
  "--compact",
  "--freshness-follow-up",
  "--no-freshness-follow-up",
]);

const repeatableValueOptions = new Set([
  "--required-capability",
  "--required-capability-regex",
]);

const singleValueOptions = new Set([
  "--provider",
  "--work-item",
  "--scenarios",
  "--accomplishments-config",
  "--work-item-exact",
  "--repository-exact",
  "--minimum-primary-items",
  "--maximum-primary-items",
  "--minimum-developed-items",
  "--minimum-cited-items",
]);

const optionAliases = new Map([
  ["--min-primary-items", "--minimum-primary-items"],
  ["--max-primary-items", "--maximum-primary-items"],
  ["--min-developed-items", "--minimum-developed-items"],
  ["--min-cited-items", "--minimum-cited-items"],
]);

interface ParsedCliArguments {
  booleans: Set<string>;
  values: Map<string, string[]>;
}

function canonicalOption(name: string) {
  return optionAliases.get(name) ?? name;
}

function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      throw new Error(
        `Unexpected positional argument ${JSON.stringify(argument)}. Every argument must use a documented --option.`,
      );
    }

    const equalsIndex = argument.indexOf("=");
    const suppliedName = equalsIndex >= 0
      ? argument.slice(0, equalsIndex)
      : argument;
    const name = canonicalOption(suppliedName);
    const inlineValue = equalsIndex >= 0
      ? argument.slice(equalsIndex + 1)
      : undefined;
    const known = booleanOptions.has(name) ||
      repeatableValueOptions.has(name) || singleValueOptions.has(name);
    if (!known) {
      throw new Error(`Unknown application evaluation option: ${suppliedName}.`);
    }

    if (booleanOptions.has(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`${suppliedName} does not accept a value.`);
      }
      if (booleans.has(name)) {
        throw new Error(`${suppliedName} was supplied more than once.`);
      }
      booleans.add(name);
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (
      value === undefined ||
      value.length === 0 ||
      (inlineValue === undefined && value.startsWith("--"))
    ) {
      throw new Error(`${suppliedName} requires a value.`);
    }
    if (inlineValue === undefined) index += 1;

    const prior = values.get(name) ?? [];
    if (singleValueOptions.has(name) && prior.length) {
      throw new Error(
        `${suppliedName} conflicts with an already supplied value for ${name}.`,
      );
    }
    values.set(name, [...prior, value]);
  }

  return { booleans, values };
}

function onlyValue(parsed: ParsedCliArguments, name: string) {
  return parsed.values.get(name)?.[0];
}

function numericValue(parsed: ParsedCliArguments, name: string) {
  const value = onlyValue(parsed, name);
  return value === undefined ? null : Number(value);
}

export function parseProjectChatApplicationCliOptions(
  argv: readonly string[],
): ProjectChatApplicationCliOptions {
  const parsed = parseCliArguments(argv);
  const provider = onlyValue(parsed, "--provider") ?? "mock";
  if (
    provider !== "mock" &&
    provider !== "bedrock" &&
    provider !== "openrouter"
  ) {
    throw new Error("--provider must be mock, bedrock, or openrouter.");
  }

  const scenarioValue = onlyValue(parsed, "--scenarios");
  const scenarioIds = scenarioValue
    ? scenarioValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) as ProjectChatApplicationScenarioId[]
    : [];
  const knownScenarioIds = new Set(
    projectChatApplicationScenarios.map((scenario) => scenario.id),
  );
  const unknownScenarioIds = scenarioIds.filter(
    (id) => !knownScenarioIds.has(id),
  );
  if (unknownScenarioIds.length) {
    throw new Error(
      `Unknown application scenario${unknownScenarioIds.length === 1 ? "" : "s"}: ${unknownScenarioIds.join(", ")}.`,
    );
  }

  const includeFreshness = parsed.booleans.has("--freshness-follow-up");
  const excludeFreshness = parsed.booleans.has("--no-freshness-follow-up");
  if (includeFreshness && excludeFreshness) {
    throw new Error(
      "--freshness-follow-up and --no-freshness-follow-up are mutually exclusive.",
    );
  }

  return {
    provider,
    workItemTitle:
      onlyValue(parsed, "--work-item") ??
      process.env.EVAL_WORK_ITEM_TITLE ??
      "Workbase",
    scenarioIds,
    keepData: parsed.booleans.has("--keep"),
    compact: parsed.booleans.has("--compact"),
    accomplishmentsConfig:
      onlyValue(parsed, "--accomplishments-config") ?? null,
    exactWorkItemTitle: onlyValue(parsed, "--work-item-exact") ?? null,
    exactRepository: onlyValue(parsed, "--repository-exact") ?? null,
    requiredCapabilityPatterns: [
      ...(parsed.values.get("--required-capability") ?? []),
      ...(parsed.values.get("--required-capability-regex") ?? []),
    ],
    includeFreshnessFollowUp: includeFreshness
      ? true
      : excludeFreshness
        ? false
        : null,
    minimumPrimaryItems: numericValue(parsed, "--minimum-primary-items"),
    maximumPrimaryItems: numericValue(parsed, "--maximum-primary-items"),
    minimumDevelopedItems: numericValue(parsed, "--minimum-developed-items"),
    minimumCitedItems: numericValue(parsed, "--minimum-cited-items"),
  };
}
