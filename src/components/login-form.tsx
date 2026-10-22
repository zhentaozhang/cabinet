"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, Card } from "@/components/ui";
type Mode = "signin" | "signup";

export function LoginForm({ demoEnabled }: { demoEnabled: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(demoEnabled ? "demo@cabinet.local" : "");
  const [password, setPassword] = useState(demoEnabled ? "cabinet-demo" : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(nextEmail = email, nextPassword = password, label = "password") {
    setBusy(label);
    setError(null);
    const { error: authError } = await authClient.signIn.email({
      email: nextEmail,
      password: nextPassword,
    });
    setBusy(null);
    if (authError) {
      setError(authError.message ?? "登录失败");
      return;
    }
    const next =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("next")
        : null;
    router.push(next && next.startsWith("/") ? next : "/");
    router.refresh();
  }

  async function signUp() {
    if (name.trim().length < 2) {
      setError("请输入名字");
      return;
    }
    setBusy("signup");
    setError(null);
    const { error: authError } = await authClient.signUp.email({
      email,
      password,
      name: name.trim(),
    });
    if (authError) {
      setBusy(null);
      setError(authError.message ?? "注册失败");
      return;
    }

    // Ensure a session exists before sending the user to setup.
    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });
    setBusy(null);
    if (signInError) {
      setError(signInError.message ?? "注册成功，但自动登录失败");
      return;
    }
    router.push("/setup");
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-micro text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回 Today
      </Link>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-6 py-5">
          <div className="mb-2 flex items-center gap-2 text-mini font-medium uppercase tracking-[0.2em] text-faint">
            <ShieldCheck className="size-3 text-accent" />
            Cabinet · access
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            {mode === "signin" ? "登录你的内阁" : "创建你的账号"}
          </h1>
          <p className="mt-1 text-micro leading-relaxed text-muted">
            {mode === "signin"
              ? demoEnabled
                ? "演示账号：demo@cabinet.local / cabinet-demo。"
                : "使用你的邮箱和密码登录。"
              : "注册后进入 /setup，创建 7 个默认 Agent。"}
          </p>
        </div>

        <form
          className="space-y-3 px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void (mode === "signin" ? signIn() : signUp());
          }}
        >
          {mode === "signup" ? (
            <div>
              <label
                htmlFor="login-name"
                className="mb-1.5 block text-mini uppercase tracking-[0.16em] text-faint"
              >
                Name
              </label>
              <input
                id="login-name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="你的名字"
                className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>
          ) : null}

          <div>
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-mini uppercase tracking-[0.16em] text-faint"
            >
              Email
            </label>
            <input
              id="login-email"
              name="email"
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>
          <div>
            <label
              htmlFor="login-password"
              className="mb-1.5 block text-mini uppercase tracking-[0.16em] text-faint"
            >
              Password
            </label>
            <input
              id="login-password"
              name="password"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>

          {error ? (
            <div className="rounded-md border border-danger/30 bg-danger/[0.05] px-3 py-2 text-micro text-danger">
              {error}
            </div>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={busy !== null}
          >
            {busy === "password" || busy === "signup" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <LogIn className="size-3" />
            )}
            {mode === "signin" ? "登录" : "注册并创建内阁"}
          </Button>

          <div className="flex items-center justify-between pt-1 text-mini">
            <button
              type="button"
              className="text-faint hover:text-muted"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                if (mode === "signin") {
                  setEmail("");
                  setPassword("");
                }
              }}
            >
              {mode === "signin" ? "创建新账号 →" : "已有账号？登录"}
            </button>
            {demoEnabled ? (
              <button
                type="button"
                className="text-faint hover:text-muted"
                onClick={() => signIn("demo@cabinet.local", "cabinet-demo", "demo")}
                disabled={busy !== null}
              >
                使用演示账号
              </button>
            ) : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
