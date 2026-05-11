import { env } from "@cred/config";
import { defineConfig } from "drizzle-kit";

const cfg = env();

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: cfg.DATABASE_URL },
  strict: true,
  verbose: true,
});
