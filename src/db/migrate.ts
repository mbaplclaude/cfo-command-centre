/**
 * Applies schema.sql to DATABASE_URL. The DDL is all CREATE TABLE IF NOT EXISTS,
 * so this is safe to re-run. Usage: npm run db:migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseClient } from './client.js';
import { CONFIG } from '../config/index.js';

if (!CONFIG.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set in .env — nothing to migrate.');
  process.exit(1);
}

const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

new DatabaseClient()
  .query(ddl)
  .then(() => console.log('✅ Schema applied (6 tables: employees, tasks, submissions, reminder_logs, approval_requests, chat_messages).'))
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`❌ Migration failed: ${err.message}`);
    process.exit(1);
  });
