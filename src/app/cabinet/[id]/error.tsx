"use client";

import { ErrorPanel, type ErrorBoundaryProps } from "@/components/error-panel";

export default function Error(props: ErrorBoundaryProps) {
  return <ErrorPanel {...props} title="成员档案没有加载成功" />;
}
