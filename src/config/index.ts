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

export const CONFIG = {
  // Google Sheets
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '1blcm4q94bmszP7t-ffLKwOwxUqsQVhHzRJwUOWODFtM',
  GOOGLE_SERVICE_ACCOUNT_KEY_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account.json',
  
  // Sheet Tabs
  STAFF_TRACKER_TAB: '3. Staff Tracker',
  REPORT_CALENDAR_TAB: '4. Report Calendar',
  
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
