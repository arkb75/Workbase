import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { ensureDemoUser } from "@/src/lib/demo-user";
import { githubAuthService } from "@/src/services/github-auth-service";

const oauthStateCookieName = "workbase_github_oauth_state";
const oauthReturnToCookieName = "workbase_github_oauth_return_to";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const cookieStore = await cookies();
  const storedState = cookieStore.get(oauthStateCookieName)?.value;
  const returnTo = cookieStore.get(oauthReturnToCookieName)?.value || "/dashboard";

  const response = NextResponse.redirect(new URL(returnTo, request.url));

  response.cookies.delete(oauthStateCookieName);
  response.cookies.delete(oauthReturnToCookieName);

  if (!code || !state || !storedState || state !== storedState) {
    response.headers.set("Location", new URL(`${returnTo}?error=github-state`, request.url).toString());
    return response;
  }

  try {
    const demoUser = await ensureDemoUser();
    await githubAuthService.exchangeCodeForUser({
      userId: demoUser.id,
      code,
    });

    response.headers.set("Location", new URL(`${returnTo}?result=github-connected`, request.url).toString());
    return response;
  } catch {
    response.headers.set("Location", new URL(`${returnTo}?error=github-connect-failed`, request.url).toString());
    return response;
  }
}
