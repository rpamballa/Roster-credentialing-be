import { env } from "@cred/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const cfg = env();
  const sql = postgres(cfg.DATABASE_URL, { max: 1, prepare: false });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
    console.log("migrations applied");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
