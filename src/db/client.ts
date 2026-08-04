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
}
