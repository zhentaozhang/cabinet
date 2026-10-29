/**
 * Authentication is fail-closed in production. Local demo mode must be opted
 * into explicitly with AUTH_REQUIRED=false and DEMO_LOGIN_ENABLED=true.
 */
export function isAuthRequired(): boolean {
  return (
    process.env.AUTH_REQUIRED === "true" ||
    process.env.NODE_ENV === "production"
  );
}

export function isDemoLoginEnabled(): boolean {
  return !isAuthRequired() && process.env.DEMO_LOGIN_ENABLED === "true";
}

/**
 * What `/api/health` should say about requests that arrive without a session.
 *
 * The demo fallback lives in `getApiUserId`: with no session it returns
 * DEMO_USER_ID — but only when `isAuthRequired()` is false. So the honest
 * condition is "auth is not required right now", not "production build with
 * AUTH_REQUIRED unset". In a production build `isAuthRequired()` is already
 * true because of NODE_ENV, so the old combination fired exactly when nothing
 * was open (the proxy answers 401) and stayed silent in the local build where
 * every request really is the demo user.
 */
export function authOpenWarning(): { code: string; detail: string } | null {
  if (isAuthRequired()) return null;
  return {
    code: "auth.open",
    detail:
      'AUTH_REQUIRED is not "true" in a non-production build — every request without a session acts as the demo user.',
  };
}
