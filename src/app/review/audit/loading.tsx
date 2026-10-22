import { PageSkeleton } from "@/components/skeletons";

export default function Loading() {
  return <PageSkeleton title="审计日志" cards={1} rail={false} />;
}
