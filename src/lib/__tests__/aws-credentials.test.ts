import { afterEach, describe, expect, it } from "vitest";
import { resolveAwsCredentialStrategy } from "@/src/lib/aws-credentials";

const originalRoleArn = process.env.AWS_ROLE_ARN;

afterEach(() => {
  if (originalRoleArn === undefined) {
    delete process.env.AWS_ROLE_ARN;
  } else {
    process.env.AWS_ROLE_ARN = originalRoleArn;
  }
});

describe("AWS credential strategy", () => {
  it("prefers short-lived Vercel OIDC credentials over a local profile", () => {
    process.env.AWS_ROLE_ARN =
      "arn:aws:iam::392894085110:role/workbase-vercel-production";

    expect(resolveAwsCredentialStrategy("root")).toEqual({
      kind: "vercel_oidc",
      roleArn: "arn:aws:iam::392894085110:role/workbase-vercel-production",
    });
  });

  it("uses the shared profile for local development", () => {
    delete process.env.AWS_ROLE_ARN;

    expect(resolveAwsCredentialStrategy("root")).toEqual({
      kind: "shared_profile",
      profile: "root",
    });
  });

  it("falls back to the standard AWS credential chain", () => {
    delete process.env.AWS_ROLE_ARN;

    expect(resolveAwsCredentialStrategy()).toEqual({
      kind: "default_chain",
    });
  });
});
