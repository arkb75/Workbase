import { execFileSync } from "node:child_process";

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

if (!matchingProfile?.inferenceProfileId) {
  console.error(
    `Bedrock preflight failed. ${preferredModelId} is not visible in ${region} for profile ${profile}.`,
  );
  process.exit(1);
}

console.info("Bedrock preflight passed.");
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
