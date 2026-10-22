"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, Card } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo@cabinet.local");
  const [password, setPassword] = useState("cabinet-demo");
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

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-[11px] text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回 Today
      </Link>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-6 py-5">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-faint">
            <ShieldCheck className="size-3 text-accent" />
            Cabinet · access
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            登录你的内阁
          </h1>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            演示账号已内置：`demo@cabinet.local` / `cabinet-demo`。
          </p>
        </div>

        <div className="space-y-3 px-6 py-5">
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-[0.16em] text-faint">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] uppercase tracking-[0.16em] text-faint">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-xs text-ink focus:border-accent/50 focus:outline-none"
            />
          </div>

          {error ? (
            <div className="rounded-md border border-danger/30 bg-danger/[0.05] px-3 py-2 text-[11px] text-danger">
              {error}
            </div>
          ) : null}

          <Button
            variant="primary"
            className="w-full"
            onClick={() => signIn()}
            disabled={busy !== null}
          >
            {busy === "password" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <LogIn className="size-3" />
            )}
            登录
          </Button>

          <Button
            variant="outline"
            className="w-full"
            onClick={() => signIn("demo@cabinet.local", "cabinet-demo", "demo")}
            disabled={busy !== null}
          >
            {busy === "demo" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ShieldCheck className="size-3" />
            )}
            使用演示账号
          </Button>

          <p className="pt-1 text-[10px] leading-relaxed text-faint">
            账号注册与 `/setup` 会在下一步接入；当前请使用演示账号。
          </p>
        </div>
      </Card>
    </div>
  );
}
