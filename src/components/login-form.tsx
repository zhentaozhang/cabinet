"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, Card, ErrorState } from "@/components/ui";
import { safeInternalPath } from "@/lib/safe-redirect";
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
    router.push(
      typeof window !== "undefined"
        ? safeInternalPath(next, window.location.origin)
        : "/",
    );
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
    <div className="mx-auto grid min-h-[78vh] max-w-4xl items-center gap-10 lg:grid-cols-[1fr_minmax(360px,400px)]">
      {/*
        A bare form on an empty page says nothing about what the product is.
        This panel carries the value proposition, and it is the only thing on
        the screen a first-time visitor can read before committing.
      */}
      <section className="hidden lg:block">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-line2 bg-panel2/60 px-3 py-1 text-eyebrow tracking-[0.16em] text-faint uppercase">
          <ShieldCheck className="size-3 text-accent" />
          personal agent org
        </div>
        <h1 className="max-w-md text-page font-semibold tracking-tight text-ink">
          你的个人内阁：一组会执行、也会被审计的 Agent
        </h1>
        <p className="mt-3 max-w-md text-body leading-relaxed text-muted">
          Chief 拆解任务，Researcher 检索真实来源，Auditor 独立验收，
          Critic 专门唱反调。每一次结论都要能点回证据，每一次放行都要你点头。
        </p>
        <ul className="mt-6 space-y-3">
          {[
            ["执行与验收分离", "执行者不能验收自己的产物，驳回要写明理由。"],
            ["证据落库", "检索不到真实来源时，页面不会显示虚假引用。"],
            ["权限按信用发放", "L1 只给建议，升级靠历史审计样本，不靠配置。"],
          ].map(([title, detail]) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-teal/40 bg-teal/10">
                <span className="size-1.5 rounded-full bg-teal" />
              </span>
              <span>
                <span className="block text-label font-medium text-ink">{title}</span>
                <span className="block text-label leading-relaxed text-faint">
                  {detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="w-full">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-label text-faint hover:text-muted"
      >
        <ArrowLeft className="size-3" /> 返回 Today
      </Link>

      <Card className="overflow-hidden">
        <div className="border-b border-line px-6 py-5">
          <div className="mb-2 flex items-center gap-2 text-eyebrow font-medium uppercase tracking-[0.2em] text-faint">
            <ShieldCheck className="size-3 text-accent" />
            Cabinet · access
          </div>
          <h2 className="text-section font-semibold tracking-tight text-ink">
            {mode === "signin" ? "登录你的内阁" : "创建你的账号"}
          </h2>
          <p className="mt-1 text-label leading-relaxed text-muted">
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
                className="mb-1.5 block text-eyebrow uppercase tracking-[0.16em] text-faint"
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
                className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-label text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>
          ) : null}

          <div>
            <label
              htmlFor="login-email"
              className="mb-1.5 block text-eyebrow uppercase tracking-[0.16em] text-faint"
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
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-label text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>
          <div>
            <label
              htmlFor="login-password"
              className="mb-1.5 block text-eyebrow uppercase tracking-[0.16em] text-faint"
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
              className="h-9 w-full rounded-md border border-line bg-panel2 px-3 text-label text-ink focus:border-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>

          {error ? <ErrorState title="没有登录成功" description={error} /> : null}

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

          <div className="flex items-center justify-between pt-1 text-label">
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
    </div>
  );
}
