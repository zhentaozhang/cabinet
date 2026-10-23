import { PageSkeleton } from "@/components/skeletons";

export default function Loading() {
  return <PageSkeleton title="连接器" cards={2} rail={false} />;
}
