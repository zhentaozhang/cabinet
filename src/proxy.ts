import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { isAuthRequired } from "@/lib/auth/mode";

export function proxy(request: NextRequest) {
  if (!isAuthRequired()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    // Liveness must answer before anyone can sign in: a monitor has no cookie.
    pathname === "/api/health" ||
    // Operator metrics carry their own token; a session would be the wrong key.
    pathname === "/api/metrics" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const session = getSessionCookie(request);
  if (session) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
