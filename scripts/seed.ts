import "../src/lib/env";
import { seedDemo } from "../src/lib/db/seed";

/**
 * `seedDemo()` truncates every table, so the script is destructive by design.
 * Keep it out of production and require an explicit opt-in even locally.
 */
if (
  process.env.NODE_ENV === "production" ||
  process.env.ALLOW_DESTRUCTIVE_SEED !== "true"
) {
  console.error(
    "Refusing to seed: this command truncates all data. " +
      "Run with ALLOW_DESTRUCTIVE_SEED=true outside production.",
  );
  process.exit(1);
}

seedDemo()
  .then(() => {
    console.log("Cabinet demo data seeded.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
