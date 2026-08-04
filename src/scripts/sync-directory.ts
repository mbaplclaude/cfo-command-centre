/**
 * Populate the `employees` table from the two Sheet tabs.
 *
 * The Directory tab reads from Postgres, but nothing ever wrote a row there —
 * only the manual "Add to directory" form did. This reads every valid Staff
 * Tracker / Report Calendar row, reduces to one contact per email, and upserts
 * through the same rule as the dashboard's manual form (src/db/directory.ts).
 *
 * Usage: npm run sync:directory
 */
import { GoogleSheetsClient } from '../google/sheets.js';
import { DatabaseClient } from '../db/client.js';
import { mergeContacts, upsertEmployee, RawContact } from '../db/directory.js';

async function main() {
  console.log('\n======================================================');
  console.log('👥 SYNC: Sheet -> employees table');
  console.log('======================================================\n');

  const sheets = new GoogleSheetsClient();
  const db = new DatabaseClient();

  if (!db.getPool()) {
    console.error('❌ DATABASE_URL is not configured — nothing to sync into.');
    process.exit(1);
  }

  const [staff, report] = await Promise.all([sheets.readStaffTracker(), sheets.readReportCalendar()]);

  // Only rows that already passed the safety filter (real email, not own-mailbox)
  // reach here — invalidRows are excluded the same way the pipeline excludes them.
  const rawContacts: RawContact[] = [
    ...staff.rows.map(r => ({ personName: r.names, roleLabel: r.assignedTo, email: r.emailId })),
    ...report.rows.map(r => ({ personName: r.name, roleLabel: r.sourceWhoSends, email: r.emailId })),
  ];

  const contacts = mergeContacts(rawContacts);
  console.log(`Found ${contacts.size} unique contact(s) across ${staff.rows.length + report.rows.length} valid row(s).\n`);

  let created = 0;
  let updated = 0;
  for (const contact of contacts.values()) {
    const before = await db.query('SELECT id FROM employees WHERE email = $1', [contact.email]);
    await upsertEmployee(db, { name: contact.name, email: contact.email });
    if (before.rows.length > 0) updated++;
    else created++;
    console.log(`   ${before.rows.length > 0 ? '↻' : '+'} ${contact.name} <${contact.email}>`);
  }

  console.log(`\n✅ Directory sync complete: ${created} added, ${updated} updated, ${contacts.size} total.\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Directory sync failed:', err.message);
  process.exit(1);
});
