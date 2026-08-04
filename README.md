# CFO Command Centre Agent (v2)

An automated AI agent for the OGI Finance Office / CFO that reads assigned tasks from Google Sheets, searches Gmail for submissions, deterministically time-boxes and classifies task status, updates Google Sheets, and drafts reminder emails with a human-in-the-loop approval checkpoint before dispatching.

---

## 📁 Project Workspace Location

Recommended project directory:
`C:\Users\Hp\.gemini\antigravity\scratch\cfo-command-centre`

---

## 🔒 Non-Negotiable Safety Features
1. **Bad/Missing Data Filter:** Rows missing `Email ID` or `Date Assigned`, or whose Email ID is the agent's own mailbox (`OWN_SENDER_EMAILS`), are strictly excluded from emails and logged in a "Needs Attention" report.
2. **Human-in-the-Loop Approval:** When `REQUIRE_APPROVAL=true`, reminders are created as **Gmail Drafts** and a single summary email is sent to the operator with a Run ID. Reminders are only dispatched after explicit CLI approval (`npm run agent -- --approve <RUN_ID>`).
3. **Restricted Sheet Updates:** Writes are strictly isolated to tabs `"3. Staff Tracker"` and `"4. Report Calendar"` on columns `Status`, `Remarks`, `Days`/`Overdue Days`, and `Thread ID`.
4. **Sender Email Filtering:** Outbound emails and self-addresses are filtered out to prevent false-positive reply matches.

---

## 🛠️ Environment Configuration (`.env`)

Copy `.env.example` to `.env` and configure your credentials:

```env
# Google Sheets Configuration
GOOGLE_SHEET_ID=1blcm4q94bmszP7t-ffLKwOwxUqsQVhHzRJwUOWODFtM
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./service-account.json

# Gmail OAuth2 Configuration (Personal Gmail: mbaplclaudereply@gmail.com)
GMAIL_CLIENT_ID=your-oauth-client-id
GMAIL_CLIENT_SECRET=your-oauth-client-secret
GMAIL_REDIRECT_URI=http://localhost:3000/oauth2callback
GMAIL_REFRESH_TOKEN=your-refresh-token

# Database Configuration (Supabase or Neon PostgreSQL)
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Anthropic Claude API Configuration
ANTHROPIC_API_KEY=your-anthropic-api-key

# Operational Settings
REQUIRE_APPROVAL=true
APPROVAL_TIMEOUT_HOURS=4
OPERATOR_EMAIL=mbaplclaudereply@gmail.com
REPLY_FORWARD_EMAIL=mbaplclaudereply@gmail.com
OWN_SENDER_EMAILS=mbaplclaudereply@gmail.com
```

---

## 🚀 Step-by-Step Execution Guide

### Step 1: One-Time Gmail OAuth Setup
To connect `mbaplclaudereply@gmail.com` using OAuth2:
```bash
npm run auth:gmail
```
Follow the URL prompt to log in and approve access. Copy the generated `GMAIL_REFRESH_TOKEN` into your `.env` file.

### Step 2: Test Google Sheets Read Access (Read-Only)
```bash
npm run test:read-sheets
```
*Verifies reading tabs "3. Staff Tracker" & "4. Report Calendar", validates data integrity, and prints valid rows and the "Needs Attention" report list (zero writes performed).*

### Step 3: Test Gmail Inbox Access (Read-Only)
```bash
npm run test:read-gmail
```
*Verifies Gmail OAuth2 authentication and lists recent messages without drafting or sending.*

### Step 4: Run Main CFO Agent Pipeline
```bash
# Dry run mode (read and evaluate only, no writes/drafts)
npm run agent -- --dry-run

# Standard pipeline run (creates Gmail drafts & sends summary to Operator)
npm run agent

# Approve and dispatch drafted reminders for a specific run ID
npm run agent -- --approve RUN-1740645000000

# View Per-Employee Performance Metrics
npm run agent -- --stats
```

---

## 🔌 Architecture & Stubs
- **Drive Checker:** Stub interface `IDriveChecker` in `src/stubs/drive-checker-stub.ts` ready for future Google Drive folder scanning.
- **WhatsApp Channel:** Pluggable interface `INotificationChannel` in `src/channels/whatsapp-stub.ts` ready for future WhatsApp integration.
- **Database Schema:** DDL script in `src/db/schema.sql` ready for Supabase / Neon PostgreSQL integration.
