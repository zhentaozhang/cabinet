import { PageSkeleton } from "@/components/skeletons";

export default function Loading() {
  return <PageSkeleton title="正在加载详情…" cards={2} />;
}
