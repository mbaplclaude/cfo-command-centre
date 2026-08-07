/**
 * Populate the `employees` table from every Sheet source the pipeline reads.
 *
 * The Directory tab reads from Postgres, but nothing ever wrote a row there —
 * only the manual "Add to directory" form did. This reads every valid Staff
 * Tracker row plus every CONFIG.REPORT_SOURCES tab (Report Calendar and both
 * MIS registers today), reduces to one contact per email, and upserts through
 * the same rule as the dashboard's manual form (src/db/directory.ts).
 *
 * Sourcing from CONFIG.REPORT_SOURCES rather than a second hardcoded
 * readReportCalendar() call means a new report-shaped sheet only ever needs
 * one entry there to be picked up here too — the standing rule (see README.md,
 * "Adding a New Google Sheet") is that Directory sync is one of the four things
 * a new source is not done without.
 *
 * Usage: npm run sync:directory
 */
import { GoogleSheetsClient } from '../google/sheets.js';
import { DatabaseClient } from '../db/client.js';
import { mergeContacts, upsertEmployee, RawContact } from '../db/directory.js';
import { CONFIG } from '../config/index.js';

/**
 * Split a possibly comma/semicolon-separated Email ID cell into individual
 * addresses, dropping anything that isn't email-shaped.
 *
 * The MIS registers carry rows like "anant@mbapl.com, ashishraghuwanshi@mbapl.com"
 * in a single cell (one report reviewed by several people) and at least one row
 * uses a bare "-" as a placeholder. Without this, the first would upsert one
 * fake "employee" whose email is a comma-joined string — unusable for autofill
 * or sending — and the second would upsert a non-email as if it were a real
 * address, colliding with every other placeholder row via the email-keyed
 * ON CONFLICT.
 */
function splitEmails(raw: string): string[] {
  return (raw || '').split(/[,;]/).map(e => e.trim()).filter(e => e.includes('@'));
}

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

  const staff = await sheets.readStaffTracker();
  const reportResults = await Promise.all(
    CONFIG.REPORT_SOURCES.map(source => sheets.readReportCalendar(source.sheetId, source.tab))
  );

  // Only rows that already passed the safety filter (real email, not own-mailbox)
  // reach here — invalidRows are excluded the same way the pipeline excludes them.
  const rawContacts: RawContact[] = [
    ...staff.rows.flatMap(r => splitEmails(r.emailId).map(email => ({ personName: r.names, roleLabel: r.assignedTo, email }))),
    ...reportResults.flatMap(result =>
      result.rows.flatMap(r => splitEmails(r.emailId).map(email => ({ personName: r.name, roleLabel: r.sourceWhoSends, email })))
    ),
  ];

  const totalRows = staff.rows.length + reportResults.reduce((n, r) => n + r.rows.length, 0);
  const contacts = mergeContacts(rawContacts);
  console.log(
    `Found ${contacts.size} unique contact(s) across ${totalRows} valid row(s) ` +
      `and ${1 + CONFIG.REPORT_SOURCES.length} source(s) ` +
      `("${CONFIG.STAFF_TRACKER_TAB}", ${CONFIG.REPORT_SOURCES.map(s => `"${s.tab}"`).join(', ')}).\n`
  );

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
