/**
 * Stubbed query interface for the pg store unit tests (D25: tests never talk
 * to a real database). `StubPgPool` is a fake `pg`-compatible `query()`
 * surface installed as the Drizzle driver, so `src/store/pg.ts` runs its REAL
 * schema-typed SQL construction against a stub: every query text and its
 * parameters are recorded, and canned rows/errors are returned instead of
 * talking to PostgreSQL. Deterministic: no network, no timers.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

export interface StubQueryCall {
  /** SQL text Drizzle produced (schema-typed). */
  text: string;
  /** Query parameters Drizzle produced (after column mapping). */
  params: unknown[];
}

export class StubPgPool {
  readonly calls: StubQueryCall[] = [];
  /** Raw driver rows (`rowMode: "array"`) returned for `select ... from "table"`. */
  readonly rowsByTable = new Map<string, unknown[][]>();
  private nextError: unknown = undefined;

  /** Canned rows for selects from the given table. */
  rowsFor(table: string, rows: unknown[][]): void {
    this.rowsByTable.set(table, rows);
  }

  /** The NEXT query rejects with this error (simulates a database failure). */
  failNext(error: unknown): void {
    this.nextError = error;
  }

  /** All recorded queries that mention the given table. */
  callsTo(table: string): StubQueryCall[] {
    return this.calls.filter((call) => call.text.includes(`"${table}"`));
  }

  async query(config: { text: string }, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ text: config.text, params });
    if (this.nextError !== undefined) {
      const error = this.nextError;
      this.nextError = undefined;
      throw error;
    }
    for (const [table, rows] of this.rowsByTable) {
      if (config.text.includes(`from "${table}"`)) return { rows };
    }
    return { rows: [] };
  }
}

/** A real Drizzle database backed by the stub pool (no connection is opened). */
export function stubDatabase(pool: StubPgPool): NodePgDatabase {
  return drizzle(pool as unknown as Pool);
}
