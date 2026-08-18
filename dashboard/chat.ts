/**
 * CFO AI Assistant — context assembly and prompting for POST /api/chat.
 *
 * Everything the assistant knows comes from data this process ALREADY has:
 * the memoised Sheet read the other dashboard routes share, plus five Postgres
 * reads. There is deliberately no Gmail call on this path — a chat turn must not
 * cost a mailbox round trip, and every attachment fact it can state is already
 * sitting in submissions.attachment_summary.
 *
 * The prompt builders and the context renderer are pure functions so the
 * self-check can assert what the model is actually told without a network call
 * or an API key. See dashboard/chat.test.ts (npm run check:chat).
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CONFIG } from '../src/config/index.js';
// The summariser already declares the one-method slice of the SDK we need, and
// the self-checks already fake it. Re-declaring it here would be a second name
// for the same shape.
import { GenerativeClient } from '../src/classifier/gemini-summarizer.js';

export { GenerativeClient };

/**
 * The newest flash tier this project's key can actually call.
 *
 * NOT a Pro model, despite Pro being the obvious fit for open questions over a
 * large assembled context. Every Pro tier was tried against this key and none is
 * usable: gemini-1.5-pro and gemini-2.5-pro both 404 with "no longer available
 * to new users" (the same wall documented in gemini-summarizer.ts), and
 * gemini-3.1-pro-preview / gemini-pro-latest both 429 — Pro has no free-tier
 * quota on this account. Flash answering is strictly better than Pro erroring.
 * Move this to a Pro id the moment the key gets billing; nothing else changes.
 *
 * A tier above the summariser's gemini-3.5-flash, because this reads a far
 * larger context than a single email. Pinned, not "-latest": an alias changes
 * model under a fixed prompt silently. Verify a replacement by actually POSTing
 * to it — ListModels lists models the key is then refused for.
 */
export const CHAT_MODEL = 'gemini-3.6-flash';

/** Longest question accepted. A trust boundary — this string reaches an LLM and the DB. */
export const MAX_MESSAGE_CHARS = 2000;

/** Longest reply stored. One runaway response must not bloat the table. */
export const MAX_REPLY_CHARS = 8000;

/** How many prior turns are replayed for multi-turn context. */
export const HISTORY_LIMIT = 10;

/** How far back the submission / reminder context windows reach. */
export const CONTEXT_DAYS = 30;

// --- input validation -------------------------------------------------------

/**
 * Session ids are client-generated (crypto.randomUUID) and land in a TEXT column
 * and a WHERE clause. Accepting only the UUID shape keeps an unbounded
 * attacker-chosen string out of both, and out of anything that later groups by it.
 */
export function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);
}

/** Trimmed question, or null when it is missing, blank, or over the cap. */
export function cleanMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_CHARS) return null;
  return trimmed;
}

// --- context ----------------------------------------------------------------

/** One tracked Sheet row, flattened to what a question about status needs. */
export interface ContextTask {
  tabName: string;
  rowIndex: number;
  name: string;
  assignedTo: string;
  email: string;
  dueDate: string;
  status: string;
  overdueDays: string;
  isValid: boolean;
}

export interface ChatContext {
  tasks: ContextTask[];
  submissions: any[];
  reminders: any[];
  needsAttention: ContextTask[];
  approvals: any[];
  directory: any[];
  /** Anything that could not be read, so the prompt can admit the gap. */
  warnings: string[];
}

/** The `safeQuery` shape the dashboard server already uses. Injected so the self-check can fake it. */
export type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[]; error?: string }>;

/**
 * Read every DB-side context block in one round of parallel queries.
 *
 * Each query is independently capped: an assistant answering "what's overdue"
 * does not need 4,000 submission rows, and an unbounded read here would grow
 * the prompt (and its cost) without bound as the tables fill.
 */
export async function loadDbContext(q: QueryFn): Promise<Omit<ChatContext, 'tasks' | 'needsAttention'>> {
  const warnings: string[] = [];
  const track = (label: string, r: { rows: any[]; error?: string }) => {
    if (r.error) warnings.push(`${label} could not be read (${r.error})`);
    return r.rows;
  };

  const [subs, reminders, approvals, directory] = await Promise.all([
    // DISTINCT ON (task_key, message_id) for the same reason /api/attachment-summaries
    // uses it: the pipeline appends a submissions row on every run that re-matches
    // the same email, so the raw table holds each real submission many times over.
    q(`SELECT DISTINCT ON (s.task_key, s.message_id)
              s.task_key, s.sender_email, s.subject, s.date_received, s.classification,
              s.attachment_summary, s.summary_from_file_content,
              COALESCE(jsonb_array_length(s.attachments_json), 0) AS attachment_count
         FROM submissions s
        WHERE s.date_received > NOW() - INTERVAL '${CONTEXT_DAYS} days'
        ORDER BY s.task_key, s.message_id, s.date_received DESC
        LIMIT 150`),
    q(`SELECT task_key, recipient_email, reminder_type, status, sent_at
         FROM reminder_logs
        WHERE sent_at > NOW() - INTERVAL '${CONTEXT_DAYS} days'
        ORDER BY sent_at DESC
        LIMIT 150`),
    q(`SELECT run_id, status, summary_text, created_at, expires_at
         FROM approval_requests
        WHERE status = 'PENDING'
        ORDER BY created_at DESC
        LIMIT 25`),
    q(`SELECT name, email, department FROM employees ORDER BY name LIMIT 200`),
  ]);

  return {
    submissions: track('Recent submissions', subs),
    reminders: track('Reminder logs', reminders),
    approvals: track('Pending approvals', approvals),
    // The Directory is how "what did Amarjyoti send?" becomes a sender_email
    // filter — without it a first name matches nothing in the submission rows.
    directory: track('Directory', directory),
    warnings,
  };
}

/** Load the last HISTORY_LIMIT turns of a session, oldest first. */
export async function loadHistory(q: QueryFn, sessionId: string, limit = HISTORY_LIMIT): Promise<Array<{ role: string; content: string }>> {
  // Newest-first + LIMIT inside, reversed outside: ordering ascending in SQL and
  // then limiting would keep the OLDEST turns and drop the ones that matter.
  const { rows } = await q(
    `SELECT role, content FROM (
       SELECT role, content, created_at FROM chat_messages
        WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
     ) t ORDER BY created_at ASC`,
    [sessionId, limit]
  );
  return rows.map(r => ({ role: r.role, content: r.content }));
}

// --- prompt -----------------------------------------------------------------

const truncate = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const dateOnly = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};

/**
 * Render the assembled context as the plain-text block the model reads.
 *
 * Line-per-record, not JSON: the same facts cost roughly half the tokens, and a
 * model asked for prose answers reads a table more reliably than nested objects.
 * Exported so the self-check can assert that real values (and only real values)
 * reach the model.
 */
export function buildContextBlock(ctx: ChatContext): string {
  const sections: string[] = [];

  sections.push(
    `TRACKED ROWS (${ctx.tasks.length}) — one line per Google Sheet row: [sheet | row] name — assigned to (email) — due — status — overdue days`,
    ctx.tasks.length
      ? ctx.tasks
          .map(t =>
            `[${t.tabName} | ${t.rowIndex}] ${truncate(t.name, 120)} — ${truncate(t.assignedTo, 60) || '(unassigned)'} (${t.email || 'no email'}) — due ${t.dueDate || '—'} — status ${t.status || '(blank)'} — overdue ${t.overdueDays || '0'}`
          )
          .join('\n')
      : '(none)'
  );

  sections.push(
    `\nROWS NEEDING ATTENTION (${ctx.needsAttention.length}) — excluded from automation because the row data is incomplete`,
    ctx.needsAttention.length
      ? ctx.needsAttention.map(t => `[${t.tabName} | ${t.rowIndex}] ${truncate(t.name, 120)} — ${truncate(t.assignedTo, 60) || '(no name)'} (${t.email || 'no email'})`).join('\n')
      : '(none)'
  );

  sections.push(
    `\nRECENT SUBMISSIONS, last ${CONTEXT_DAYS} days (${ctx.submissions.length}) — what staff actually emailed in`,
    ctx.submissions.length
      ? ctx.submissions
          .map(s => {
            const summary = s.attachment_summary
              ? `\n    ATTACHMENT SUMMARY (${s.summary_from_file_content ? 'READ FROM THE REAL FILE CONTENTS' : 'INFERRED FROM FILENAME AND COVERING NOTE ONLY'}): ${truncate(s.attachment_summary, 1400)}`
              : s.attachment_count > 0
                ? '\n    ATTACHMENT SUMMARY: none stored for this submission.'
                : '';
            return `[${s.task_key || 'unmatched'}] ${dateOnly(s.date_received)} from ${s.sender_email} — "${truncate(s.subject, 140)}" — classified ${s.classification} — ${s.attachment_count} attachment(s)${summary}`;
          })
          .join('\n')
      : '(none)'
  );

  sections.push(
    `\nREMINDERS SENT OR DRAFTED, last ${CONTEXT_DAYS} days (${ctx.reminders.length})`,
    ctx.reminders.length
      ? ctx.reminders.map(r => `[${r.task_key || '—'}] ${dateOnly(r.sent_at)} to ${r.recipient_email} — ${r.reminder_type} — ${r.status}`).join('\n')
      : '(none)'
  );

  sections.push(
    `\nPENDING APPROVAL RUNS (${ctx.approvals.length})`,
    ctx.approvals.length
      ? ctx.approvals.map(a => `${a.run_id} — ${truncate(a.summary_text, 200)} — raised ${dateOnly(a.created_at)}, expires ${dateOnly(a.expires_at)}`).join('\n')
      : '(none)'
  );

  sections.push(
    `\nSTAFF DIRECTORY (${ctx.directory.length}) — use this to resolve a person's first name to their email address`,
    ctx.directory.length ? ctx.directory.map(e => `${e.name} <${e.email}> — ${e.department || 'Finance'}`).join('\n') : '(none)'
  );

  if (ctx.warnings.length) {
    sections.push(`\nCONTEXT GAPS — say so if a question depends on one of these:\n${ctx.warnings.map(w => `- ${w}`).join('\n')}`);
  }

  return sections.join('\n');
}

/** The standing instructions. Exported so the self-check can assert the honesty rules survive edits. */
export const SYSTEM_PROMPT = `You are the CFO's AI assistant for the OGI Finance Office, a mid-sized Indian
manufacturing group. You answer the CFO's questions about tracked finance tasks and
reports, who has submitted what, what is overdue, and what arrived in the submissions
you have been given.

Everything you know is in the CONTEXT block below. Rules, in priority order:

1. NEVER invent data. If the context does not contain the answer, say plainly what is
   missing. Do not estimate, extrapolate, or fill a gap with a plausible-sounding figure,
   date, name or amount. "That is not in the data I have" is a correct answer.
2. Attachments: use the stored ATTACHMENT SUMMARY only. If it is marked READ FROM THE
   REAL FILE CONTENTS, you may give a full CFO brief from it — lead with the key figures
   and periods it names, then cost pressures or anomalies, then two or three takeaways
   the CFO should act on. If it is marked INFERRED FROM FILENAME AND COVERING NOTE ONLY,
   say so explicitly in your answer before describing it, and do not present it as a read
   of the file. You cannot open files or search email; you are reading stored summaries.
3. Answer at CFO level: what the position is and what it means, not how the system works.
   No table names, no column names, no row indexes unless the CFO asks which sheet row.
4. Be concise but complete. Lead with the answer. If a list is long, give the material
   items and state how many more there are.
5. Plain text only. No markdown — no asterisks, no hashes, no bullet characters, no bold.
   Use short paragraphs, and where you must list things use a new line per item beginning
   with the item itself.`;

/**
 * Assemble the full single-turn prompt: instructions, context, prior turns, question.
 *
 * Prior turns are replayed inside one prompt rather than through a chat session
 * object so that the whole request stays a single stateless generateContent call
 * — nothing to keep alive between HTTP requests, and the self-check can read the
 * exact string the model receives.
 */
export function buildChatPrompt(ctx: ChatContext, history: Array<{ role: string; content: string }>, message: string): string {
  const conversation = history.length
    ? `\n\nCONVERSATION SO FAR (oldest first):\n${history.map(h => `${h.role === 'assistant' ? 'ASSISTANT' : 'CFO'}: ${h.content}`).join('\n')}`
    : '';

  return `${SYSTEM_PROMPT}

=== CONTEXT (live data, as of this request) ===
${buildContextBlock(ctx)}
=== END CONTEXT ===${conversation}

CFO'S QUESTION: ${message}

Answer now, in plain text, following the rules above.`;
}

/**
 * Strip the markdown the model emits despite being told not to, WITHOUT
 * collapsing the reply onto one line.
 *
 * Deliberately not normaliseSummary() from gemini-summarizer.ts: that joins every
 * line with a space, which is right for a 4-sentence cell in a table and wrong
 * for a chat answer whose paragraph breaks carry meaning.
 */
export function normaliseReply(raw: string): string | null {
  const cleaned = (raw || '')
    .replace(/\*\*|__|`{1,3}/g, '')
    .split('\n')
    .map(line => line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[-*•]\s+/, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_REPLY_CHARS ? `${cleaned.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…` : cleaned;
}

/** Lazily built real client; null whenever GEMINI_API_KEY is absent. */
let cachedClient: GenerativeClient | null = null;

function getClient(): GenerativeClient | null {
  if (cachedClient) return cachedClient;
  if (!CONFIG.GEMINI_API_KEY) return null;
  const model = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY).getGenerativeModel({ model: CHAT_MODEL });
  cachedClient = { generateContent: (prompt: string) => model.generateContent(prompt) };
  return cachedClient;
}

/**
 * Ask Gemini and return a cleaned reply, or an honest sentence about why there
 * isn't one. Never throws and never returns an empty string: the caller stores
 * whatever comes back as the assistant's turn, and a blank bubble reads as a
 * frontend bug rather than as the outage it actually is.
 *
 * @param client injected only by the self-check; production leaves it undefined.
 */
export async function askGemini(prompt: string, client?: GenerativeClient | null): Promise<string> {
  const active = client === undefined ? getClient() : client;
  if (!active) return 'The AI assistant is not configured — GEMINI_API_KEY is not set on this server, so I cannot answer questions yet.';

  try {
    const result = await active.generateContent(prompt);
    return normaliseReply(result?.response?.text() || '') || 'I could not produce an answer for that. Please try rephrasing the question.';
  } catch (err: any) {
    console.warn(`⚠️ Gemini chat call failed (${err?.message || err}).`);
    return 'I could not reach the AI service just now. Please try again in a moment.';
  }
}
