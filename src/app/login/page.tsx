import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Login · Cabinet",
};

export default function LoginPage() {
  const demoEnabled =
    process.env.DEMO_LOGIN_ENABLED === "true" &&
    process.env.AUTH_REQUIRED !== "true" &&
    process.env.NODE_ENV !== "production";

  return <LoginForm demoEnabled={demoEnabled} />;
}
