import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { fromIni } from "@aws-sdk/credential-providers";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

export type AwsCredentialStrategy =
  | {
      kind: "vercel_oidc";
      roleArn: string;
    }
  | {
      kind: "shared_profile";
      profile: string;
    }
  | {
      kind: "default_chain";
    };

export function resolveAwsCredentialStrategy(profile?: string): AwsCredentialStrategy {
  const roleArn = process.env.AWS_ROLE_ARN?.trim();
  if (roleArn) {
    return {
      kind: "vercel_oidc",
      roleArn,
    };
  }

  const normalizedProfile = profile?.trim();
  if (normalizedProfile) {
    return {
      kind: "shared_profile",
      profile: normalizedProfile,
    };
  }

  return {
    kind: "default_chain",
  };
}

export function createAwsCredentials(input: {
  profile?: string;
  region: string;
}): AwsCredentialIdentityProvider | undefined {
  const strategy = resolveAwsCredentialStrategy(input.profile);

  if (strategy.kind === "vercel_oidc") {
    return awsCredentialsProvider({
      roleArn: strategy.roleArn,
      roleSessionName: "workbase-vercel-production",
      clientConfig: {
        region: input.region,
      },
    });
  }

  if (strategy.kind === "shared_profile") {
    return fromIni({
      profile: strategy.profile,
    });
  }

  return undefined;
}
