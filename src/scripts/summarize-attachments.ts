/**
 * Daily pass that reads yesterday's .xlsx submissions and summarises what is
 * actually inside them.
 *
 * The pipeline records a filename-and-covering-note guess when it matches a
 * submission (see recordSubmission). That guess is cheap and immediate but blind:
 * it cannot say which months a workbook covers or what the totals look like. This
 * script downloads the file, reads the cells, and replaces the guess with a real
 * summary — marking the row summary_from_file_content = TRUE so it is never
 * downgraded or paid for twice.
 *
 * Designed to be run unattended:
 *   * one Gemini call per DISTINCT submission, not per duplicate row
 *   * only .xlsx; every other format is skipped and counted
 *   * every per-row failure is caught, logged and stepped over
 *   * a final tally, so a run that did nothing cannot look like a run that worked
 *
 * Usage:
 *   npm run summarize:attachments                 # last 24 hours (the daily job)
 *   npm run summarize:attachments -- --hours 72   # wider window, e.g. after an outage
 *   npm run summarize:attachments -- --all        # every un-read .xlsx ever recorded
 */
import { GmailClient } from '../google/gmail.js';
import { DatabaseClient } from '../db/client.js';
import { CONFIG } from '../config/index.js';
import { summarizeExcelAttachment, isSupportedSpreadsheet } from '../classifier/gemini-summarizer.js';

/** How far back the daily run looks. One day, with the schedule running daily. */
const DEFAULT_WINDOW_HOURS = 24;

interface AttachmentMeta {
  filename?: string;
  attachmentId?: string;
  messageId?: string;
  mimeType?: string;
}

function parseArgs(argv: string[]): { windowHours: number | null } {
  if (argv.includes('--all')) return { windowHours: null };
  const i = argv.indexOf('--hours');
  if (i !== -1) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return { windowHours: n };
    console.warn(`⚠️ --hours "${argv[i + 1]}" is not a positive number — using the ${DEFAULT_WINDOW_HOURS}h default.`);
  }
  return { windowHours: DEFAULT_WINDOW_HOURS };
}

async function main() {
  const { windowHours } = parseArgs(process.argv.slice(2));

  console.log('\n======================================================');
  console.log('📄 EXCEL ATTACHMENT SUMMARISER');
  console.log('======================================================');
  console.log(`   Scope : ${windowHours === null ? 'every un-read .xlsx submission' : `submissions received in the last ${windowHours}h`}`);
  console.log(`   Model : Gemini (file contents, not filename)`);

  const db = new DatabaseClient();
  if (!db.getPool()) {
    console.error('❌ DATABASE_URL is not configured — there is no submissions table to read. Nothing done.');
    process.exit(1);
  }
  // Checked up front rather than per row: without a key every summary comes back
  // null, so the run would spend a Gmail download per file to achieve nothing.
  if (!CONFIG.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not configured — no summary can be generated. Nothing done.');
    console.error('   Set it in .env (see .env.example) and re-run.');
    process.exit(1);
  }

  const gmail = new GmailClient();

  // DISTINCT ON (task_key, message_id): the pipeline appends a fresh submissions
  // row every run that re-matches the same email, so the raw table holds each
  // submission many times over. Summarising per row would multiply the Gemini and
  // Gmail cost by that duplication for identical output.
  //
  // summary_from_file_content = FALSE is the "not yet read for real" filter: rows
  // already summarised from actual cell values are left completely alone.
  const windowClause = windowHours === null ? '' : `AND s.date_received >= NOW() - ($1 || ' hours')::interval`;
  const params = windowHours === null ? [] : [String(windowHours)];

  const { rows } = await db.query(
    `SELECT DISTINCT ON (s.task_key, s.message_id)
            s.task_key, s.message_id, s.subject, s.date_received, s.attachments_json
       FROM submissions s
      WHERE s.attachments_json IS NOT NULL
        AND jsonb_array_length(s.attachments_json) > 0
        AND COALESCE(s.summary_from_file_content, FALSE) = FALSE
        ${windowClause}
      ORDER BY s.task_key, s.message_id, s.date_received DESC`,
    params
  );

  console.log(`   Found : ${rows.length} candidate submission(s)\n`);

  let succeeded = 0;
  let failed = 0;
  let skippedFormat = 0;
  let rowsUpdated = 0;

  for (const row of rows) {
    const attachments: AttachmentMeta[] = row.attachments_json || [];
    const label = `${row.task_key} (${new Date(row.date_received).toISOString().slice(0, 10)})`;

    // Only the first .xlsx is summarised. The stored summary is one paragraph
    // about "this submission", and stitching several workbooks into it would make
    // it impossible to tell which figures came from which file.
    const target = attachments.find(a => isSupportedSpreadsheet(a?.filename || ''));
    if (!target) {
      const names = attachments.map(a => a?.filename || '(unnamed)').join(', ');
      console.log(`⏭️  ${label} — skipped: unsupported format (${names})`);
      skippedFormat++;
      continue;
    }

    const filename = target.filename || '(unnamed)';
    console.log(`📊 ${label} — reading "${filename}"`);

    // The attachment's own messageId is preferred: an attachment id is only
    // meaningful together with the message it belongs to, and the submission's
    // message_id is the same value for every attachment recorded against it.
    const messageId = target.messageId || row.message_id;

    let summary: string | null = null;
    try {
      summary = await summarizeExcelAttachment(
        gmail,
        messageId,
        target.attachmentId || '',
        filename,
        row.subject || ''
      );
    } catch (err: any) {
      // summarizeExcelAttachment already swallows its own failures; this is the
      // backstop for anything unforeseen, so one bad row cannot end the run.
      console.warn(`   ⚠️ Unexpected error: ${err?.message || err}`);
    }

    if (!summary) {
      console.log(`   ❌ no summary produced — left as-is for the next run`);
      failed++;
      continue;
    }

    try {
      // Every duplicate row of this submission gets the same value, so the
      // dashboard shows identical text whichever one it happens to read.
      const upd = await db.query(
        `UPDATE submissions
            SET attachment_summary = $1, summary_from_file_content = TRUE
          WHERE task_key = $2 AND message_id = $3
          RETURNING id`,
        [summary, row.task_key, row.message_id]
      );
      rowsUpdated += upd.rows.length;
      succeeded++;
      console.log(`   ✅ summarised from file contents (${summary.length} chars, ${upd.rows.length} row(s) updated)`);
    } catch (err: any) {
      // The summary was generated but could not be stored. Counted as a failure:
      // the row still has no real summary, and the next run must retry it.
      console.warn(`   ⚠️ Summary generated but the database write failed: ${err?.message || err}`);
      failed++;
    }
  }

  console.log('\n------------------------------------------------------');
  console.log(`Processed : ${rows.length} submission(s)`);
  console.log(`Succeeded : ${succeeded}  (${rowsUpdated} database row(s) updated)`);
  console.log(`Failed    : ${failed}`);
  console.log(`Skipped   : ${skippedFormat}  (no .xlsx attachment)`);
  console.log('------------------------------------------------------');
  console.log('✅ Attachment summarisation complete.\n');

  // Exit 0 even with per-row failures: a deleted message or an unparseable
  // workbook is an expected outcome, not a broken run, and a non-zero code here
  // would make the scheduled task cry wolf every day. Genuine misconfiguration
  // (no database, no API key) exits non-zero above, before any work is attempted.
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Attachment summariser failed:', err?.stack || err?.message || err);
  process.exit(1);
});
