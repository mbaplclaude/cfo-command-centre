/**
 * One-time cleanup: find Status cells left over from before this agent existed
 * and annotate them, so they read as "known legacy text" instead of looking like
 * something the current agent did or forgot to do.
 *
 * Writes ONLY the Remarks column (existing content preserved, marker appended
 * once). Status, Days/Overdue Days, and Thread ID are left untouched — this
 * never fabricates a status the agent didn't actually observe.
 *
 * Usage: npm run flag:legacy-status
 */
import { GoogleSheetsClient } from '../google/sheets.js';
import { CONFIG } from '../config/index.js';
import { isLegacyStatus, annotateLegacyStatus } from '../classifier/legacy-status.js';

async function main() {
  console.log('\n======================================================');
  console.log('🏷️  FLAG LEGACY STATUS TEXT');
  console.log('======================================================\n');

  const sheets = new GoogleSheetsClient();
  const [staff, report] = await Promise.all([sheets.readStaffTracker(), sheets.readReportCalendar()]);

  const targets = [
    ...staff.rows
      .filter(r => isLegacyStatus(r.status))
      .map(r => ({
        tab: CONFIG.STAFF_TRACKER_TAB,
        rowIndex: r.rowIndex,
        title: r.taskDescription,
        status: r.status,
        remarks: r.remarks,
        write: (remarks: string) => sheets.updateStaffTrackerRow(r.rowIndex, r.status, remarks, r.days, r.threadId),
      })),
    ...report.rows
      .filter(r => isLegacyStatus(r.status))
      .map(r => ({
        tab: CONFIG.REPORT_CALENDAR_TAB,
        rowIndex: r.rowIndex,
        title: r.reportName,
        status: r.status,
        remarks: r.remarks,
        write: (remarks: string) => sheets.updateReportCalendarRow(r.rowIndex, r.status, remarks, r.overdueDays, r.threadId),
      })),
  ];

  if (targets.length === 0) {
    console.log('✅ No legacy Status text found on either tab. Nothing to do.\n');
    return;
  }

  console.log(`Found ${targets.length} row(s) with Status text the current agent never writes:\n`);

  let annotated = 0;
  let alreadyDone = 0;
  for (const t of targets) {
    const updatedRemarks = annotateLegacyStatus(t.remarks);
    if (updatedRemarks === t.remarks.trim()) {
      console.log(`   ✓ [${t.tab} row ${t.rowIndex}] "${t.title}" — Status "${t.status}" — already annotated`);
      alreadyDone++;
      continue;
    }
    await t.write(updatedRemarks);
    console.log(`   + [${t.tab} row ${t.rowIndex}] "${t.title}" — Status "${t.status}" — Remarks annotated`);
    annotated++;
  }

  console.log(`\n✅ Done: ${annotated} row(s) annotated, ${alreadyDone} already had the marker. Status column untouched on all rows.\n`);
}

main().catch(err => {
  console.error('\n❌ Legacy status flagging failed:', err.message);
  process.exit(1);
});
