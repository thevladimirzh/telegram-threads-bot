/**
 * drizzle-kit toolchain config (plan §2.2/§2.9, D14/D25/D85).
 *
 * - `npm run db:generate` — offline: produces SQL migrations from
 *   `src/store/schema.ts` into `./migrations` (no database needed).
 * - `npm run db:migrate` — applies `./migrations` to `DATABASE_URL`
 *   (run by the Helm pre-install/pre-upgrade hook Job).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/store/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Only needed by `migrate`/`push`; `generate` never opens a connection.
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
