import { execFileSync } from "node:child_process";
import {
  runOpenRouterProfileEvaluation,
} from "../src/evals/openrouter-profile-live";
import { prisma } from "../src/lib/prisma";

function argumentValue(name: string) {
  const equalsPrefix = `--${name}=`;
  const equalsValue = process.argv.find((argument) =>
    argument.startsWith(equalsPrefix),
  );
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function gitOutput(args: string[]) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trimEnd();
}

async function main() {
  const gitCommit = gitOutput(["rev-parse", "HEAD"]).trim();
  const path = "src/lib/llm-config.ts";
  const content = gitOutput(["show", `HEAD:${path}`]);
  const report = await runOpenRouterProfileEvaluation({
    label: argumentValue("label") ?? "openrouter-profile-evaluation",
    gitCommit,
    codeFixture: { path, content },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 2;
}

main()
  .catch(() => {
    process.stderr.write(
      "OpenRouter profile evaluation failed before a safe report could be produced.\n",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
