/**
 * Audit and clean up orphaned Gmail reminder drafts.
 *
 * Each pipeline run creates one Gmail draft per reminder. Those drafts are inert
 * — approval composes fresh emails rather than sending the drafts — so once a run
 * is EXPIRED its drafts are pure clutter. Drafts belonging to a PENDING run are
 * a live preview of what approval will send and must be kept.
 *
 * Lists by default; deletes only with --delete, and only drafts tied to a run
 * that is EXPIRED. Anything it cannot positively attribute to an expired run is
 * kept — an unrecognised draft might be the operator's own.
 *
 * Usage:
 *   npm run cleanup:drafts            # audit only, deletes nothing
 *   npm run cleanup:drafts -- --delete
 */
import { GmailClient } from '../google/gmail.js';
import { DatabaseClient } from '../db/client.js';

interface RunInfo {
  runId: string;
  status: string;
}

async function main() {
  const doDelete = process.argv.includes('--delete');

  const gmail = new GmailClient();
  const db = new DatabaseClient();

  if (!db.getPool()) {
    console.error('❌ DATABASE_URL is not configured — cannot tell which drafts belong to which run. Refusing to delete anything.');
    process.exit(1);
  }

  // Map every draft id recorded against a run -> that run's status.
  const runs = await db.query(
    `SELECT run_id, status, reminders_json FROM approval_requests ORDER BY created_at DESC`
  );

  const draftOwner = new Map<string, RunInfo>();
  const runTotals = new Map<string, { status: string; drafts: number }>();

  for (const row of runs.rows) {
    const reminders = Array.isArray(row.reminders_json) ? row.reminders_json : [];
    runTotals.set(row.run_id, { status: row.status, drafts: 0 });
    for (const r of reminders) {
      if (r.draftId) {
        draftOwner.set(r.draftId, { runId: row.run_id, status: row.status });
        runTotals.get(row.run_id)!.drafts++;
      }
    }
  }

  console.log('\n======================================================');
  console.log('🧹 GMAIL DRAFT AUDIT');
  console.log('======================================================\n');
  console.log('Approval runs on record:');
  for (const [runId, info] of runTotals) {
    const verdict = info.status === 'PENDING' ? 'KEEP (awaiting your approval)' : 'drafts may be deleted';
    console.log(`   ${runId} | ${info.status} | ${info.drafts} draft(s) | ${verdict}`);
  }

  console.log('\n⏳ Listing Gmail drafts...');
  const drafts = await gmail.listDrafts();
  console.log(`   Found ${drafts.length} draft(s) in the mailbox.\n`);

  const deletable: typeof drafts = [];
  const keep: Array<{ d: (typeof drafts)[number]; reason: string }> = [];

  for (const d of drafts) {
    const owner = draftOwner.get(d.draftId);
    if (owner && owner.status !== 'PENDING') {
      deletable.push(d);
    } else if (owner) {
      keep.push({ d, reason: `belongs to ${owner.runId} (${owner.status})` });
    } else {
      keep.push({ d, reason: 'not attributable to any recorded run' });
    }
  }

  const label = (d: (typeof drafts)[number], extra = '') =>
    `   ${d.draftId}\n      to: ${d.to || '(none)'}\n      subject: ${d.subject || '(no subject)'}${extra ? `\n      ${extra}` : ''}`;

  console.log(`------------------------------------------------------`);
  console.log(`🗑️  DELETABLE — tied to an EXPIRED run (${deletable.length}):`);
  console.log(`------------------------------------------------------`);
  if (deletable.length === 0) console.log('   (none)');
  deletable.forEach(d => console.log(label(d, `run: ${draftOwner.get(d.draftId)!.runId} (${draftOwner.get(d.draftId)!.status})`)));

  console.log(`\n------------------------------------------------------`);
  console.log(`🔒 KEPT — not safe to delete (${keep.length}):`);
  console.log(`------------------------------------------------------`);
  if (keep.length === 0) console.log('   (none)');
  keep.forEach(k => console.log(label(k.d, k.reason)));

  if (!doDelete) {
    console.log(`\n👀 Audit only — nothing was deleted.`);
    console.log(`   Re-run with --delete to remove the ${deletable.length} draft(s) listed as deletable.\n`);
    return;
  }

  if (deletable.length === 0) {
    console.log('\n✅ Nothing to delete.\n');
    return;
  }

  console.log(`\n🗑️  Deleting ${deletable.length} draft(s)...`);
  let deleted = 0;
  const failures: string[] = [];
  for (const d of deletable) {
    try {
      await gmail.deleteDraft(d.draftId);
      deleted++;
      console.log(`   ✅ deleted ${d.draftId} — ${d.subject || '(no subject)'}`);
    } catch (err: any) {
      failures.push(`${d.draftId}: ${err.message}`);
      console.error(`   ❌ FAILED ${d.draftId}: ${err.message}`);
    }
  }

  console.log(`\n✅ Deleted ${deleted}/${deletable.length}. Kept ${keep.length}.`);
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} deletion(s) failed:`);
    failures.forEach(f => console.error(`   ${f}`));
    process.exit(1);
  }
  console.log('');
}

main().catch(err => {
  console.error(`\n❌ Draft cleanup failed: ${err.message}`);
  process.exit(1);
});
