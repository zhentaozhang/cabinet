import { weekLabel } from "@/lib/format";

export function currentWeek() {
  return weekLabel(new Date());
}
