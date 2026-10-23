import { PageSkeleton } from "@/components/skeletons";

export default function Loading() {
  return <PageSkeleton title="通知" cards={3} rail={false} />;
}
