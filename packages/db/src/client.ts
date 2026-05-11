import { env } from "@cred/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;
export type Sql = ReturnType<typeof postgres>;

let sql: Sql | undefined;
let dbInstance: Database | undefined;

export function getSql(): Sql {
  if (!sql) {
    sql = postgres(env().DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      prepare: false,
    });
  }
  return sql;
}

export function db(): Database {
  if (!dbInstance) {
    dbInstance = drizzle(getSql(), { schema, casing: "snake_case" });
  }
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = undefined;
    dbInstance = undefined;
  }
}
