import "dotenv/config";
import { Client } from "pg";
import { db } from "../src/db";

/** Tables this app creates. Anything else in the database means it belongs to a different app. */
const OUR_TABLES = ["kids", "turns", "tutor_sessions", "uploads", "account", "session", "user", "verification"];

/** Where we're connecting, without the password: "host/database". */
function describe(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/**
 * Before migrating a real Postgres database, print what's in it, and refuse to touch a database
 * that holds another app's tables (e.g. if DATABASE_URL points at Woodside Wednesday's database).
 */
async function inspect(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name from information_schema.tables
       where table_schema not in ('pg_catalog', 'information_schema') and table_type = 'BASE TABLE'
       order by 1, 2`,
    );
    const { rows: path } = await client.query<{ search_path: string }>("show search_path");
    console.log(`Database: ${describe(url)}`);
    console.log(`search_path: ${path[0]?.search_path}`);
    console.log(`Existing tables: ${rows.length ? rows.map((r) => `${r.schema}.${r.name}`).join(", ") : "(none)"}`);

    const foreign = rows.filter((r) => r.schema === "public" && !OUR_TABLES.includes(r.name)).map((r) => r.name);
    if (foreign.length) {
      throw new Error(
        `This database already holds another app's tables (${foreign.join(", ")}). ` +
          "Homework Helper needs its own database: point DATABASE_URL at a new, empty Neon database. Nothing was changed.",
      );
    }
    const migrated = await client
      .query("select count(*)::int as n from drizzle.__drizzle_migrations")
      .then((r) => r.rows[0].n as number)
      .catch(() => 0);
    const ours = rows.filter((r) => r.schema === "public" && OUR_TABLES.includes(r.name));
    if (ours.length && migrated === 0) {
      throw new Error(
        `This database already has tables named ${ours.map((r) => r.name).join(", ")} but no record of Homework Helper's setup, ` +
          "so they were made by something else (another app, or Neon Auth). Use a new, empty database for DATABASE_URL. Nothing was changed.",
      );
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const url = process.env.DATABASE_URL || "pglite:./.pglite";
  if (url.startsWith("pglite:")) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder: "drizzle" });
  } else {
    await inspect(url);
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: "drizzle" });
  }
  console.log("Database migrated.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  // The full error above is long; repeat the part that explains what went wrong.
  console.error(`\nDatabase setup failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
