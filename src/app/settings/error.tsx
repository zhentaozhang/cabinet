"use client";

import { ErrorPanel, type ErrorBoundaryProps } from "@/components/error-panel";

export default function Error(props: ErrorBoundaryProps) {
  return <ErrorPanel {...props} title="设置页没有加载成功" />;
}
