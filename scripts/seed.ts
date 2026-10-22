import { seedDemo } from "../src/lib/db/seed";

seedDemo()
  .then(() => {
    console.log("Cabinet demo data seeded.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
