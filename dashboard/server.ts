/**
 * CFO Command Centre — local dashboard server.
 *
 * Serves the single-page dashboard and the JSON API on one port (:4000).
 * Reuses the agent's existing modules directly: the Google Sheet is the source
 * of truth for tasks, Postgres backs approvals / reminder logs / directory.
 *
 * Run: npm run dashboard   ->  http://localhost:4000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { GoogleSheetsClient } from '../src/google/sheets.js';
import { GmailClient } from '../src/google/gmail.js';
import { GmailNotificationChannel } from '../src/channels/gmail-channel.js';
import { DatabaseClient } from '../src/db/client.js';
import { upsertEmployee } from '../src/db/directory.js';
import { CadenceEngine, CHRONIC_REMINDER_CAP, buildDigestContent, DigestItem } from '../src/classifier/cadence.js';
import { TASK_TYPE_OPTIONS } from '../src/util/task-type.js';
import { resolveReportPeriod } from '../src/classifier/report-schedule.js';
import { evaluateRowSubmission } from '../src/pipeline/row-evaluation.js';
import { LLMReasoner } from '../src/classifier/llm-reasoner.js';
import { reminderKey, recordSubmission } from '../src/db/reminder-history.js';
import { formatDisplayDate } from '../src/util/parse-date.js';
import { EmployeeStatsAggregator } from '../src/stats/employee-stats.js';
import { approveAndDispatchRun } from '../src/agent.js';
import { CONFIG } from '../src/config/index.js';
import { UnifiedTask } from '../src/types/index.js';
import {
  categorize, resolveTab, resolveWriteTab, toDashboardTask, validateNewTask, scalarText, isAllowedTaskType,
  MAX_TEXT_LENGTH, NewTaskInput, BadRequest, readBody, isAllowedOrigin, isOversizedDigestBatch,
  MAX_STAFF_DIGEST_BATCH, parseBasicAuthPair,
} from './logic.js';
import {
  isValidSessionId, cleanMessage, loadDbContext, loadHistory, buildChatPrompt, askGemini,
  ChatContext, ContextTask, MAX_MESSAGE_CHARS,
} from './chat.js';

const PORT = Number(process.env.DASHBOARD_PORT || 4000);
const HERE = __dirname;

// Every route here can send mail and write the live Sheet with no other auth
// layer, so once the server binds beyond 127.0.0.1 (Render, any hosted box)
// HTTP Basic Auth is the only thing standing between this and the open
// internet. Basic Auth, not a custom header: this is a browser SPA, and
// browsers natively prompt for + remember + resend Basic credentials (on the
// page load AND every subsequent fetch to the same origin) with no frontend
// code needed — a bearer-style header would need the login page it doesn't have.
//
// Required unconditionally — no "open if unset" fallback, because that
// fallback is exactly the state that would be silently, permanently wrong in
// production.
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
if (!DASHBOARD_USER || !DASHBOARD_PASSWORD) {
  console.error('❌ DASHBOARD_USER and DASHBOARD_PASSWORD must both be set. Refusing to start.');
  process.exit(1);
}

/** Constant-time compare so response timing can't be used to guess credentials byte-by-byte. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Comparing against a same-length buffer when lengths differ, rather than
  // returning false immediately, keeps the compare itself constant-time —
  // an early-out on length would leak the real length via timing.
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  // parseBasicAuthPair, not a bare .split(':') destructure: a password
  // containing a colon used to be silently truncated by keeping only the
  // first two array elements — see its own doc comment.
  const { user, password } = parseBasicAuthPair(Buffer.from(encoded, 'base64').toString('utf8'));
  return timingSafeStringEqual(user, DASHBOARD_USER) && timingSafeStringEqual(password, DASHBOARD_PASSWORD);
}

const sheets = new GoogleSheetsClient();
const gmail = new GmailClient();
const notifier = new GmailNotificationChannel();
const llmReasoner = new LLMReasoner();
const db = new DatabaseClient();

// --- errors -----------------------------------------------------------------

// BadRequest itself now lives in dashboard/logic.ts (imported above), alongside
// readBody — both moved there so they can be self-checked without booting a
// server. See logic.ts for the class and its doc comment.

const GENERIC_ERROR = 'Something went wrong processing this request — see the dashboard server log for details.';

/**
 * Log the real error, return a message that leaks nothing.
 * Used for sub-failures a route reports without aborting (DB mirror, Gmail send).
 */
function internalError(context: string, err: any, clientMessage = GENERIC_ERROR): string {
  console.error(`❌ ${context}:`, err?.stack || err?.message || err);
  return clientMessage;
}

// --- helpers ---------------------------------------------------------------

/** Query Postgres without letting an unconfigured/unreachable DB take down a route. */
async function safeQuery(sql: string, params?: any[]): Promise<{ rows: any[]; error?: string }> {
  try {
    const result = await db.query(sql, params);
    return { rows: result.rows || [] };
  } catch (err: any) {
    // The operator still learns it was the database; the driver's message (which
    // can carry host/credential detail) stays in the server log.
    return { rows: [], error: internalError('Database query failed', err, 'Database unavailable — see the dashboard server log.') };
  }
}

/**
 * Live sheet read, memoised briefly — one dashboard page load hits tasks,
 * needs-attention and stats, which all derive from the same two API calls.
 */
const SHEET_TTL_MS = 15_000;
let sheetCache: { at: number; tasks: UnifiedTask[]; sourceErrors: Record<string, string> } | null = null;

async function readSheet(force = false): Promise<{ tasks: UnifiedTask[]; sourceErrors: Record<string, string> }> {
  if (!force && sheetCache && Date.now() - sheetCache.at < SHEET_TTL_MS) return sheetCache;

  /** Tab name -> why it could not be read. Reported per tab, never as a blank list. */
  const sourceErrors: Record<string, string> = {};

  // Every configured report source goes through the SAME reader the pipeline uses
  // (src/agent.ts), so adding a workbook stays a CONFIG.REPORT_SOURCES edit rather
  // than a second reader here.
  //
  // Each source read is caught individually and NOT with one Promise.all: the MIS
  // registers live in a second workbook, so a service account that isn't shared on
  // it (or an unenabled API on that project) would otherwise reject the whole
  // batch and blank out Staff Tracker and Report Calendar too. Staff Tracker is
  // deliberately left uncaught — its failure is still a hard error, exactly as before.
  const [staff, ...reports] = await Promise.all([
    sheets.readStaffTracker(),
    ...CONFIG.REPORT_SOURCES.map(source =>
      sheets.readReportCalendar(source.sheetId, source.tab).catch(err => {
        sourceErrors[source.tab] = internalError(
          `Sheet read failed (${source.label}, "${source.tab}" on ${source.sheetId})`,
          err,
          `Could not read "${source.tab}" — check the service account has access to that workbook. See the dashboard server log.`
        );
        return { rows: [], invalidRows: [] };
      })
    ),
  ]);

  const tasks: UnifiedTask[] = [
    ...staff.rows.map(r => ({
      tabName: CONFIG.STAFF_TRACKER_TAB as UnifiedTask['tabName'],
      rowIndex: r.rowIndex,
      idNum: r.idNum,
      taskDescriptionOrName: r.taskDescription,
      assignedToName: r.assignedTo,
      emailId: r.emailId,
      taskType: r.taskType,
      dateAssigned: r.dateAssigned,
      dueDate: r.dueDate,
      currentStatus: r.status,
      remarks: r.remarks,
      threadId: r.threadId,
      daysOrOverdueDays: r.days,
      isValid: true,
    })),
    // Index-matched to CONFIG.REPORT_SOURCES, so each row is tagged with the tab it
    // actually came from — that tag is the only thing distinguishing an MIS row
    // from a Report Calendar one downstream.
    ...reports.flatMap((report, i) =>
      report.rows.map(r => ({
        tabName: CONFIG.REPORT_SOURCES[i].tab as UnifiedTask['tabName'],
        rowIndex: r.rowIndex,
        idNum: r.idNum,
        taskDescriptionOrName: r.reportName,
        assignedToName: r.sourceWhoSends,
        emailId: r.emailId,
        taskType: r.taskType,
        dateAssigned: '',
        dueDate: r.reviewTiming,
        currentStatus: r.status,
        remarks: r.remarks,
        threadId: r.threadId,
        daysOrOverdueDays: r.overdueDays,
        isValid: true,
      }))
    ),
    ...staff.invalidRows,
    // readReportCalendar already stamps invalidRows with their own tabName.
    ...reports.flatMap(r => r.invalidRows),
  ];

  sheetCache = { at: Date.now(), tasks, sourceErrors };
  return sheetCache;
}

/** A credential still holding an .env.example placeholder is not configured. */
function configured(value: string): boolean {
  return Boolean(value) && !/^your-|^postgresql:\/\/user:password@host/.test(value);
}

// --- routes ----------------------------------------------------------------

type Handler = (ctx: {
  url: URL;
  req: http.IncomingMessage;
  params: string[];
}) => Promise<{ status?: number; body: any }>;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  // Which credentials are actually configured — lets the UI explain empty states.
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: async () => ({
      body: {
        sheetId: CONFIG.GOOGLE_SHEET_ID,
        serviceAccount: fs.existsSync(path.resolve(CONFIG.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) || Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
        database: configured(CONFIG.DATABASE_URL),
        gmail: configured(CONFIG.GMAIL_REFRESH_TOKEN),
        anthropic: configured(CONFIG.ANTHROPIC_API_KEY),
        requireApproval: CONFIG.REQUIRE_APPROVAL,
        approvalTimeoutHours: CONFIG.APPROVAL_TIMEOUT_HOURS,
        operatorEmail: CONFIG.OPERATOR_EMAIL,
        // The MIS Checklist tab's sub-toggle is built from this, so the register
        // tab names live in CONFIG.REPORT_SOURCES only — the frontend never carries
        // its own copy that could drift from what the pipeline actually reads.
        // `requiresConfirmation` travels with them: that flag is exactly what makes
        // these registers read-only in the UI, so the UI has to be able to see it.
        misSources: CONFIG.REPORT_SOURCES.filter(s => s.sheetId === CONFIG.MIS_CHECKLIST_SHEET_ID).map(s => ({
          tab: s.tab,
          label: s.label,
          requiresConfirmation: Boolean(s.requiresConfirmation),
        })),
      },
    }),
  },

  // GET /api/task-types — the one canonical dropdown list (src/util/task-type.ts),
  // so the frontend never carries its own hardcoded copy that can drift from it.
  {
    method: 'GET',
    pattern: /^\/api\/task-types$/,
    handler: async () => ({ body: { options: TASK_TYPE_OPTIONS } }),
  },

  // POST /api/tasks/task-type — edit Task Type on an existing row, in place.
  //
  // Order matters for the "fail loud, never desync" requirement:
  //   1. Write the Sheet cell. If this throws, stop — return the error, touch
  //      nothing else. The DB mirror and the in-memory cache must never show a
  //      value the Sheet doesn't actually have.
  //   2. Only once that succeeds: invalidate the sheet cache (dashboard reflects
  //      the change on next read, no waiting for the 15s TTL) and best-effort
  //      update the `tasks` mirror table.
  //   3. Re-run this one row's classification under the NEW Task Type — the type
  //      change can flip which cadence/time-box rules apply, so leaving the old
  //      Status/Remarks in place would be showing a decision made under the type
  //      that no longer exists. This never drafts or sends a reminder — that
  //      stays behind the existing manual-approval flows.
  {
    method: 'POST',
    pattern: /^\/api\/tasks\/task-type$/,
    handler: async ({ req }) => {
      const body = await readBody(req);
      // resolveWriteTab, NOT resolveTab: this route WRITES a Task Type cell. The
      // loose resolver would silently guess Report Calendar for a malformed tab
      // value — combined with a rowIndex that happens to be a real row there,
      // that would overwrite an unrelated row's Task Type instead of failing.
      const tabName = resolveWriteTab(body.tab);
      if (tabName === null) {
        return { status: 400, body: { error: `"${scalarText(body.tab) || '(blank)'}" is not a recognised tab — nothing was written.` } };
      }
      const rowIndex = Number(body.rowIndex);

      // scalarText, not String(): String({}) is "[object Object]", which this route
      // wrote into a live Task Type cell and destroyed the real value.
      const taskType = scalarText(body.taskType);
      if (taskType === null) {
        return { status: 400, body: { error: 'taskType must be text, not an object or array.' } };
      }

      if (!Number.isInteger(rowIndex) || rowIndex < 1) {
        return { status: 400, body: { error: 'rowIndex is required and must be a positive whole number.' } };
      }

      // Checked against the canonical list BEFORE the Sheet write, so an
      // unrecognised value can never be persisted. Blank stays allowed — it is
      // the dropdown's "— unspecified —" option.
      if (!isAllowedTaskType(taskType)) {
        return {
          status: 400,
          body: { error: `"${taskType}" is not a valid Task Type. Allowed: ${TASK_TYPE_OPTIONS.join(', ')}.` },
        };
      }

      // A source still carrying `requiresConfirmation` is not trusted for writes
      // that nobody is watching. The CLI refuses to write one without --i-mean-it,
      // so this route must not be the quieter way in — and the read below defaults
      // to the PRIMARY workbook, which for an MIS tab would inspect the wrong sheet
      // entirely before the write scope caught it.
      const guarded = CONFIG.REPORT_SOURCES.find(s => s.tab === tabName && s.requiresConfirmation);
      if (guarded) {
        return {
          status: 403,
          body: {
            error:
              `"${guarded.label}" is read-only from the dashboard: it still requires --i-mean-it on the command line ` +
              `before anything may write to it. Edit the Task Type in the Sheet itself, or clear requiresConfirmation ` +
              `in CONFIG.REPORT_SOURCES once this source is trusted.`,
          },
        };
      }

      // Read the row as it stands now, both to confirm it exists and to source
      // everything re-evaluation needs (title, recipient, due date, thread id) —
      // avoids a second Sheets round-trip after the write.
      const isStaff = tabName === CONFIG.STAFF_TRACKER_TAB;
      const before = isStaff ? await sheets.readStaffTracker() : await sheets.readReportCalendar();
      const row = (before.rows as any[]).find(r => r.rowIndex === rowIndex);
      if (!row) {
        return { status: 404, body: { error: `Row ${rowIndex} not found on "${tabName}" (or excluded by the safety filter).` } };
      }

      // Step 1 — the Sheet write. Any failure here (permissions, network) stops
      // everything else; nothing downstream may run against stale/assumed state.
      try {
        await sheets.updateTaskType(tabName, rowIndex, taskType);
      } catch (err: any) {
        return {
          status: 502,
          body: {
            error: internalError(
              `Sheet write failed (Task Type, ${tabName} row ${rowIndex})`,
              err,
              'Could not write Task Type to the Sheet — see the dashboard server log.'
            ),
            sheetUpdated: false,
          },
        };
      }

      sheetCache = null; // Step 2a — next read is fresh, not the 15s-old cache

      // Step 2b — best-effort DB mirror. This table is never read back for the
      // dashboard's own display (that always comes from the Sheet), so a failure
      // here is logged but not fatal — the Sheet write already succeeded and is
      // the source of truth.
      const mirror = await safeQuery(
        `UPDATE tasks SET task_type = $1, updated_at = NOW() WHERE tab_name = $2 AND row_index = $3`,
        [taskType, tabName, rowIndex]
      );

      // Step 3 — re-evaluate this row under the new type.
      let reevaluation: any = { attempted: false, reason: '' };
      try {
        let windowStart: string;
        let dueDate: string;
        let dueDateLabel: string;
        let title: string;
        let recipientEmail: string;
        let recipientName: string;

        if (isStaff) {
          title = row.taskDescription;
          recipientEmail = row.emailId;
          recipientName = row.assignedTo;
          windowStart = row.dateAssigned;
          dueDate = row.dueDate;
          dueDateLabel = row.dueDate;
        } else {
          const period = resolveReportPeriod(row.reviewTiming, taskType);
          if (!period) {
            reevaluation = {
              attempted: false,
              reason: `Task Type "${taskType || '(blank)'}" has no recognised cadence — Review Timing "${row.reviewTiming}" could not be resolved into a due-date window, so this row cannot be time-boxed until the type is corrected.`,
            };
            throw new Error('SKIP_REEVAL');
          }
          title = row.reportName;
          recipientEmail = row.emailId;
          recipientName = row.sourceWhoSends || row.name;
          windowStart = period.periodStart.toISOString();
          dueDate = period.dueDate.toISOString();
          dueDateLabel = period.label;
        }

        const unit = {
          tabName,
          rowIndex,
          title,
          recipientEmail,
          recipientName,
          taskType,
          windowStart,
          dueDate,
          dueDateLabel,
          currentStatus: row.status,
          threadId: row.threadId,
        };

        const { classification, selectedReply } = await evaluateRowSubmission(
          unit,
          { gmailClient: gmail, llmReasoner },
          () => {} // quiet — this is a targeted single-row re-check, not a full pipeline run
        );

        if (classification && classification.status !== 'Irrelevant') {
          if (isStaff) {
            await sheets.updateStaffTrackerRow(rowIndex, classification.status, classification.remarks, row.days, classification.threadId || row.threadId);
          } else {
            await sheets.updateReportCalendarRow(rowIndex, classification.status, classification.remarks, row.overdueDays, classification.threadId || row.threadId);
          }
          if (selectedReply) {
            await recordSubmission(db, {
              tabName,
              rowIndex,
              senderEmail: recipientEmail,
              messageId: selectedReply.id,
              threadId: selectedReply.threadId,
              subject: selectedReply.subject,
              dateReceived: selectedReply.date,
              classification: classification.status,
              remarks: classification.remarks,
              snippet: selectedReply.snippet,
              attachments: selectedReply.attachments,
            });
          }
          sheetCache = null; // the re-evaluation wrote Status/Remarks too
          reevaluation = {
            attempted: true,
            classification: classification.status,
            remarks: classification.remarks,
            message: `Re-evaluated under the new Task Type: an existing reply now resolves to "${classification.status}".`,
          };
        } else {
          // No matching reply — report cadence eligibility for information only.
          // This NEVER drafts or sends anything; sending stays behind the
          // existing manual (Staff Tracker) or scheduled-approval (Reports) flows.
          const eligibility = CadenceEngine.evaluateDigestEligibility(row.status, taskType, dueDate, 0);
          reevaluation = {
            attempted: true,
            classification: null,
            overdueDays: eligibility.overdueDays,
            wouldBeEligibleForReminder: eligibility.eligible,
            message: eligibility.eligible
              ? `No matching reply. Under the new Task Type this row is ${eligibility.overdueDays} day(s) overdue and would be included in the next daily digest — nothing was sent automatically.`
              : `No matching reply. ${eligibility.reason}`,
          };
        }
      } catch (err: any) {
        if (err.message !== 'SKIP_REEVAL') {
          reevaluation = {
            attempted: false,
            reason: internalError(
              `Task Type re-evaluation failed (${tabName} row ${rowIndex})`,
              err,
              'Task Type was updated, but re-evaluation failed — see the dashboard server log.'
            ),
          };
        }
      }

      return {
        status: 200,
        body: { ok: true, tabName, rowIndex, taskType, dbWarning: mirror.error, reevaluation },
      };
    },
  },

  // GET /api/tasks?tab=Staff Tracker|Report Calendar
  {
    method: 'GET',
    pattern: /^\/api\/tasks$/,
    handler: async ({ url }) => {
      const tabName = resolveTab(url.searchParams.get('tab') || undefined);
      const { tasks: all, sourceErrors } = await readSheet(url.searchParams.get('refresh') === '1');

      // Latest recorded submission per row, for the Gmail thread + attachment links.
      //
      // starts_with, not LIKE: "_" is a LIKE wildcard, and "MIS_Closing_Report (M)"
      // is full of them — under LIKE those underscores match ANY character, so one
      // register's key pattern could pick up another tab's rows.
      const subs = await safeQuery(
        `SELECT DISTINCT ON (task_key)
                task_key, thread_id, message_id, subject, date_received, attachments_json, attachment_summary
           FROM submissions
          WHERE starts_with(task_key, $1)
          ORDER BY task_key, date_received DESC`,
        [`${tabName}|`]
      );
      const byKey = new Map<string, any>();
      for (const s of subs.rows) byKey.set(s.task_key, s);

      // Mail status per row. A confirmed send is a reminder_logs row with status
      // SENT and a Gmail message_id — a DRAFTED row only means a draft exists.
      const mail = await safeQuery(
        `SELECT task_key,
                COUNT(*) FILTER (WHERE status = 'SENT')::int    AS sent_count,
                COUNT(*) FILTER (WHERE status = 'DRAFTED')::int AS drafted_count,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int  AS failed_count,
                MAX(sent_at) FILTER (WHERE status = 'SENT')     AS last_sent_at,
                (ARRAY_AGG(message_id ORDER BY sent_at DESC) FILTER (WHERE status = 'SENT' AND message_id IS NOT NULL))[1] AS last_message_id,
                (ARRAY_AGG(error_text ORDER BY sent_at DESC) FILTER (WHERE status = 'FAILED'))[1] AS last_error
           FROM reminder_logs
          WHERE starts_with(task_key, $1)
          GROUP BY task_key`,
        [`${tabName}|`]
      );
      const mailByKey = new Map<string, any>();
      for (const m of mail.rows) mailByKey.set(m.task_key, m);

      // Dashboard-only "Mark reviewed" bookkeeping — never part of sheetCache,
      // read fresh on every request like subs/mail above.
      const reviewed = await safeQuery(
        `SELECT task_key, reviewed_at FROM reviewed_tasks WHERE starts_with(task_key, $1)`,
        [`${tabName}|`]
      );
      const reviewedByKey = new Map<string, any>();
      for (const r of reviewed.rows) reviewedByKey.set(r.task_key, r.reviewed_at);

      const tasks = all
        .filter(t => t.tabName === tabName && t.isValid)
        .map(t => {
          const task = toDashboardTask(t);
          const key = `${tabName}|${t.rowIndex}`;
          const sub = byKey.get(key);
          const m = mailByKey.get(key);

          // Precedence: a real send outranks a pending draft, which outranks a
          // failure, which outranks "nothing has been attempted".
          const mailStatus = !m
            ? 'none'
            : m.sent_count > 0
              ? 'sent'
              : m.drafted_count > 0
                ? 'draft_pending'
                : m.failed_count > 0
                  ? 'failed'
                  : 'none';

          return {
            ...task,
            mail: {
              status: mailStatus,
              sentCount: m?.sent_count || 0,
              draftedCount: m?.drafted_count || 0,
              failedCount: m?.failed_count || 0,
              lastSentAt: m?.last_sent_at || null,
              messageId: m?.last_message_id || null,
              lastError: m?.last_error || null,
              chronicallyOverdue: (m?.sent_count || 0) + (m?.drafted_count || 0) >= CHRONIC_REMINDER_CAP,
            },
            // threadId from the Sheet is the fallback when no submission is recorded.
            submission: sub
              ? {
                  threadId: sub.thread_id || task.threadId,
                  messageId: sub.message_id,
                  subject: sub.subject,
                  dateReceived: sub.date_received,
                  // DD-Mon-YY, same display convention as dateAssignedDisplay /
                  // dueDateDisplay — shown next to a "Received"/"Received (Early)"
                  // status badge. Sourced from the existing submissions.date_received
                  // column, not a new field the pipeline has to start writing.
                  dateReceivedDisplay: formatDisplayDate(sub.date_received.toISOString()),
                  attachments: sub.attachments_json || [],
                  // Written once by the pipeline when the submission was matched
                  // (see recordSubmission). null means no summary was generated —
                  // no GEMINI_API_KEY, no attachments, or the call failed — and the
                  // UI simply shows nothing rather than a placeholder.
                  attachmentSummary: sub.attachment_summary || null,
                }
              : null,
            // Dashboard-only bookkeeping (see reviewed_tasks) — never affects
            // classification, reminders, or anything else in the pipeline.
            reviewedAt: reviewedByKey.get(key) || null,
          };
        });

      return {
        body: {
          tab: tabName,
          tasks,
          dbWarning: subs.error || mail.error || reviewed.error,
          // Only this tab's own read failure — one unreadable workbook must not
          // put a warning on every other tab's page.
          sheetWarning: sourceErrors[tabName],
        },
      };
    },
  },

  // GET /api/needs-attention — rows the safety filter excluded
  {
    method: 'GET',
    pattern: /^\/api\/needs-attention$/,
    handler: async () => {
      const { tasks } = await readSheet();
      return { body: { rows: tasks.filter(t => !t.isValid).map(toDashboardTask) } };
    },
  },

  // POST /api/tasks — validate, append to the real Sheet, mirror into Postgres
  {
    method: 'POST',
    pattern: /^\/api\/tasks$/,
    handler: async ({ req }) => {
      const input: NewTaskInput = await readBody(req);
      const { ok, errors, clean, tab: tabName } = validateNewTask(input);
      if (!ok) return { status: 400, body: { errors } };

      // Everything below uses `clean`/`tabName` from validateNewTask's own result,
      // never a second resolveTab(input.tab) call: that used to re-resolve the SAME
      // raw input independently, via the loose reader-side resolver — meaning what
      // got validated and what got WRITTEN could, in principle, be two different
      // tabs. Using the exact tab validateNewTask already resolved (via the strict
      // resolveWriteTab) guarantees the write targets exactly what was checked.
      const rowIndex = await sheets.appendRow(tabName, {
        taskDescription: clean.taskDescription,
        assignedTo: clean.assignedTo,
        emailId: clean.emailId,
        names: clean.names,
        taskType: clean.taskType,
        dateAssigned: clean.dateAssigned,
        dueDate: clean.dueDate,
      });

      // Best-effort DB mirror — the Sheet write already succeeded and is authoritative.
      const mirror = await safeQuery(
        `INSERT INTO tasks (tab_name, row_index, task_description, assigned_to, email_id, task_type, date_assigned, due_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pending')
         ON CONFLICT (tab_name, row_index) DO UPDATE SET
           task_description = EXCLUDED.task_description,
           assigned_to      = EXCLUDED.assigned_to,
           email_id         = EXCLUDED.email_id,
           updated_at       = NOW()
         RETURNING id`,
        [
          tabName,
          rowIndex,
          clean.taskDescription,
          clean.assignedTo,
          clean.emailId,
          clean.taskType,
          clean.dateAssigned,
          clean.dueDate,
        ]
      );

      // Notify the assignee. Not gated by REQUIRE_APPROVAL — see
      // GmailNotificationChannel.sendAssignmentNotification for the reasoning.
      let notified = false;
      let notifyError: string | undefined;
      if (CONFIG.NOTIFY_ASSIGNEE_ON_ADD) {
        try {
          await notifier.sendAssignmentNotification({
            taskDescription: clean.taskDescription,
            recipientName: clean.names || clean.assignedTo,
            recipientEmail: clean.emailId,
            dueDate: clean.dueDate,
            dateAssigned: clean.dateAssigned,
            taskType: clean.taskType,
            tabName,
          });
          notified = true;
        } catch (err: any) {
          // The Sheet row is already written and authoritative; a failed
          // notification must not make the whole request look like a failure.
          notifyError = internalError(
            `Assignment notification to ${clean.emailId} failed`,
            err,
            'The task was saved, but notifying the assignee failed — see the dashboard server log.'
          );
        }
      }

      sheetCache = null; // force a re-read so the new row shows immediately
      return {
        status: 201,
        body: {
          task: {
            tabName,
            rowIndex,
            taskDescription: clean.taskDescription,
            assignedTo: clean.assignedTo,
            emailId: clean.emailId,
            taskType: clean.taskType,
            dateAssigned: clean.dateAssigned,
            dueDate: clean.dueDate,
            status: 'Pending',
            remarks: '',
            days: '',
            isValid: true,
            category: categorize('Pending'),
          },
          dbWarning: mirror.error,
          notified,
          notifyError,
        },
      };
    },
  },

  // POST /api/tasks/edit — edit the user-editable fields of an EXISTING row
  // (Task List or Needs Attention). Validation is IDENTICAL to adding a new row:
  // the Edit form sends the exact same field shape as "Add a Task", just against
  // a rowIndex that already exists, so validateNewTask (strict resolveWriteTab,
  // field coercion/limits, the own-mailbox/task-type/date checks) applies
  // unchanged. Only the write target differs — an existing cell, not a new row.
  {
    method: 'POST',
    pattern: /^\/api\/tasks\/edit$/,
    handler: async ({ req }) => {
      const input = await readBody(req);
      const { ok, errors, clean, tab: tabName } = validateNewTask(input);
      const rowIndex = Number(input.rowIndex);
      if (!Number.isInteger(rowIndex) || rowIndex < 1) {
        errors.rowIndex = 'rowIndex is required and must be a positive whole number.';
      }
      if (!ok || errors.rowIndex) return { status: 400, body: { errors } };

      // Same read-only MIS guard as the Task Type editor and every other
      // dashboard write — this must never be a quieter way around --i-mean-it.
      const guarded = CONFIG.REPORT_SOURCES.find(s => s.tab === tabName && s.requiresConfirmation);
      if (guarded) {
        return {
          status: 403,
          body: {
            error:
              `"${guarded.label}" is read-only from the dashboard: it still requires --i-mean-it on the command line ` +
              `before anything may write to it. Edit this row in the Sheet itself.`,
          },
        };
      }

      try {
        // No `names` here, deliberately: the Edit form (like Add a Task) never
        // collects that field, so clean.names is always ''. Omitting the key
        // (rather than passing that '') leaves it `undefined`, which
        // updateEditableFields treats as "not part of this edit" and skips —
        // an existing row's Report Calendar/MIS "Name" column (distinct from
        // Source/Who Sends) survives the edit instead of being blanked out.
        await sheets.updateEditableFields(tabName, rowIndex, {
          taskDescription: clean.taskDescription,
          assignedTo: clean.assignedTo,
          emailId: clean.emailId,
          taskType: clean.taskType,
          dateAssigned: clean.dateAssigned,
          dueDate: clean.dueDate,
        });
      } catch (err: any) {
        return {
          status: 502,
          body: {
            error: internalError(
              `Sheet write failed (edit, ${tabName} row ${rowIndex})`,
              err,
              'Could not save the edit to the Sheet — see the dashboard server log.'
            ),
          },
        };
      }

      sheetCache = null; // Step 2 — next read reflects the edit, not the 15s-old cache

      // Best-effort DB mirror — the Sheet write already succeeded and is authoritative.
      const mirror = await safeQuery(
        `UPDATE tasks SET task_description=$1, assigned_to=$2, email_id=$3, task_type=$4, date_assigned=$5, due_date=$6, updated_at=NOW()
         WHERE tab_name=$7 AND row_index=$8`,
        [clean.taskDescription, clean.assignedTo, clean.emailId, clean.taskType, clean.dateAssigned, clean.dueDate, tabName, rowIndex]
      );

      return { status: 200, body: { ok: true, tabName, rowIndex, dbWarning: mirror.error } };
    },
  },

  // POST /api/tasks/reviewed — the dashboard-only "Mark reviewed" bookkeeping
  // toggle (see reviewed_tasks in schema.sql). Purely organizational: it never
  // touches the Sheet, classification, or reminders — only which section of the
  // dashboard a row currently renders in.
  {
    method: 'POST',
    pattern: /^\/api\/tasks\/reviewed$/,
    handler: async ({ req }) => {
      const body = await readBody(req);
      const tabName = scalarText(body.tab);
      const rowIndex = Number(body.rowIndex);
      if (!tabName) return { status: 400, body: { error: 'tab is required.' } };
      if (!Number.isInteger(rowIndex) || rowIndex < 1) {
        return { status: 400, body: { error: 'rowIndex is required and must be a positive whole number.' } };
      }
      const markReviewed = body.reviewed !== false;

      // Confirm the row actually exists (valid or Needs Attention) before
      // recording a mark against it — otherwise a stale/malformed task_key would
      // sit in this table forever with no real row to ever match it back to.
      const { tasks: all } = await readSheet();
      if (!all.some(t => t.tabName === tabName && t.rowIndex === rowIndex)) {
        return { status: 404, body: { error: `Row ${rowIndex} not found on "${tabName}".` } };
      }

      const taskKey = `${tabName}|${rowIndex}`;
      const result = markReviewed
        ? await safeQuery(
            `INSERT INTO reviewed_tasks (task_key, reviewed_at) VALUES ($1, NOW())
             ON CONFLICT (task_key) DO UPDATE SET reviewed_at = NOW()
             RETURNING reviewed_at`,
            [taskKey]
          )
        : await safeQuery(`DELETE FROM reviewed_tasks WHERE task_key = $1`, [taskKey]);

      if (result.error) return { status: 503, body: { error: result.error } };
      return {
        status: 200,
        body: { ok: true, tabName, rowIndex, reviewed: markReviewed, reviewedAt: result.rows[0]?.reviewed_at || null },
      };
    },
  },

  // GET /api/attachment?messageId=&attachmentId=&filename= — stream a Gmail
  // attachment. Gmail attachment bytes need an authenticated API call, so the
  // dashboard proxies them rather than linking somewhere the browser can't reach.
  {
    method: 'GET',
    pattern: /^\/api\/attachment$/,
    handler: async ({ url }) => {
      const messageId = url.searchParams.get('messageId') || '';
      const attachmentId = url.searchParams.get('attachmentId') || '';
      if (!messageId || !attachmentId) {
        return { status: 400, body: { error: 'messageId and attachmentId are both required.' } };
      }
      try {
        const data = await gmail.getAttachment(messageId, attachmentId);
        // Signalled to the request handler, which streams bytes instead of JSON.
        return { body: { __binary: data, filename: url.searchParams.get('filename') || 'attachment' } };
      } catch (err: any) {
        // Without this branch every Gmail failure fell through to the generic
        // "Something went wrong" — accurate but useless, because the two failures
        // that actually happen here are both diagnosable and one of them is fixed
        // by a single command. The distinction is safe to expose: it names a
        // condition and a remedy, never a credential, host or stack frame (those
        // still go to the server log only, via internalError).
        const raw = String(err?.message || err);

        if (/invalid_grant|invalid_token|unauthorized_client/i.test(raw)) {
          return {
            status: 502,
            body: {
              error: internalError(
                `Attachment download failed — Gmail auth (message ${messageId})`,
                err,
                'Gmail authentication failed: the refresh token is expired or revoked. ' +
                  'Attachments cannot be fetched until it is renewed — run "npm run auth:gmail" ' +
                  'and put the new GMAIL_REFRESH_TOKEN in .env.'
              ),
            },
          };
        }

        // A Gmail attachment id is only valid for the message that owns it, and
        // both disappear if the message is deleted. That is a permanent condition
        // for this row, not a transient server fault, so it is a 404 rather than
        // a 502 an operator might otherwise sit and retry.
        if (/not\s*found|notFound|\b404\b/i.test(raw)) {
          return {
            status: 404,
            body: {
              error: internalError(
                `Attachment no longer in Gmail (message ${messageId})`,
                err,
                'Gmail no longer has this attachment — the message was most likely deleted from the mailbox.'
              ),
            },
          };
        }

        throw err; // anything unrecognised keeps the generic message + full server log
      }
    },
  },

  // GET /api/stats — per-employee metrics from live sheet rows + reminder counts
  {
    method: 'GET',
    pattern: /^\/api\/stats$/,
    handler: async () => {
      const { tasks: all } = await readSheet();
      const reminders = await safeQuery(
        `SELECT LOWER(recipient_email) AS email, COUNT(*)::int AS count
         FROM reminder_logs WHERE status = 'SENT' GROUP BY 1`
      );
      const counts: Record<string, number> = {};
      for (const r of reminders.rows) counts[r.email] = r.count;

      // Every valid row from every readable tab — Staff Tracker, Report Calendar,
      // and both MIS registers — so an employee's totalTasks reflects their real
      // workload, not just their Report-Calendar-only subset. MIS rows are all
      // still "Pending" today (nothing has classified them live yet, per the
      // --i-mean-it guard), so they surface here as real, correctly-uncounted
      // Pending load — not on-time/late/overdue noise, and not silently dropped.
      const stats = EmployeeStatsAggregator.calculateStats(all, counts);
      stats.sort((a, b) => b.overdueCount - a.overdueCount || b.totalTasks - a.totalTasks);
      return { body: { stats, dbWarning: reminders.error } };
    },
  },

  // GET /api/approvals
  {
    method: 'GET',
    pattern: /^\/api\/approvals$/,
    handler: async () => {
      const result = await safeQuery(
        `SELECT run_id, status, summary_text, created_at, expires_at, resent_at,
                COALESCE(jsonb_array_length(reminders_json), 0) AS reminder_count
         FROM approval_requests ORDER BY created_at DESC`
      );
      return { body: { approvals: result.rows, dbWarning: result.error } };
    },
  },

  // POST /api/approvals/:runId/approve — shares the exact CLI code path
  {
    method: 'POST',
    pattern: /^\/api\/approvals\/([^/]+)\/approve$/,
    handler: async ({ params }) => {
      const runId = decodeURIComponent(params[0]);
      const result = await approveAndDispatchRun(runId);
      return { status: result.success ? 200 : 400, body: result };
    },
  },

  // POST /api/staff-reminders/preview — build the exact email(s) that would be
  // sent for the given Staff Tracker rows. No draft, no DB write; pure preview.
  {
    method: 'POST',
    pattern: /^\/api\/staff-reminders\/preview$/,
    handler: async ({ req }) => {
      const body = await readBody(req);
      // Non-numeric/negative entries are dropped rather than passed through as
      // NaN — this is a read-only preview, but a bad rowIndex still must not
      // reach `.find(r => r.rowIndex === NaN)` and produce confusing output.
      const rowIndexes: number[] = Array.isArray(body.rowIndexes)
        ? body.rowIndexes.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
        : [];
      if (rowIndexes.length === 0) {
        return { status: 400, body: { error: 'rowIndexes must be a non-empty array of positive whole numbers.' } };
      }

      const staff = await sheets.readStaffTracker();
      const skipped: Array<{ rowIndex: number; reason: string }> = [];
      const candidates: Array<{ recipientEmail: string; recipientName: string; item: DigestItem }> = [];

      for (const rowIndex of rowIndexes) {
        const row = staff.rows.find(r => r.rowIndex === rowIndex);
        if (!row) {
          // Rows failing the safety filter (missing Email ID / Date Assigned, or
          // own-mailbox) never appear in staff.rows, so they land here — this is
          // the same filter the rest of the app already applies, not a new one.
          skipped.push({ rowIndex, reason: 'Row is missing or excluded by the safety filter (see Needs Attention).' });
          continue;
        }

        // remindersThisPeriod is passed as 0 deliberately: a manual send is the
        // operator's own explicit decision, so the 10-per-period cap — aimed at
        // unattended repetition — does not gate it. Suppression and "already
        // Received" still apply, because those are about the row itself, not
        // about how often we have mailed.
        const eligibility = CadenceEngine.evaluateDigestEligibility(row.status, row.taskType, row.dueDate, 0);

        if (!eligibility.eligible) {
          skipped.push({ rowIndex, reason: eligibility.reason });
          continue;
        }

        candidates.push({
          recipientEmail: row.emailId,
          recipientName: row.assignedTo,
          item: {
            tabName: CONFIG.STAFF_TRACKER_TAB,
            rowIndex: row.rowIndex,
            taskDescription: row.taskDescription,
            dueLabel: row.dueDate,
            overdueDays: eligibility.overdueDays,
          },
        });
      }

      // One preview per recipient, matching the digest the automated side sends:
      // selecting three tasks that belong to the same person produces ONE
      // editable email, not three.
      const byRecipient = new Map<string, { recipientName: string; recipientEmail: string; items: DigestItem[] }>();
      for (const c of candidates) {
        const key = c.recipientEmail.trim().toLowerCase();
        if (!byRecipient.has(key)) {
          byRecipient.set(key, { recipientName: c.recipientName, recipientEmail: c.recipientEmail, items: [] });
        }
        byRecipient.get(key)!.items.push(c.item);
      }

      const previews = [...byRecipient.values()].map(g => {
        const { subject, body } = buildDigestContent(g.recipientName, g.items);
        return {
          tabName: CONFIG.STAFF_TRACKER_TAB,
          recipientName: g.recipientName,
          recipientEmail: g.recipientEmail,
          reminderType: 'DAILY_DIGEST',
          items: g.items,
          rowIndexes: g.items.map(i => i.rowIndex),
          subject,
          body,
        };
      });

      return { body: { previews, skipped } };
    },
  },

  // POST /api/staff-reminders/send — dispatch operator-approved/edited emails
  // directly via Gmail. No draft step, no approval_requests row: the operator
  // reviewing this exact preview screen and clicking send IS the approval.
  {
    method: 'POST',
    pattern: /^\/api\/staff-reminders\/send$/,
    handler: async ({ req }) => {
      const body = await readBody(req);
      // Each entry is ONE digest email covering `rowIndexes` rows.
      const digests: Array<{
        rowIndexes: number[];
        recipientEmail: string;
        subject: string;
        body: string;
        reminderType?: string;
      }> = Array.isArray(body.items) ? body.items : [];
      if (digests.length === 0) {
        return { status: 400, body: { error: 'items must be a non-empty array.' } };
      }
      // Each entry below triggers a real, sequential Gmail send — unlike a read,
      // this has a genuine per-item cost and an irreversible effect. Capped the
      // same way every other batch-shaped operation in this codebase already is.
      if (isOversizedDigestBatch(digests.length)) {
        return {
          status: 400,
          body: { error: `items must be ${MAX_STAFF_DIGEST_BATCH} or fewer per request (got ${digests.length}).` },
        };
      }

      const results: any[] = [];
      for (const digest of digests) {
        // scalarText on every field: this endpoint sends real mail, so an
        // object-shaped field must be rejected here, not reach .trim() and 500
        // halfway through a batch that has already sent some of its messages.
        const recipientEmail = scalarText(digest.recipientEmail);
        const subject = scalarText(digest.subject);
        const emailBody = scalarText(digest.body);
        const rowIndexes = Array.isArray(digest.rowIndexes)
          ? digest.rowIndexes.map(Number).filter(n => Number.isInteger(n) && n > 0)
          : [];

        if (recipientEmail === null || subject === null || emailBody === null) {
          results.push({ recipientEmail: '', rowIndexes, sent: false, error: 'Recipient, subject and body must all be text.' });
          continue;
        }
        if (!recipientEmail || !subject || !emailBody) {
          results.push({ recipientEmail, rowIndexes, sent: false, error: 'Missing recipient, subject, or body.' });
          continue;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
          results.push({ recipientEmail, rowIndexes, sent: false, error: `"${recipientEmail}" is not a valid email address.` });
          continue;
        }

        let messageId: string | undefined;
        let sendError: string | undefined;
        try {
          messageId = await gmail.sendEmail(recipientEmail, subject, emailBody);
          if (!messageId) throw new Error('Gmail accepted the request but returned no message id');
        } catch (err: any) {
          sendError = internalError(
            `Manual staff reminder to ${recipientEmail} failed`,
            err,
            'Send failed — see the dashboard server log.'
          );
        }

        // One log row per row covered by this digest — same table, same fields as
        // the automated pipeline, no new schema. All rows share the one message_id
        // because they were genuinely delivered in a single email. run_id stays
        // NULL: this send was never part of a scheduled run or approval_requests.
        for (const rowIndex of rowIndexes) {
          const taskKey = reminderKey(CONFIG.STAFF_TRACKER_TAB, rowIndex);
          try {
            await db.query(
              `INSERT INTO reminder_logs (task_key, recipient_email, reminder_type, status, message_id, error_text, sent_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [taskKey, recipientEmail, digest.reminderType || 'MANUAL_STAFF_DIGEST', messageId ? 'SENT' : 'FAILED', messageId || null, sendError || null]
            );
          } catch (logErr: any) {
            console.warn(`⚠️ Could not log manual send for ${taskKey}: ${logErr.message}`);
          }
        }

        results.push({ recipientEmail, rowIndexes, sent: Boolean(messageId), messageId, error: sendError });
      }

      const sentCount = results.filter(r => r.sent).length;
      return { body: { results, sentCount, failedCount: results.length - sentCount } };
    },
  },

  // GET /api/directory
  {
    method: 'GET',
    pattern: /^\/api\/directory$/,
    handler: async () => {
      const result = await safeQuery(
        `SELECT id, name, email, department, created_at FROM employees ORDER BY name ASC`
      );
      return { body: { employees: result.rows, dbWarning: result.error } };
    },
  },

  // POST /api/directory — upsert an employee
  {
    method: 'POST',
    pattern: /^\/api\/directory$/,
    handler: async ({ req }) => {
      const body = await readBody(req);
      const name = scalarText(body.name);
      const email = scalarText(body.email);
      const department = scalarText(body.department);
      const errors: Record<string, string> = {};
      if (name === null) errors.name = 'name must be text, not an object or array.';
      else if (!name) errors.name = 'Name is required.';
      else if (name.length > MAX_TEXT_LENGTH) errors.name = `Name is too long (max ${MAX_TEXT_LENGTH} characters).`;
      if (email === null) errors.email = 'email must be text, not an object or array.';
      else if (!email) errors.email = 'Email is required.';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = `"${email}" is not a valid email address.`;
      if (department && department.length > MAX_TEXT_LENGTH) errors.department = `Department is too long (max ${MAX_TEXT_LENGTH} characters).`;
      if (Object.keys(errors).length) return { status: 400, body: { errors } };

      try {
        const result = await upsertEmployee(db, { name: name!, email: email!, department: department || 'Finance' });
        return { status: 201, body: { employee: result.rows[0] } };
      } catch (err: any) {
        return {
          status: 503,
          body: { errors: { email: internalError(`Directory upsert failed (${email})`, err, 'Database unavailable — see the dashboard server log.') } },
        };
      }
    },
  },

  // GET /api/reminder-logs
  {
    method: 'GET',
    pattern: /^\/api\/reminder-logs$/,
    handler: async () => {
      // Row identity comes from task_key ("<tab>|<rowIndex>"), the same physical
      // sheet row every other view shows. The old join went through tasks.id,
      // which the pipeline never populates — so tab/row rendered blank on every
      // line. task_key is split here so the client gets ready-to-display fields.
      const result = await safeQuery(
        `SELECT r.id, r.recipient_email, r.reminder_type, r.status, r.draft_id,
                r.message_id, r.error_text, r.sent_at, r.run_id, r.task_key,
                split_part(r.task_key, '|', 1) AS tab_name,
                NULLIF(split_part(r.task_key, '|', 2), '')::int AS row_index,
                t.task_description
         FROM reminder_logs r
         LEFT JOIN tasks t ON t.id = r.task_id
         ORDER BY r.sent_at DESC NULLS LAST, r.id DESC
         LIMIT 200`
      );
      return { body: { logs: result.rows, dbWarning: result.error } };
    },
  },
  // GET /api/chat?sessionId=… — this session's retained conversation.
  //
  // Session-scoped rather than "everything in the last 24 hours": rows older than
  // 24h are deleted by the pipeline's cleanup, so a session's own history IS its
  // last-24-hours window, and showing another browser tab's conversation here
  // would be surprising rather than useful.
  {
    method: 'GET',
    pattern: /^\/api\/chat$/,
    handler: async ({ url }) => {
      const sessionId = url.searchParams.get('sessionId') || '';
      if (!isValidSessionId(sessionId)) return { status: 400, body: { error: 'A valid sessionId (UUID) is required.' } };
      const result = await safeQuery(
        `SELECT role, content, created_at FROM chat_messages
          WHERE session_id = $1 ORDER BY created_at ASC, id ASC LIMIT 200`,
        [sessionId]
      );
      return {
        body: {
          messages: result.rows.map(r => ({ role: r.role, content: r.content, createdAt: r.created_at })),
          dbWarning: result.error,
        },
      };
    },
  },

  // POST /api/chat — one assistant turn.
  //
  // Reads ONLY what this process already has: readSheet() is the same memoised
  // 15-second cache /api/tasks and /api/stats share, so a chat turn normally
  // costs zero Sheet calls, and there is deliberately no Gmail call anywhere on
  // this path — every attachment fact the assistant can state was already
  // written to submissions.attachment_summary by the pipeline.
  {
    method: 'POST',
    pattern: /^\/api\/chat$/,
    handler: async ({ req }) => {
      const body = await readBody(req);
      const message = cleanMessage(body?.message);
      const sessionId = body?.sessionId;

      if (!isValidSessionId(sessionId)) return { status: 400, body: { error: 'A valid sessionId (UUID) is required.' } };
      if (!message) {
        return { status: 400, body: { error: `Ask a question of 1 to ${MAX_MESSAGE_CHARS} characters.` } };
      }

      // Sheet rows and DB context load together; neither depends on the other.
      const [sheet, dbCtx, history] = await Promise.all([
        readSheet().catch(err => {
          console.error('❌ Chat context: sheet read failed:', err?.stack || err?.message || err);
          return { tasks: [] as UnifiedTask[], sourceErrors: {} as Record<string, string> };
        }),
        loadDbContext(safeQuery),
        loadHistory(safeQuery, sessionId),
      ]);

      const toContextTask = (t: UnifiedTask): ContextTask => ({
        tabName: t.tabName,
        rowIndex: t.rowIndex,
        name: t.taskDescriptionOrName || '',
        assignedTo: t.assignedToName || '',
        email: t.emailId || '',
        dueDate: t.dueDate || '',
        status: t.currentStatus || '',
        overdueDays: String(t.daysOrOverdueDays ?? ''),
        isValid: t.isValid !== false,
      });

      const ctx: ChatContext = {
        ...dbCtx,
        tasks: sheet.tasks.filter(t => t.isValid !== false).map(toContextTask),
        needsAttention: sheet.tasks.filter(t => t.isValid === false).map(toContextTask),
        // A tab that could not be read is a stated gap, not a silent omission —
        // otherwise "nothing overdue in MIS" and "MIS unreadable" look identical.
        warnings: [...dbCtx.warnings, ...Object.keys(sheet.sourceErrors).map(tab => `The sheet tab "${tab}" could not be read`)],
      };

      const reply = await askGemini(buildChatPrompt(ctx, history, message));

      // Both turns are persisted AFTER the reply exists, in one statement, so a
      // failed call never leaves a user message hanging with no answer beside it.
      // Conversation text only — no email bodies, no attachment bytes.
      const saved = await safeQuery(
        `INSERT INTO chat_messages (session_id, role, content)
         VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
        [sessionId, message, reply]
      );
      if (saved.error) console.warn(`⚠️ Chat turn not persisted for session ${sessionId} — the next turn will lack this context.`);

      return { body: { reply, sessionId } };
    },
  },

];

// --- server ----------------------------------------------------------------

// Every route handler already runs inside its own try/catch, so a route can't
// crash the process. These two cover the rest: a rejected promise nothing awaits
// (fire-and-forget), or a throw outside any handler. Without them Node kills the
// whole server on the first one — every in-flight request and every scheduled
// run sharing this process goes down with it. Logged loudly so a scheduled run
// reading these logs sees it, not just an interactive operator watching the console.
process.on('unhandledRejection', (reason: any) => {
  console.error('❌ UNHANDLED REJECTION (server kept running):', reason?.stack || reason);
});
process.on('uncaughtException', (err: any) => {
  console.error('❌ UNCAUGHT EXCEPTION (server kept running):', err?.stack || err);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const method = req.method || 'GET';

  const json = (status: number, body: any) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // Gate on Basic Auth before anything else — including the static page, so the
  // dashboard shell itself isn't served to an unauthenticated caller. The
  // WWW-Authenticate header is what makes the browser show its native login
  // prompt instead of a bare 401 page.
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'WWW-Authenticate': 'Basic realm="CFO Command Centre", charset="UTF-8"',
    });
    return res.end(JSON.stringify({ error: 'Unauthorized.' }));
  }

  // CSRF mitigation: the browser resends cached Basic Auth credentials to this
  // origin automatically from ANY page, including a hostile one — passing
  // isAuthorized() above proves nothing about who INITIATED the request. Origin
  // cannot be forged by page-level JS, so a mismatched one on a state-changing
  // request is rejected here, independent of whether its credentials were
  // valid. GETs are left alone — they don't change state, so there is nothing
  // for a forged cross-site request to gain by sending one.
  if (method === 'POST' && !isAllowedOrigin(req.headers.origin, req.headers.host || '')) {
    return json(403, { error: 'Cross-origin request rejected.' });
  }

  // Match on path first, then method — several paths carry both a GET and a POST,
  // so a method mismatch on one route must not shadow the sibling that fits.
  const pathMatches = routes
    .map(route => ({ route, match: url.pathname.match(route.pattern) }))
    .filter((m): m is { route: typeof routes[number]; match: RegExpMatchArray } => m.match !== null);

  if (pathMatches.length) {
    const hit = pathMatches.find(m => m.route.method === method);
    if (!hit) return json(405, { error: `${method} not allowed on ${url.pathname}` });
    try {
      const { status = 200, body } = await hit.route.handler({ url, req, params: hit.match.slice(1) });
      if (body && body.__binary) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${String(body.filename).replace(/"/g, '')}"`,
          'Content-Length': body.__binary.length,
        });
        return res.end(body.__binary);
      }
      return json(status, body);
    } catch (err: any) {
      // BadRequest carries a message written for the client (from readBody).
      // Everything else is unexpected — the full error goes to the server log
      // only; the client gets a generic message, never a raw exception string.
      if (err instanceof BadRequest) {
        return json(400, { error: err.message });
      }
      return json(500, { error: internalError(`${method} ${url.pathname}`, err) });
    }
  }

  if (url.pathname.startsWith('/api/')) return json(404, { error: `No such endpoint: ${url.pathname}` });

  // Everything else: the single-page app.
  try {
    const html = fs.readFileSync(path.join(HERE, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Could not load dashboard shell: ${err.message}`);
  }
});

// All interfaces, not 127.0.0.1: a hosted deployment (Render, etc.) is reached
// via its container's network interface, not loopback — binding to loopback
// there makes the service unreachable, not "secure". Basic Auth above is what
// now enforces access instead; put Render's own IP allowlist / private
// networking in front of this too where available, defense in depth.
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n======================================================');
  console.log('📊 CFO COMMAND CENTRE — DASHBOARD');
  console.log('======================================================');
  console.log(`   Open:     http://localhost:${PORT}  (Basic Auth required — DASHBOARD_USER / DASHBOARD_PASSWORD)`);
  console.log(`   Sheet:    ${CONFIG.GOOGLE_SHEET_ID}`);
  console.log(`   Service account key: ${fs.existsSync(path.resolve(CONFIG.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) ? '✅ found' : '❌ missing (task views will error)'}`);
  console.log(`   Database: ${CONFIG.DATABASE_URL ? 'configured' : '❌ not configured (approvals/directory/logs will be empty)'}`);
  console.log('======================================================\n');
});
