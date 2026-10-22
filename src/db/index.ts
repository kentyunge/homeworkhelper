import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;

/**
 * DATABASE_URL = postgres://...     -> node-postgres (Neon in production)
 * DATABASE_URL unset / pglite:<dir> -> embedded PGlite for local dev (pglite:memory for tests)
 */
function createDb(): DB {
  const url = process.env.DATABASE_URL || "pglite:./.pglite";
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length);
    const client = new PGlite(dir === "memory" ? undefined : dir);
    return drizzlePglite(client, { schema }) as unknown as DB;
  }
  return drizzlePg(new Pool({ connectionString: url, max: 5 }), { schema });
}

const globalForDb = globalThis as unknown as { __db?: DB };
export const db: DB = (globalForDb.__db ??= createDb());

export { schema };
