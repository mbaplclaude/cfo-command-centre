/**
 * The per-row "does a Gmail reply satisfy this task?" evaluation.
 *
 * This is the exact logic the pipeline's main loop runs for every row — Gmail
 * search, thread scoping, title-relevance gate, time-boxing, AI classification,
 * attachment gate. Pulled out to its own module so the dashboard's Task Type
 * editor can re-run it for one row immediately after an edit, instead of leaving
 * that row's Status/Remarks stale (computed under the OLD Task Type) until the
 * next scheduled run.
 *
 * Deliberately excludes: writing the result back to the Sheet, recording the
 * submission, and cadence/reminder decisions — those stay with each caller,
 * since what happens after a classification differs (agent.ts also drafts
 * reminders; the dashboard's row re-evaluation only ever writes Status/Remarks).
 */
import { GmailClient } from '../google/gmail.js';
import { LLMReasoner } from '../classifier/llm-reasoner.js';
import { TimeBoxMatcher } from '../classifier/timebox.js';
import { hasTitleOverlap, requireAttachmentForReceived } from '../classifier/relevance.js';
import { GmailMessageSummary, ClassificationResult } from '../types/index.js';

export interface EvalUnit {
  tabName: string;
  rowIndex: number;
  /** Optional: the pipeline carries it for reminder bookkeeping; evaluation never reads it. */
  taskId?: string;
  title: string;
  recipientName: string;
  recipientEmail: string;
  taskType: string;
  /** Gmail search floor and time-box window start. */
  windowStart: string;
  /** Drives the date math — ISO for reports so the time of day survives. */
  dueDate: string;
  /** What a recipient reads; equals dueDate for Staff Tracker rows. */
  dueDateLabel: string;
  currentStatus: string;
  threadId: string;
}

export interface RowEvaluationResult {
  classification: ClassificationResult | null;
  /** The message actually judged — may be an earlier one in the thread. */
  selectedReply: GmailMessageSummary | null;
  matchedReplyCount: number;
}

export async function evaluateRowSubmission(
  unit: EvalUnit,
  deps: { gmailClient: GmailClient; llmReasoner: LLMReasoner },
  log: (line: string) => void = console.log
): Promise<RowEvaluationResult> {
  let matchedReplies: GmailMessageSummary[] = [];
  try {
    matchedReplies = await deps.gmailClient.searchRepliesFrom(unit.recipientEmail, unit.windowStart);
  } catch (err: any) {
    log(`   ⚠️ Gmail search failed for ${unit.recipientEmail}: ${err.message}`);
  }

  // A Gmail search can only filter by sender + date, so every row sharing a
  // sender sees the same replies. When this row already has a Thread ID, scope
  // the match to that thread — otherwise one unrelated reply closes several rows.
  if (unit.threadId && matchedReplies.length > 0) {
    const inThread = matchedReplies.filter(m => m.threadId === unit.threadId);
    if (inThread.length !== matchedReplies.length) {
      log(`   └─ Scoped ${matchedReplies.length} reply(ies) to thread ${unit.threadId} -> ${inThread.length} match(es).`);
    }
    matchedReplies = inThread;
  }

  // Gate 1: the reply must mention something specific to this row's title.
  if (matchedReplies.length > 0) {
    const before = matchedReplies.length;
    const relevant = matchedReplies.filter(m => hasTitleOverlap(unit.title, m).matches);
    if (relevant.length !== before) {
      log(`   └─ Title-relevance filter: ${before} reply(ies) -> ${relevant.length} about "${unit.title}".`);
    }
    matchedReplies = relevant;
  }

  if (matchedReplies.length === 0) {
    return { classification: null, selectedReply: null, matchedReplyCount: 0 };
  }

  // Consider every matched message in the thread, not just the newest one.
  // A submission is often followed by chatter ("thanks", "noted"), so the
  // newest message frequently has no attachment while an earlier one in the
  // same thread carries the actual report. Prefer, in order: in-window with
  // an attachment, then in-window, then newest overall.
  const byNewest = [...matchedReplies].sort((a, b) => b.date.getTime() - a.date.getTime());
  const withWindow = byNewest.map(m => ({
    message: m,
    timebox: TimeBoxMatcher.isWithinWindow(m.date, unit.windowStart, unit.dueDate, unit.taskType),
  }));

  const best =
    withWindow.find(c => c.timebox.isWithin && c.message.hasAttachments) ||
    withWindow.find(c => c.timebox.isWithin) ||
    withWindow[0];

  const selectedReply = best.message;
  const timebox = best.timebox;

  log(`   └─ Found ${matchedReplies.length} reply(ies) in scope. Newest: ${byNewest[0].date.toISOString()}`);
  if (selectedReply.id !== byNewest[0].id) {
    log(`   └─ Selected an earlier message in the thread (${selectedReply.date.toISOString()}) — it is the one carrying the submission.`);
  }
  log(`   └─ Time-box evaluation: ${timebox.reason}`);
  if (selectedReply.attachments.length > 0) {
    log(`   └─ Attachment(s): ${selectedReply.attachments.map(a => a.filename).join(', ')}`);
  }

  let classification = await deps.llmReasoner.classifySubmission(unit.title, unit.dueDateLabel, selectedReply, timebox);

  // Gate 2: "Received" needs a real attachment, not just a claim of one.
  const gated = requireAttachmentForReceived(classification.status, classification.remarks, selectedReply.hasAttachments);
  if (gated.downgraded) {
    log(`   └─ ⚠️ No attachment on the reply — "${classification.status}" held back to "${gated.status}" for human review.`);
    classification = { ...classification, status: gated.status, remarks: gated.remarks };
  }

  log(`   └─ Classification Result: ${classification.status} | Remarks: "${classification.remarks}"`);

  return { classification, selectedReply, matchedReplyCount: matchedReplies.length };
}
