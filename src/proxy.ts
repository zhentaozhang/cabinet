import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { isAuthRequired } from "@/lib/auth/mode";
import {
  REQUEST_ID_HEADER,
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
  newRequestId,
  sanitizeRequestId,
} from "@/lib/obs/request-id";

/**
 * Correlation starts here.
 *
 * Every request leaving this function carries an identifier and its own path,
 * so the Node runtime can log without needing the original `Request` object.
 * The identifiers travel as headers: this file runs on the edge runtime, where
 * `AsyncLocalStorage` does not exist, and the RSC → `/api/*` hop is a second
 * HTTP request that must inherit the first one's identity rather than starting
 * an unrelated one.
 */

function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const requestId =
    sanitizeRequestId(request.headers.get(REQUEST_ID_HEADER)) ??
    newRequestId();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set(REQUEST_PATH_HEADER, pathname);
  requestHeaders.set(REQUEST_METHOD_HEADER, request.method);

  const passThrough = () => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  };

  if (!isAuthRequired() || isPublic(pathname)) {
    return passThrough();
  }

  if (getSessionCookie(request)) {
    return passThrough();
  }

  if (pathname.startsWith("/api/")) {
    const response = NextResponse.json(
      { ok: false, error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  const redirect = NextResponse.redirect(url);
  redirect.headers.set(REQUEST_ID_HEADER, requestId);
  return redirect;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
