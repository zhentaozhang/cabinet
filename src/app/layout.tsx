import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/shell";
import { ToastContainer } from "@/components/ui/toast";
import { fetchShellContext } from "@/lib/api/pages";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cabinet — Personal Agent Org",
  description:
    "Manage a team of learning agents: goals, memory, audits, and autonomy you can verify.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The chrome is the only thing the layout needs, and it degrades gracefully:
  // /login has no session yet, so a failed lookup must not break the page.
  const shellContext = await fetchShellContext().catch(() => null);

  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <Shell context={shellContext}>{children}</Shell>
        <ToastContainer />
      </body>
    </html>
  );
}
