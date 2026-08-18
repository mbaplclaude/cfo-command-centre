import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file if available
dotenv.config();

/**
 * Treat an unfilled .env.example placeholder as absent.
 *
 * Without this, a literal "your-anthropic-api-key" is truthy, so every caller
 * builds a client and burns a doomed HTTP round trip per row before falling back.
 */
const realOrEmpty = (value: string | undefined): string => {
  const v = (value || '').trim().replace(/^["']|["']$/g, '');
  // "your-api-key", "[YOUR-PASSWORD]", and a bracketed placeholder left embedded
  // in a connection string all mean "not filled in yet".
  return /^your-/i.test(v) || /\[[^\]]*\]/.test(v) ? '' : v;
};

/** The original tracker workbook: Staff Tracker + Report Calendar. */
const PRIMARY_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1blcm4q94bmszP7t-ffLKwOwxUqsQVhHzRJwUOWODFtM';

/**
 * "MIS_Checklist_Full" — a second workbook whose two register tabs use the exact
 * same column layout as "4. Report Calendar". Its third tab ("Monthly ") is a
 * different Priority/% Done/Verified By format and is deliberately NOT listed
 * below, so nothing in this pipeline reads or writes it.
 */
const MIS_CHECKLIST_SHEET_ID =
  process.env.MIS_CHECKLIST_SHEET_ID || '1Vb9hjvpq12RglR3rCZlIzpK04mXv9rNrVJ1E0-gq4PQ';

const REPORT_CALENDAR_TAB = '4. Report Calendar';

export const CONFIG = {
  // Google Sheets
  GOOGLE_SHEET_ID: PRIMARY_SHEET_ID,
  MIS_CHECKLIST_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account.json',

  // Sheet Tabs
  STAFF_TRACKER_TAB: '3. Staff Tracker',
  REPORT_CALENDAR_TAB,

  /**
   * Every (spreadsheet, tab) pair carrying Report-Calendar-shaped rows.
   *
   * This is the ONE list that decides what the report pipeline reads and what it
   * is allowed to write back to — adding a workbook means adding entries here,
   * not writing a second reader. A tab absent from this list is untouchable.
   *
   * `requiresConfirmation: true` marks a source not yet trusted for unattended
   * live writes — a live (non-dry-run) invocation touching it needs `--i-mean-it`
   * on the command line or its rows are evaluated and logged but never written.
   * Drop the field (or set false) once a source has been running clean long
   * enough to trust like the primary Report Calendar.
   */
  REPORT_SOURCES: [
    { sheetId: PRIMARY_SHEET_ID, tab: REPORT_CALENDAR_TAB, label: 'Report Calendar' },
    { sheetId: MIS_CHECKLIST_SHEET_ID, tab: 'MIS_Closing_Report (M)', label: 'MIS Monthly Register', requiresConfirmation: true },
    { sheetId: MIS_CHECKLIST_SHEET_ID, tab: 'MIS_Closing_Report (Y)', label: 'MIS Yearly Register', requiresConfirmation: true },
  ] as Array<{ sheetId: string; tab: string; label: string; requiresConfirmation?: boolean }>,

  /**
   * First month of the financial year, 1-12. Drives the "Yearly" cadence window.
   * Default 4 (April) — the Indian FY these registers are keyed to (GSTR 9,
   * depreciation run, year-end scrutiny). Set to 1 for a calendar year.
   */
  FINANCIAL_YEAR_START_MONTH: parseInt(process.env.FINANCIAL_YEAR_START_MONTH || '4', 10),

  // Gmail OAuth2
  GMAIL_ACCOUNT: 'mbaplclaudereply@gmail.com',
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID || '',
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET || '',
  GMAIL_REDIRECT_URI: process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
  GMAIL_REFRESH_TOKEN: realOrEmpty(process.env.GMAIL_REFRESH_TOKEN),

  // Database
  DATABASE_URL: realOrEmpty(process.env.DATABASE_URL),

  // Anthropic Claude API
  ANTHROPIC_API_KEY: realOrEmpty(process.env.ANTHROPIC_API_KEY),

  // Google Gemini — attachment summaries only (see src/classifier/gemini-summarizer.ts).
  // Absent is a supported state: summaries are skipped silently, nothing else changes.
  GEMINI_API_KEY: realOrEmpty(process.env.GEMINI_API_KEY),

  // Operational Settings & Safety
  REQUIRE_APPROVAL: process.env.REQUIRE_APPROVAL !== 'false', // Default true

  // Assignment notifications are NOT reminders: they follow directly from an
  // operator adding a task, so REQUIRE_APPROVAL does not gate them. Kill switch:
  NOTIFY_ASSIGNEE_ON_ADD: process.env.NOTIFY_ASSIGNEE_ON_ADD !== 'false', // Default true
  APPROVAL_TIMEOUT_HOURS: parseInt(process.env.APPROVAL_TIMEOUT_HOURS || '4', 10),
  OPERATOR_EMAIL: process.env.OPERATOR_EMAIL || 'operator@ostwal.in',
  REPLY_FORWARD_EMAIL: process.env.REPLY_FORWARD_EMAIL || 'sourabh@mbapl.com',

  // Invalid email list / self email list
  // Only the agent's OWN mailbox belongs here. Anything listed is excluded from
  // reminders and treated as a self-match in Gmail search, so a real submitter's
  // address must never appear — trade@ostwal.in was removed for that reason.
  OWN_SENDER_EMAILS: (process.env.OWN_SENDER_EMAILS || 'mbaplclaudereply@gmail.com')
    .split(',')
    .map(e => e.trim().toLowerCase()),
};

// ---------------------------------------------------------------------------
// Self-check — REPORT_SOURCES shape only. No network, no credentials.
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };

  const byLabel = (label: string) => CONFIG.REPORT_SOURCES.find(s => s.label === label)!;

  // The primary sheet is long-trusted and must stay unguarded — this is the line
  // that keeps the MIS confirmation requirement from ever spreading to it by accident.
  assert(byLabel('Report Calendar').requiresConfirmation !== true, 'primary Report Calendar is NOT guarded');

  // Both MIS registers require --i-mean-it until this flag is deliberately removed.
  assert(byLabel('MIS Monthly Register').requiresConfirmation === true, 'MIS Monthly Register IS guarded');
  assert(byLabel('MIS Yearly Register').requiresConfirmation === true, 'MIS Yearly Register IS guarded');

  // Every source lives on exactly one of the two known workbooks — a typo'd sheetId
  // here would silently create an unreachable (and therefore un-writable) source.
  for (const s of CONFIG.REPORT_SOURCES) {
    assert(
      s.sheetId === CONFIG.GOOGLE_SHEET_ID || s.sheetId === CONFIG.MIS_CHECKLIST_SHEET_ID,
      `source "${s.label}" points at a recognised workbook`
    );
  }

  console.log('✅ src/config/index.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('config/index.ts')) {
  demo();
}
