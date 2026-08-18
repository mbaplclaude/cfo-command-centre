/**
 * Per-row reminder history, used to throttle cadence.
 *
 * `CadenceEngine` needs to know how many reminders a row already got today.
 * Previously that count was hardcoded to 0 at the call site, so every pipeline
 * run re-issued the same reminders — which also meant the live run produced a
 * second set of 9 Gmail drafts rather than recognising the first set existed.
 *
 * Reminders are logged at DRAFT time, not send time: with REQUIRE_APPROVAL on, a
 * draft may sit unapproved for hours, and re-drafting it on every run is the
 * duplicate we are trying to prevent.
 */
import { DatabaseClient } from './client.js';
import { DraftReminderItem } from '../channels/interface.js';
import { CHRONIC_REMINDER_CAP } from '../classifier/cadence.js';
import { summarizeAttachment } from '../classifier/gemini-summarizer.js';

/**
 * How many reminders were drafted or sent for each row today, keyed by
 * "<tab>|<rowIndex>" — a stable identity that does not depend on the sheet's
 * optional "#" column being filled in.
 */
/** Raised when reminder history is unavailable, so callers halt instead of over-sending. */
export class ThrottleUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `Cannot read reminder history, so reminder throttling and the per-period cap ` +
        `cannot be enforced: ${reason}\n` +
        `   Halting rather than proceeding — without this history the run would re-send ` +
        `every reminder issued today and ignore the ${CHRONIC_REMINDER_CAP}-reminder cap.\n` +
        `   Fix DATABASE_URL (or database connectivity) and re-run.`
    );
    this.name = 'ThrottleUnavailableError';
  }
}

/**
 * Every reminder timestamp per row for the last 180 days.
 *
 * Throws rather than degrading: a throttle that silently reads as "nothing sent
 * yet" turns into "send everything again", which is precisely the duplicate-send
 * failure this project has already hit twice.
 */
export async function getReminderHistory(db: DatabaseClient): Promise<Map<string, Date[]>> {
  if (!db.getPool()) {
    throw new ThrottleUnavailableError('DATABASE_URL is not configured');
  }

  const history = new Map<string, Date[]>();
  let result;
  try {
    result = await db.query(
      `SELECT task_key, sent_at
         FROM reminder_logs
        WHERE task_key IS NOT NULL
          AND sent_at >= NOW() - INTERVAL '180 days'
        ORDER BY sent_at DESC`
    );
  } catch (err: any) {
    throw new ThrottleUnavailableError(err.message);
  }

  for (const row of result.rows) {
    const key = row.task_key as string;
    if (!history.has(key)) history.set(key, []);
    history.get(key)!.push(new Date(row.sent_at));
  }
  return history;
}

/** Reminders issued for a row since local midnight today. */
export function countToday(timestamps: Date[] | undefined): number {
  if (!timestamps) return 0;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return timestamps.filter(t => t >= startOfToday).length;
}

/** Reminders issued for a row since the start of its current period. */
export function countSince(timestamps: Date[] | undefined, periodStart: Date): number {
  if (!timestamps) return 0;
  if (isNaN(periodStart.getTime())) return timestamps.length; // no period -> count all
  return timestamps.filter(t => t >= periodStart).length;
}

/** Stable per-row key shared by the writer and the reader above. */
export function reminderKey(tabName: string, rowIndex: number): string {
  return `${tabName}|${rowIndex}`;
}

/**
 * Record a matched submission so the dashboard can link to its Gmail thread and
 * attachments. The Sheet has nowhere to put attachment metadata, so this table is
 * the only place that information can live.
 *
 * This is also where the attachment summary is generated — exactly once, at the
 * moment a submission is matched. Doing it here rather than at each call site
 * covers both writers (the pipeline in agent.ts and the dashboard's Task Type
 * re-evaluation) from one place, and this function already receives the only
 * three inputs the summariser needs: subject, snippet and filenames.
 *
 * The summary is best-effort by construction: summarizeAttachment() returns null
 * for a missing GEMINI_API_KEY, an attachment-less email or a failed call, and
 * that null is simply stored, leaving the dashboard to show nothing. A summary is
 * never allowed to be the reason a submission goes unrecorded.
 */
export async function recordSubmission(
  db: DatabaseClient,
  submission: {
    tabName: string;
    rowIndex: number;
    senderEmail: string;
    messageId: string;
    threadId: string;
    subject: string;
    dateReceived: Date;
    classification: string;
    remarks: string;
    snippet: string;
    attachments: unknown[];
  }
): Promise<{ error?: string }> {
  if (!db.getPool()) return { error: 'DATABASE_URL not configured' };

  const attachments = (submission.attachments || []) as Array<{ filename?: string }>;
  const attachmentSummary = await summarizeAttachment(
    submission.subject,
    submission.snippet,
    attachments.map(a => a?.filename || '')
  );

  try {
    await db.query(
      `INSERT INTO submissions
         (task_key, sender_email, message_id, thread_id, subject, date_received,
          classification, remarks, raw_snippet, attachments_json, attachment_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        reminderKey(submission.tabName, submission.rowIndex),
        submission.senderEmail,
        submission.messageId,
        submission.threadId,
        submission.subject,
        submission.dateReceived.toISOString(),
        submission.classification,
        submission.remarks,
        submission.snippet,
        JSON.stringify(submission.attachments || []),
        attachmentSummary,
      ]
    );
    return {};
  } catch (err: any) {
    return { error: err.message };
  }
}

/** Record drafted reminders so the next run does not re-draft them the same day. */
export async function logDraftedReminders(
  db: DatabaseClient,
  reminders: DraftReminderItem[],
  runId: string
): Promise<{ logged: number; error?: string }> {
  if (!db.getPool()) return { logged: 0, error: 'DATABASE_URL not configured' };

  let logged = 0;
  try {
    for (const r of reminders) {
      // One log row per ITEM inside the digest, not per email. The recipient gets
      // a single mail, but each row it covers must record its own occurrence —
      // that is what keeps the per-period cap counting per row rather than
      // per-email, exactly as it did before digests existed.
      for (const item of r.items) {
        await db.query(
          `INSERT INTO reminder_logs (task_key, recipient_email, reminder_type, status, draft_id, sent_at, run_id)
           VALUES ($1, $2, $3, 'DRAFTED', $4, NOW(), $5)`,
          [reminderKey(item.tabName, item.rowIndex), r.recipientEmail, r.reminderType, r.draftId || null, runId]
        );
        logged++;
      }
    }
  } catch (err: any) {
    return { logged, error: err.message };
  }
  return { logged };
}

/**
 * Drop the DRAFTED throttle entries belonging to an abandoned run.
 *
 * When a run is superseded its drafts will never be dispatched, so leaving their
 * throttle entries in place would suppress the replacement run's reminders.
 * Deliberately narrow: only DRAFTED rows, only for that run — a SENT row records
 * a real email and must never be erased.
 */
export async function discardDraftedRemindersForRun(
  db: DatabaseClient,
  runId: string
): Promise<{ removed: number }> {
  const result = await db.query(
    `DELETE FROM reminder_logs WHERE run_id = $1 AND status = 'DRAFTED' RETURNING id`,
    [runId]
  );
  return { removed: result.rows.length };
}
