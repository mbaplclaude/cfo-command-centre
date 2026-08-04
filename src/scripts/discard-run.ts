/**
 * Abandon a pending approval run.
 *
 * Marks it EXPIRED (keeping the audit trail of what was proposed) and removes its
 * DRAFTED throttle entries so a replacement run is not suppressed by reminders
 * that will never actually be sent. SENT log lines are never touched.
 *
 * Usage: npm run discard:run -- RUN-1785312235602
 */
import { DatabaseClient } from '../db/client.js';
import { discardDraftedRemindersForRun } from '../db/reminder-history.js';

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error('Usage: npm run discard:run -- <RUN_ID>   (e.g. RUN-1785312235602)');
    process.exit(1);
  }

  const db = new DatabaseClient();
  if (!db.getPool()) {
    console.error('❌ DATABASE_URL is not configured.');
    process.exit(1);
  }

  const found = await db.query('SELECT run_id, status, jsonb_array_length(reminders_json) AS n FROM approval_requests WHERE run_id = $1', [runId]);
  if (found.rows.length === 0) {
    console.error(`❌ ${runId} not found in approval_requests.`);
    process.exit(1);
  }

  const row = found.rows[0];
  console.log(`Found ${runId}: status ${row.status}, ${row.n} reminder(s).`);
  if (row.status === 'APPROVED') {
    console.error('❌ Refusing to discard an APPROVED run — its reminders were already sent.');
    process.exit(1);
  }

  await db.query(
    `UPDATE approval_requests
        SET status = 'EXPIRED',
            summary_text = summary_text || ' [DISCARDED via discard:run]'
      WHERE run_id = $1`,
    [runId]
  );

  const { removed } = await discardDraftedRemindersForRun(db, runId);

  console.log(`✅ ${runId} marked EXPIRED; ${removed} DRAFTED throttle entr${removed === 1 ? 'y' : 'ies'} removed.`);
  console.log(`   Note: its Gmail drafts remain in the mailbox as inert artifacts — the approval flow`);
  console.log(`   composes fresh emails on send, so those drafts are never dispatched automatically.`);
  process.exit(0);
}

main().catch(err => {
  console.error(`❌ discard:run failed: ${err.message}`);
  process.exit(1);
});
