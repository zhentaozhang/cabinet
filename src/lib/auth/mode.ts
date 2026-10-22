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
