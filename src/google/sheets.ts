import { google, sheets_v4 } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config/index.js';
import { StaffTrackerRow, ReportCalendarRow, UnifiedTask } from '../types/index.js';

export class GoogleSheetsClient {
  private sheetsClient: sheets_v4.Sheets | null = null;

  /**
   * Initialize Google Sheets API client using Service Account credentials
   */
  public async getClient(): Promise<sheets_v4.Sheets> {
    if (this.sheetsClient) return this.sheetsClient;

    let auth;

    // Check if JSON key path exists
    const keyPath = path.resolve(CONFIG.GOOGLE_SERVICE_ACCOUNT_KEY_PATH);
    if (fs.existsSync(keyPath)) {
      auth = new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      // Inline JSON string in environment variable
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else {
      // Application Default Credentials fallback
      auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    }

    this.sheetsClient = google.sheets({ version: 'v4', auth });
    return this.sheetsClient;
  }

  /**
   * Normalise a header cell for matching: case- and whitespace-insensitive.
   * The live sheet writes "Source / Who Sends" and "Email ID"; this makes both
   * match a single canonical key ("source/whosends", "emailid").
   */
  private static norm(value: any): string {
    return String(value ?? '').toLowerCase().replace(/\s+/g, '');
  }

  /**
   * Fetch a tab and locate its header row.
   *
   * Both tracker tabs open with title/banner rows before the real header, so the
   * header cannot be assumed to be row 1. It is found as the first row carrying an
   * "Email ID" column — the one column every tracked row must have.
   */
  private async readTabValues(
    tabName: string,
    range = 'A1:Z500'
  ): Promise<{ headers: string[]; headerRow: number; values: any[][] }> {
    const sheets = await this.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: `'${tabName}'!${range}`,
    });

    const values = response.data.values || [];
    const headerRow = values.findIndex(row =>
      (row || []).some(cell => GoogleSheetsClient.norm(cell) === 'emailid')
    );

    if (headerRow === -1) {
      console.warn(`⚠️ Tab "${tabName}": no header row containing an "Email ID" column was found in ${range}.`);
      return { headers: [], headerRow: -1, values };
    }

    return { headers: values[headerRow].map(GoogleSheetsClient.norm), headerRow, values };
  }

  /**
   * Read raw rows from "3. Staff Tracker" tab
   */
  public async readStaffTracker(): Promise<{ rows: StaffTrackerRow[]; invalidRows: UnifiedTask[] }> {
    const { headers, headerRow, values } = await this.readTabValues(CONFIG.STAFF_TRACKER_TAB);
    if (headerRow === -1) {
      return { rows: [], invalidRows: [] };
    }

    // Find column indexes
    const colIndex = {
      idNum: headers.indexOf('#'),
      taskDesc: headers.indexOf('taskdescription'),
      assignedTo: headers.indexOf('assignedto'),
      emailId: headers.indexOf('emailid'),
      names: headers.indexOf('names'),
      taskType: headers.indexOf('tasktype'),
      dateAssigned: headers.indexOf('dateassigned'),
      dueDate: headers.indexOf('duedate'),
      days: headers.indexOf('days'),
      status: headers.indexOf('status'),
      remarks: headers.indexOf('remarks'),
      threadId: headers.indexOf('threadid'),
    };

    const validRows: StaffTrackerRow[] = [];
    const invalidRows: UnifiedTask[] = [];

    for (let i = headerRow + 1; i < values.length; i++) {
      const row = values[i];
      if (!row || row.length === 0) continue;

      const emailId = (row[colIndex.emailId] || '').trim();
      const dateAssigned = (row[colIndex.dateAssigned] || '').trim();
      const taskDesc = (row[colIndex.taskDesc] || '').trim();
      const assignedTo = (row[colIndex.assignedTo] || '').trim();

      const unified: UnifiedTask = {
        tabName: '3. Staff Tracker',
        rowIndex: i + 1, // 1-indexed sheet row number
        idNum: (row[colIndex.idNum] || '').trim(),
        taskDescriptionOrName: taskDesc,
        assignedToName: assignedTo || (row[colIndex.names] || '').trim(),
        emailId: emailId,
        taskType: (row[colIndex.taskType] || '').trim(),
        dateAssigned: dateAssigned,
        dueDate: (row[colIndex.dueDate] || '').trim(),
        currentStatus: (row[colIndex.status] || 'Pending').trim(),
        remarks: (row[colIndex.remarks] || '').trim(),
        threadId: (row[colIndex.threadId] || '').trim(),
        daysOrOverdueDays: (row[colIndex.days] || '').trim(),
        isValid: true,
      };

      // Validation Rules
      if (!emailId) {
        unified.isValid = false;
        unified.validationIssue = 'Missing Email ID';
        invalidRows.push(unified);
        continue;
      }

      if (CONFIG.OWN_SENDER_EMAILS.includes(emailId.toLowerCase())) {
        unified.isValid = false;
        unified.validationIssue = `Known invalid / own mailbox address (${emailId})`;
        invalidRows.push(unified);
        continue;
      }

      if (!dateAssigned) {
        unified.isValid = false;
        unified.validationIssue = 'Missing Date Assigned';
        invalidRows.push(unified);
        continue;
      }

      validRows.push({
        rowIndex: i + 1,
        idNum: unified.idNum,
        taskDescription: unified.taskDescriptionOrName,
        assignedTo: unified.assignedToName,
        emailId: unified.emailId,
        names: (row[colIndex.names] || '').trim(),
        taskType: unified.taskType,
        dateAssigned: unified.dateAssigned,
        dueDate: unified.dueDate,
        days: unified.daysOrOverdueDays,
        status: unified.currentStatus,
        remarks: unified.remarks,
        threadId: unified.threadId,
      });
    }

    return { rows: validRows, invalidRows };
  }

  /**
   * Read raw rows from "4. Report Calendar" tab
   */
  public async readReportCalendar(): Promise<{ rows: ReportCalendarRow[]; invalidRows: UnifiedTask[] }> {
    const { headers, headerRow, values } = await this.readTabValues(CONFIG.REPORT_CALENDAR_TAB);
    if (headerRow === -1) {
      return { rows: [], invalidRows: [] };
    }

    const colIndex = {
      idNum: headers.indexOf('#'),
      reportName: headers.indexOf('reportname'),
      taskType: headers.indexOf('tasktype'),
      sourceWhoSends: headers.indexOf('source/whosends'),
      emailId: headers.indexOf('emailid'),
      name: headers.indexOf('name'),
      reviewTiming: headers.indexOf('reviewtiming'),
      status: headers.indexOf('status'),
      overdueDays: headers.indexOf('overduedays'),
      remarks: headers.indexOf('remarks'),
      threadId: headers.indexOf('threadid'),
    };

    const validRows: ReportCalendarRow[] = [];
    const invalidRows: UnifiedTask[] = [];

    for (let i = headerRow + 1; i < values.length; i++) {
      const row = values[i];
      if (!row || row.length === 0) continue;

      const emailId = (row[colIndex.emailId] || '').trim();
      const reportName = (row[colIndex.reportName] || '').trim();
      const sourceWhoSends = (row[colIndex.sourceWhoSends] || '').trim();

      const unified: UnifiedTask = {
        tabName: '4. Report Calendar',
        rowIndex: i + 1,
        idNum: (row[colIndex.idNum] || '').trim(),
        taskDescriptionOrName: reportName,
        assignedToName: sourceWhoSends || (row[colIndex.name] || '').trim(),
        emailId: emailId,
        taskType: (row[colIndex.taskType] || '').trim(),
        dateAssigned: '', // Report calendar may use review timing / schedule
        dueDate: (row[colIndex.reviewTiming] || '').trim(),
        currentStatus: (row[colIndex.status] || 'Pending').trim(),
        remarks: (row[colIndex.remarks] || '').trim(),
        threadId: (row[colIndex.threadId] || '').trim(),
        daysOrOverdueDays: (row[colIndex.overdueDays] || '').trim(),
        isValid: true,
      };

      if (!emailId) {
        unified.isValid = false;
        unified.validationIssue = 'Missing Email ID';
        invalidRows.push(unified);
        continue;
      }

      if (CONFIG.OWN_SENDER_EMAILS.includes(emailId.toLowerCase())) {
        unified.isValid = false;
        unified.validationIssue = `Known invalid / own mailbox address (${emailId})`;
        invalidRows.push(unified);
        continue;
      }

      validRows.push({
        rowIndex: i + 1,
        idNum: unified.idNum,
        reportName: unified.taskDescriptionOrName,
        taskType: unified.taskType,
        sourceWhoSends: unified.assignedToName,
        emailId: unified.emailId,
        name: (row[colIndex.name] || '').trim(),
        reviewTiming: (row[colIndex.reviewTiming] || '').trim(),
        status: unified.currentStatus,
        overdueDays: unified.daysOrOverdueDays,
        remarks: unified.remarks,
        threadId: unified.threadId,
      });
    }

    return { rows: validRows, invalidRows };
  }

  /**
   * Write Status / Remarks / Days / Thread ID to one row of an approved tab.
   *
   * CRITICAL SAFETY RULE: only these four columns, only on the two approved tabs,
   * and only to columns matched by header name — never to a guessed column letter.
   * Both tracker tabs route through here so the safety rule lives in one place.
   */
  private async updateRowColumns(
    tabName: string,
    rowIndex: number,
    values: { status: string; remarks: string; days: string; threadId: string },
    daysHeader: 'days' | 'overduedays'
  ): Promise<void> {
    if (tabName !== CONFIG.STAFF_TRACKER_TAB && tabName !== CONFIG.REPORT_CALENDAR_TAB) {
      throw new Error(`Write rejected: tab "${tabName}" is not in the approved write scope.`);
    }

    const sheets = await this.getClient();
    const { headers, headerRow } = await this.readTabValues(tabName, 'A1:Z20');
    if (headerRow === -1) {
      throw new Error(`Write rejected: could not locate the header row on "${tabName}".`);
    }

    const targets: Array<{ header: string; value: string }> = [
      { header: 'status', value: values.status },
      { header: 'remarks', value: values.remarks },
      { header: daysHeader, value: values.days },
      { header: 'threadid', value: values.threadId },
    ];

    for (const target of targets) {
      const colIndex = headers.indexOf(target.header);
      if (colIndex === -1) {
        console.warn(`   ⚠️ No "${target.header}" column on "${tabName}" — skipping that write rather than guessing a column.`);
        continue;
      }
      const colLetter = String.fromCharCode(65 + colIndex);
      await sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
        range: `'${tabName}'!${colLetter}${rowIndex}`,
        // RAW, not USER_ENTERED: Remarks carries email subject text verbatim, and
        // USER_ENTERED would evaluate anything starting with "=" or "+" as a
        // formula — a spreadsheet-injection path straight from an inbound email.
        valueInputOption: 'RAW',
        requestBody: { values: [[target.value]] },
      });
    }
  }

  /**
   * Update Status, Remarks, Days, and Thread ID for a row in "3. Staff Tracker".
   */
  public async updateStaffTrackerRow(
    rowIndex: number,
    status: string,
    remarks: string,
    days: string,
    threadId: string
  ): Promise<void> {
    await this.updateRowColumns(
      CONFIG.STAFF_TRACKER_TAB,
      rowIndex,
      { status, remarks, days, threadId },
      'days'
    );
  }

  /**
   * Update Status, Remarks, Overdue Days, and Thread ID for a row in "4. Report Calendar".
   */
  public async updateReportCalendarRow(
    rowIndex: number,
    status: string,
    remarks: string,
    overdueDays: string,
    threadId: string
  ): Promise<void> {
    await this.updateRowColumns(
      CONFIG.REPORT_CALENDAR_TAB,
      rowIndex,
      { status, remarks, days: overdueDays, threadId },
      'overduedays'
    );
  }

  /**
   * Update Task Type for one row — the only column this method is allowed to
   * touch. A dashboard edit is a narrower operation than the pipeline's own
   * Status/Remarks/Days/Thread ID write-back, so it gets its own narrowly-scoped
   * method rather than widening updateRowColumns' write set for every caller.
   *
   * Unlike updateRowColumns, a missing column here is a hard failure rather than
   * a skip-and-continue: this method exists to write exactly one column, so if
   * that column can't be found there is nothing left for it to have done.
   */
  public async updateTaskType(tabName: string, rowIndex: number, taskType: string): Promise<void> {
    if (tabName !== CONFIG.STAFF_TRACKER_TAB && tabName !== CONFIG.REPORT_CALENDAR_TAB) {
      throw new Error(`Write rejected: tab "${tabName}" is not in the approved write scope.`);
    }

    const sheets = await this.getClient();
    const { headers, headerRow } = await this.readTabValues(tabName, 'A1:Z20');
    if (headerRow === -1) {
      throw new Error(`Write rejected: could not locate the header row on "${tabName}".`);
    }

    const colIndex = headers.indexOf('tasktype');
    if (colIndex === -1) {
      throw new Error(`Write rejected: no "Task Type" column found on "${tabName}".`);
    }

    const colLetter = String.fromCharCode(65 + colIndex);
    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: `'${tabName}'!${colLetter}${rowIndex}`,
      valueInputOption: 'RAW', // literal text; never let the Sheet reinterpret it
      requestBody: { values: [[taskType]] },
    });
  }

  /**
   * Append a new task row to the specified Google Sheet tab.
   * Only writes user-supplied columns; leaves Status/Remarks/Thread ID/Days blank for the pipeline.
   * CRITICAL SAFETY RULE: Only writes to tabs "3. Staff Tracker" or "4. Report Calendar".
   * Returns the row index of the newly appended row.
   */
  public async appendRow(
    tabName: string,
    fields: {
      taskDescription: string;
      assignedTo: string;
      emailId: string;
      names?: string;
      taskType?: string;
      dateAssigned: string;
      dueDate?: string;
    }
  ): Promise<number> {
    // Safety: only allow writes to approved tabs
    if (tabName !== CONFIG.STAFF_TRACKER_TAB && tabName !== CONFIG.REPORT_CALENDAR_TAB) {
      throw new Error(`Write rejected: tab "${tabName}" is not in the approved write scope.`);
    }

    const sheets = await this.getClient();

    // Resolve the real header row (the tabs open with title/banner rows) to map columns
    const { headers, headerRow } = await this.readTabValues(tabName, 'A1:Z20');
    if (headerRow === -1) {
      throw new Error(`Write rejected: could not locate the header row on "${tabName}".`);
    }

    // Build a row array matching the header columns
    const newRow: string[] = new Array(headers.length).fill('');

    const setCol = (headerName: string, value: string) => {
      const idx = headers.indexOf(headerName);
      if (idx !== -1) newRow[idx] = value;
    };

    if (tabName === CONFIG.STAFF_TRACKER_TAB) {
      setCol('taskdescription', fields.taskDescription);
      setCol('assignedto', fields.assignedTo);
      setCol('emailid', fields.emailId);
      setCol('names', fields.names || '');
      setCol('tasktype', fields.taskType || '');
      setCol('dateassigned', fields.dateAssigned);
      setCol('duedate', fields.dueDate || '');
      // Leave status, remarks, thread id, days BLANK for the pipeline
    } else {
      // Report Calendar columns
      setCol('reportname', fields.taskDescription);
      setCol('source/whosends', fields.assignedTo);
      setCol('emailid', fields.emailId);
      setCol('name', fields.names || '');
      setCol('tasktype', fields.taskType || '');
      setCol('reviewtiming', fields.dueDate || '');
      // Leave status, remarks, thread id, overdue days BLANK
    }

    const appendResponse = await sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
      range: `'${tabName}'!A:Z`,
      // RAW keeps the date exactly as the operator typed it. USER_ENTERED made
      // Sheets re-parse "2026-07-29" into a date serial and re-render it in the
      // spreadsheet's own locale, so the stored text no longer matched what was
      // submitted. The readers parse date text themselves, so RAW is lossless.
      valueInputOption: 'RAW',
      requestBody: { values: [newRow] },
    });

    // Parse the updated range to extract the new row index
    const updatedRange = appendResponse.data.updates?.updatedRange || '';
    const rangeMatch = updatedRange.match(/!.*?(\d+)$/);
    const newRowIndex = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;

    return newRowIndex;
  }
}
