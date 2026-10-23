import { PageSkeleton } from "@/components/skeletons";

export default function Loading() {
  return <PageSkeleton title="设置" cards={2} rail={false} />;
}
