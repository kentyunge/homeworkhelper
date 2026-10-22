import "dotenv/config";
import { db } from "../src/db";

async function main() {
  const url = process.env.DATABASE_URL || "pglite:./.pglite";
  if (url.startsWith("pglite:")) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder: "drizzle" });
  } else {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: "drizzle" });
  }
  console.log("Database migrated.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
