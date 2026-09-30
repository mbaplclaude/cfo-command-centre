import pg from 'pg';
import { CONFIG } from '../config/index.js';

const { Pool } = pg;

export class DatabaseClient {
  private pool: pg.Pool | null = null;
  private static warnedUnconfigured = false;

  public getPool(): pg.Pool | null {
    if (!CONFIG.DATABASE_URL) {
      // Say so once. Silently returning zero rows makes writes look like they
      // succeeded — an operator would get a Run ID that can never be approved.
      if (!DatabaseClient.warnedUnconfigured) {
        DatabaseClient.warnedUnconfigured = true;
        console.warn('⚠️ DATABASE_URL is not configured — database reads return empty and writes are discarded.');
      }
      return null;
    }
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: CONFIG.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
    }
    return this.pool;
  }

  public async query(text: string, params?: any[]): Promise<any> {
    const pool = this.getPool();
    if (!pool) {
      // In-memory / dry-run fallback if DB not configured
      return { rows: [] };
    }
    return await pool.query(text, params);
  }

  /**
   * Run several statements on ONE connection inside a single BEGIN/COMMIT.
   *
   * `query()` above goes through the pool, so consecutive calls can land on
   * different connections — which means they cannot share a transaction, and a
   * failure halfway through leaves the earlier statements committed. The row
   * deletion path needs all-or-nothing (see POST /api/tasks/delete): a partial
   * key re-numbering is exactly the silent corruption it exists to prevent.
   *
   * Parameterised statements use the extended protocol, which forbids sending
   * several statements in one string — hence a checked-out client rather than
   * one multi-statement query. Returns null when DATABASE_URL is unset, matching
   * query()'s degrade-quietly behaviour; the caller decides what that means.
   */
  public async transaction<T>(
    fn: (query: (text: string, params?: any[]) => Promise<any>) => Promise<T>
  ): Promise<T | null> {
    const pool = this.getPool();
    if (!pool) return null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn((text, params) => client.query(text, params));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // A failed ROLLBACK must not mask the original error the caller needs.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
