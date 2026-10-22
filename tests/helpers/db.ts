import { seedDemo } from "@/lib/db/seed";

export async function resetDb(): Promise<void> {
  await seedDemo();
}
