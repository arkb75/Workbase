import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveGitHubConfig } from "@/src/lib/github-config";

const oauthStateCookieName = "workbase_github_oauth_state";
const oauthReturnToCookieName = "workbase_github_oauth_return_to";

export async function GET(request: NextRequest) {
  const returnTo = request.nextUrl.searchParams.get("returnTo") || "/dashboard";

  try {
    const config = resolveGitHubConfig();
    const state = randomUUID();
    const authorizeUrl = new URL(config.authorizeBaseUrl);

    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("scope", config.scope);
    authorizeUrl.searchParams.set("state", state);

    if (config.redirectUri) {
      authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
    }

    const response = NextResponse.redirect(authorizeUrl);
    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
    };

    response.cookies.set(oauthStateCookieName, state, cookieOptions);
    response.cookies.set(oauthReturnToCookieName, returnTo, cookieOptions);

    return response;
  } catch {
    return NextResponse.redirect(new URL(`${returnTo}?error=github-config`, request.url));
  }
}
