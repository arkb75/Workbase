import { execFileSync } from "node:child_process";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";

function runAwsJson(args: string[]) {
  return JSON.parse(
    execFileSync("aws", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        AWS_PAGER: "",
      },
    }),
  ) as Record<string, unknown>;
}

const profile = process.env.WORKBASE_AWS_PROFILE ?? "root";
const region = process.env.WORKBASE_BEDROCK_REGION ?? "us-east-1";
const preferredModelId =
  process.env.WORKBASE_BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";

const identity = runAwsJson(["sts", "get-caller-identity", "--profile", profile]);
const inferenceProfiles = runAwsJson([
  "bedrock",
  "list-inference-profiles",
  "--profile",
  profile,
  "--region",
  region,
]);
const availableProfiles = Array.isArray(inferenceProfiles.inferenceProfileSummaries)
  ? inferenceProfiles.inferenceProfileSummaries
  : [];
const matchingProfile = availableProfiles.find((profileSummary) => {
  if (!profileSummary || typeof profileSummary !== "object") {
    return false;
  }

  return (
    "inferenceProfileId" in profileSummary &&
    profileSummary.inferenceProfileId === preferredModelId
  );
}) as { inferenceProfileId?: string; inferenceProfileName?: string } | undefined;

async function main() {
  if (!matchingProfile?.inferenceProfileId) {
    throw new Error(
      `${preferredModelId} is not visible in ${region} for profile ${profile}.`,
    );
  }

  const runtime = new BedrockRuntimeClient({
    region,
    credentials: fromIni({ profile }),
  });
  const converse = await runtime.send(
    new ConverseCommand({
      modelId: matchingProfile.inferenceProfileId,
      messages: [{ role: "user", content: [{ text: "Run the capability check." }] }],
      inferenceConfig: { maxTokens: 32, temperature: 0 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "workbase_capability_check",
              description: "Return a successful tool-use capability check.",
              inputSchema: { json: { type: "object", properties: {} } },
            },
          },
        ],
        toolChoice: { tool: { name: "workbase_capability_check" } },
      },
    }),
  );
  const supportsToolUse = converse.output?.message?.content?.some((block) => "toolUse" in block);
  if (!supportsToolUse) {
    throw new Error("The configured Bedrock model did not return a Converse tool-use block.");
  }

  console.info("Bedrock preflight passed, including Converse tool use.");
  console.info(
    JSON.stringify(
      {
        account: identity.Account,
        arn: identity.Arn,
        profile,
        region,
        modelId: matchingProfile.inferenceProfileId,
        modelName: matchingProfile.inferenceProfileName ?? null,
      },
      null,
      2,
    ),
  );
  console.info("");
  console.info("Suggested local env:");
  console.info(`WORKBASE_LLM_PROVIDER="bedrock"`);
  console.info(`WORKBASE_AWS_PROFILE="${profile}"`);
  console.info(`WORKBASE_BEDROCK_REGION="${region}"`);
  console.info(`WORKBASE_BEDROCK_MODEL_ID="${matchingProfile.inferenceProfileId}"`);
}

main().catch((error) => {
  console.error(
    `Bedrock preflight failed. ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exit(1);
});
