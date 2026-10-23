"use client";

import { ErrorPanel, type ErrorBoundaryProps } from "@/components/error-panel";

export default function Error(props: ErrorBoundaryProps) {
  return <ErrorPanel {...props} title="评审没有加载成功" />;
}
