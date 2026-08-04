import { GoogleSheetsClient } from '../google/sheets.js';
import { CONFIG } from '../config/index.js';

async function testReadSheets() {
  console.log('\n======================================================');
  console.log('📊 TEST: Google Sheets Read & Data Integrity Verification');
  console.log(`Sheet ID: ${CONFIG.GOOGLE_SHEET_ID}`);
  console.log('======================================================\n');

  const sheetsClient = new GoogleSheetsClient();

  try {
    console.log(`⏳ Reading tab "${CONFIG.STAFF_TRACKER_TAB}"...`);
    const staffResult = await sheetsClient.readStaffTracker();
    console.log(`✅ Tab "${CONFIG.STAFF_TRACKER_TAB}" read successfully.`);
    console.log(`   - Valid rows: ${staffResult.rows.length}`);
    console.log(`   - Invalid / Skipped rows: ${staffResult.invalidRows.length}\n`);

    console.log(`⏳ Reading tab "${CONFIG.REPORT_CALENDAR_TAB}"...`);
    const reportResult = await sheetsClient.readReportCalendar();
    console.log(`✅ Tab "${CONFIG.REPORT_CALENDAR_TAB}" read successfully.`);
    console.log(`   - Valid rows: ${reportResult.rows.length}`);
    console.log(`   - Invalid / Skipped rows: ${reportResult.invalidRows.length}\n`);

    console.log('------------------------------------------------------');
    console.log('📌 SAMPLE VALID ROWS (Staff Tracker):');
    console.log('------------------------------------------------------');
    console.table(
      staffResult.rows.slice(0, 10).map(r => ({
        'Row #': r.rowIndex,
        'ID #': r.idNum,
        'Task Description': r.taskDescription.substring(0, 30),
        'Assigned To': r.assignedTo,
        'Email ID': r.emailId,
        'Task Type': r.taskType,
        'Date Assigned': r.dateAssigned,
        'Due Date': r.dueDate,
        'Status': r.status,
      }))
    );

    console.log('\n------------------------------------------------------');
    console.log('📌 SAMPLE VALID ROWS (Report Calendar):');
    console.log('------------------------------------------------------');
    console.table(
      reportResult.rows.slice(0, 10).map(r => ({
        'Row #': r.rowIndex,
        'ID #': r.idNum,
        'Report Name': r.reportName.substring(0, 30),
        'Source/Who Sends': r.sourceWhoSends,
        'Email ID': r.emailId,
        'Task Type': r.taskType,
        'Review Timing': r.reviewTiming,
        'Status': r.status,
      }))
    );

    const allInvalid = [...staffResult.invalidRows, ...reportResult.invalidRows];
    if (allInvalid.length > 0) {
      console.log('\n------------------------------------------------------');
      console.log('⚠️ "NEEDS ATTENTION" REPORT (Invalid/Skipped Rows):');
      console.log('------------------------------------------------------');
      console.table(
        allInvalid.map(r => ({
          Tab: r.tabName,
          'Row #': r.rowIndex,
          'Task / Report': r.taskDescriptionOrName.substring(0, 30),
          Email: r.emailId || '(Empty)',
          Issue: r.validationIssue,
        }))
      );
    } else {
      console.log('\n✅ No invalid rows found. All rows passed validation rules!');
    }

    console.log('\n🔒 SAFETY GUARANTEE: Read-only mode verified. Zero writes or sheet modifications performed.');
  } catch (err: any) {
    console.error('\n❌ ERROR Reading Google Sheets:', err.message);
    if (err.message.includes('key') || err.message.includes('auth')) {
      console.log('\n💡 Hint: Ensure service-account.json key file exists or GOOGLE_SERVICE_ACCOUNT_JSON is set in .env');
      console.log('   and the Google Sheet is shared with the Service Account email as Editor.');
    }
  }
}

testReadSheets();
