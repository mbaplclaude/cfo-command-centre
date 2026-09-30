/**
 * Pure dashboard logic — categorisation + new-task validation.
 * Kept separate from server.ts so it can be self-checked without booting a server.
 * Run the self-check with: npm run check:dashboard
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CONFIG } from '../src/config/index.js';
import { UnifiedTask } from '../src/types/index.js';
import { TASK_TYPE_OPTIONS } from '../src/util/task-type.js';
import { parseSheetDate, formatDisplayDate } from '../src/util/parse-date.js';

/**
 * Longest accepted free-text field. The Sheet cells these land in are read by
 * humans, and nothing legitimate is longer — a 10,000-character "date" was
 * accepted and written verbatim before this cap existed.
 */
export const MAX_TEXT_LENGTH = 200;

/**
 * Coerce one JSON body field to trimmed text, or null when it is object-shaped.
 *
 * JSON bodies are attacker-shaped, not form-shaped: `{"taskType":{"x":1}}` used to
 * reach `String(...)` and write the literal "[object Object]" into the Sheet, and
 * an object in a field the route later called `.trim()` on threw a 500. Objects
 * and arrays are therefore rejected rather than stringified — there is no sensible
 * text value for them, so guessing one is how bad data gets persisted.
 */
export function scalarText(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return null; // {} and [] both land here
  return String(value).trim();
}

/** Blank means "unspecified"; anything else must be one of the canonical options. */
export function isAllowedTaskType(taskType: string): boolean {
  return taskType === '' || TASK_TYPE_OPTIONS.includes(taskType);
}

// ---------------------------------------------------------------------------
// Request-body / write-path safety — moved here (from server.ts) so it can be
// self-checked without booting a server, matching this file's own purpose.
// ---------------------------------------------------------------------------

/**
 * The client's fault, and safe to echo back: validation messages the operator
 * needs to see. Everything NOT of this type is treated as internal — logged in
 * full server-side, reported to the client as a generic message.
 *
 * Raw exception text used to go straight to the client, which leaked Postgres
 * connection errors and JS internals ("(input.emailId || \"\").trim is not a
 * function") to anything that could reach the port.
 */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

/** Longest request body this server will read before refusing it outright. */
export const MAX_BODY_BYTES = 1_000_000;

/**
 * Read and JSON-parse a request body, capped at MAX_BODY_BYTES.
 *
 * Rejecting the returned Promise on an oversized body is NOT enough on its
 * own — a Promise settling doesn't stop the underlying stream. Without the
 * `done` guard and `req.destroy()` below, Node keeps emitting 'data' for every
 * further byte the client sends after the cap is crossed, so `raw += chunk`
 * (a fresh string allocation each time) kept growing in memory for as long as
 * the client kept the connection open and kept sending bytes — an unbounded
 * memory/CPU sink reachable by any authenticated caller on every POST route.
 * `req.destroy()` actually stops the stream; `done` stops this function from
 * reacting to whatever already-queued events fire on the way out.
 */
export function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let done = false;

    req.on('data', chunk => {
      if (done) return; // already rejected+destroyed — ignore anything still in flight
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        done = true;
        reject(new BadRequest('Request body too large.'));
        req.destroy(); // stop consuming the stream — the actual fix, not just the reject
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        return reject(new BadRequest('Invalid JSON body.'));
      }
      // Every route reads named fields off this, so anything that is not a plain
      // object is rejected here rather than crashing on `body.tab` further in.
      // `null` in particular used to produce a 500 reading a property of null.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new BadRequest('Request body must be a JSON object.'));
      }
      resolve(parsed);
    });
    req.on('error', err => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * CSRF mitigation for state-changing (POST) requests.
 *
 * HTTP Basic Auth credentials are cached per-origin by the browser and resent
 * AUTOMATICALLY on every request to that origin — including one triggered by a
 * completely unrelated, malicious page (a hidden auto-submitting form, a
 * fetch() with credentials included). There is no session cookie here to scope
 * with SameSite, so passing Basic Auth proves nothing about who INITIATED the
 * request. `Origin` is different: it is set by the browser itself and cannot
 * be forged by page-level JavaScript, so a MISMATCHED Origin is real evidence
 * of a cross-site request and is rejected. A MISSING Origin is allowed through
 * — non-browser clients (curl, scripts) and some legitimate same-origin
 * requests in older browsers don't send it, and there is nothing to check it
 * against in that case.
 */
export function isAllowedOrigin(origin: string | undefined | null, expectedHost: string): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host; // "host" includes the port, matching the Host: header
  } catch {
    return false; // an Origin header that isn't even a valid URL is never legitimate
  }
  return originHost === expectedHost;
}

/**
 * Hard cap on one manual staff-reminder send batch (POST /api/staff-reminders/send).
 *
 * Every item triggers a real, sequential Gmail send — unlike a read, this has a
 * genuine per-item cost (a live API call) and an irreversible effect (mail
 * sent). Every other batch-shaped operation in this codebase has an explicit
 * ceiling (MAX_TEXT_LENGTH, the per-period digest cap, CHRONIC_REMINDER_CAP);
 * this endpoint was the one exception, bounded in practice only by today's
 * Staff Tracker row count and the request body's own MAX_BODY_BYTES cap —
 * neither of which is a real limit if either grows.
 */
export const MAX_STAFF_DIGEST_BATCH = 50;

export function isOversizedDigestBatch(count: number): boolean {
  return count > MAX_STAFF_DIGEST_BATCH;
}

/**
 * Split a decoded "user:password" Basic Auth credential on the FIRST colon
 * only.
 *
 * `decoded.split(':')` followed by array destructuring keeps only the first
 * two elements — for a password that itself contains a colon (a perfectly
 * legitimate password character), "user:pass:word" decodes to
 * ['user','pass','word'] and destructuring silently drops "word". That is a
 * lockout of the real operator (their correct password never matches), not an
 * attacker bypass — but still a real correctness bug worth a dedicated,
 * pinned test rather than leaving it to be rediscovered by someone locked out.
 */
export function parseBasicAuthPair(decoded: string): { user: string; password: string } {
  const idx = decoded.indexOf(':');
  if (idx === -1) return { user: decoded, password: '' };
  return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

export type Category = 'received' | 'early' | 'unclear' | 'overdue' | 'pending' | 'attention';

/** Status/validity -> dashboard category. Order matters: "Received (Early)" also contains "received". */
export function categorize(status: string, isValid = true): Category {
  if (!isValid) return 'attention';
  const s = (status || '').toLowerCase();
  if (s.includes('early')) return 'early';
  if (s.includes('partial') || s.includes('unclear')) return 'unclear';
  if (s.includes('overdue')) return 'overdue';
  if (s.includes('received')) return 'received';
  return 'pending';
}

export interface NewTaskInput {
  tab?: string;
  taskDescription?: string;
  assignedTo?: string;
  emailId?: string;
  names?: string;
  taskType?: string;
  dateAssigned?: string;
  dueDate?: string;
}

/**
 * Resolve a loose tab hint ("report", "4. Report Calendar") to a real sheet tab
 * name — for READS only (GET /api/tasks?tab=, GET /api/needs-attention). A
 * mistyped or unrecognised hint here just falls back to a reasonable default;
 * nothing is mutated, so guessing is harmless. Never use this for a write — see
 * resolveWriteTab, which refuses to guess for exactly that reason.
 */
export function resolveTab(tab?: unknown): string {
  // scalarText, not `tab || ''`: an object-valued `tab` in a JSON body reached
  // .toLowerCase() here and threw before the route's own validation ever ran.
  const text = scalarText(tab) || '';

  // An exact tab name wins outright, and has to be tested BEFORE the loose hint
  // below: "MIS_Closing_Report (M)" contains "report", so the substring test
  // would otherwise silently resolve every MIS register to Report Calendar and
  // serve the wrong workbook's rows under the MIS tab's name.
  if (text === CONFIG.STAFF_TRACKER_TAB) return CONFIG.STAFF_TRACKER_TAB;
  const exact = CONFIG.REPORT_SOURCES.find(s => s.tab === text);
  if (exact) return exact.tab;

  return text.toLowerCase().includes('report') ? CONFIG.REPORT_CALENDAR_TAB : CONFIG.STAFF_TRACKER_TAB;
}

/**
 * Tabs the dashboard is allowed to APPEND a new row to: Staff Tracker, plus every
 * report-shaped source in CONFIG.REPORT_SOURCES (Report Calendar and both MIS
 * registers today). Sourced from that one list rather than hardcoded, so a new
 * source becomes appendable the moment it's added there — the same authority
 * GoogleSheetsClient.appendRow itself resolves the write against, via
 * isWriteAllowed(). This is the ONE definition of "appendable" — resolveWriteTab
 * below defers to it rather than re-deciding the same question a second way.
 */
export function isAppendableTab(tabName: string): boolean {
  return tabName === CONFIG.STAFF_TRACKER_TAB || CONFIG.REPORT_SOURCES.some(s => s.tab === tabName);
}

/**
 * Resolve a tab value for a WRITE (POST /api/tasks) — strict, never a guess.
 *
 * resolveTab() above is deliberately forgiving: any "report"-ish hint falls back
 * to Report Calendar, which is fine for a GET that mutates nothing. That same
 * fallback reaching a write is exactly how a malformed tab value ("MIS_Closing_
 * Report (Q)", a typo) silently wrote a real row to Report Calendar instead of
 * failing — nothing "chose" the wrong tab, the resolver just never had a way to
 * say "I don't recognise this."
 *
 * Returns null — never a fallback tab — for anything that isn't:
 *   - the exact tab name of an appendable source (isAppendableTab), or
 *   - one of the two literal aliases the dashboard's own Add-a-task form still
 *     sends for the two original tabs ("Staff Tracker" / "Report Calendar",
 *     without the sheet's own numbering prefix) — kept so the existing UI
 *     doesn't need to change what it already sends.
 * A caller that gets null must reject the request outright, not fall back.
 */
export function resolveWriteTab(tab?: unknown): string | null {
  const text = scalarText(tab) || '';

  const candidate =
    text === 'Staff Tracker' ? CONFIG.STAFF_TRACKER_TAB
    : text === 'Report Calendar' ? CONFIG.REPORT_CALENDAR_TAB
    : text;

  return isAppendableTab(candidate) ? candidate : null;
}

/**
 * Gate for POST /api/tasks. Mirrors the exact rules the sheet readers apply
 * (sheets.ts readStaffTracker / readReportCalendar) so the dashboard can never
 * create a row the pipeline would immediately reject into "Needs Attention".
 * Report Calendar has no Date Assigned column, so it is not required there.
 */
export interface CleanNewTask {
  taskDescription: string;
  assignedTo: string;
  emailId: string;
  names: string;
  taskType: string;
  dateAssigned: string;
  dueDate: string;
}

export function validateNewTask(
  input: NewTaskInput
): { ok: boolean; errors: Record<string, string>; clean: CleanNewTask; tab: string } {
  const errors: Record<string, string> = {};
  // resolveWriteTab, NOT resolveTab: a write must reject an unrecognised tab
  // outright rather than guess Report Calendar for it (see resolveWriteTab's
  // own comment for the incident that made this the rule). `tabName` is null
  // for exactly that case; `isStaff` is then false, which is also the correct
  // "don't additionally require Date Assigned" branch for a request that is
  // being rejected anyway — one real error (bad tab), not a pile of noise.
  const tabName = resolveWriteTab(input.tab);
  const isStaff = tabName === CONFIG.STAFF_TRACKER_TAB;

  if (tabName === null) {
    errors.tab = `"${scalarText(input.tab) || '(blank)'}" is not a recognised tab — nothing was written.`;
  }

  // Coerce every field up front, so nothing downstream can be handed an object.
  // A rejected field becomes '' here and reports its own error, which keeps the
  // rest of the validation running instead of throwing on the first bad value.
  const raw = input as Record<string, unknown>;
  const clean: CleanNewTask = {
    taskDescription: '', assignedTo: '', emailId: '', names: '', taskType: '', dateAssigned: '', dueDate: '',
  };
  for (const field of Object.keys(clean) as Array<keyof CleanNewTask>) {
    const text = scalarText(raw[field]);
    if (text === null) {
      errors[field] = `${field} must be text, not an object or array.`;
      continue;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      errors[field] = `${field} is ${text.length} characters; the maximum is ${MAX_TEXT_LENGTH}.`;
      continue;
    }
    clean[field] = text;
  }

  if (!errors.taskDescription && !clean.taskDescription) {
    errors.taskDescription = 'Task description is required.';
  }

  if (!errors.emailId) {
    const email = clean.emailId;
    if (!email) {
      errors.emailId = 'Email ID is required — rows without it are excluded from all emails.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.emailId = `"${email}" is not a valid email address.`;
    } else if (CONFIG.OWN_SENDER_EMAILS.includes(email.toLowerCase())) {
      errors.emailId = `"${email}" is an own-mailbox address and would create false-positive reply matches.`;
    }
  }

  if (!errors.taskType && !isAllowedTaskType(clean.taskType)) {
    errors.taskType = `"${clean.taskType}" is not a valid Task Type. Allowed: ${TASK_TYPE_OPTIONS.join(', ')}.`;
  }

  // Date fields are only dates on the Staff Tracker. Report Calendar has no Date
  // Assigned column at all, and its dueDate carries free-text Review Timing
  // ("Morning (8:00 AM)"), so date-parsing it would reject every valid report row.
  if (isStaff) {
    if (!errors.dateAssigned) {
      if (!clean.dateAssigned) {
        errors.dateAssigned = 'Date Assigned is required for Staff Tracker rows.';
      } else if (isNaN(parseSheetDate(clean.dateAssigned).getTime())) {
        errors.dateAssigned = `"${clean.dateAssigned}" is not a recognisable date.`;
      }
    }
    if (!errors.dueDate && clean.dueDate && isNaN(parseSheetDate(clean.dueDate).getTime())) {
      errors.dueDate = `"${clean.dueDate}" is not a recognisable date.`;
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, clean, tab: tabName || '' };
}

// ---------------------------------------------------------------------------
// Stale-server detection
// ---------------------------------------------------------------------------

/**
 * Content fingerprint of every runtime .ts file under `roots` (test files
 * excluded — editing a test never changes what the running server does).
 *
 * Why this exists: the server loads its TypeScript once, at startup, but serves
 * index.html fresh from disk on every page load. So after an edit, a server
 * that was not restarted pairs a NEW page with an OLD API — features look
 * half-built with no error anywhere. That silently cost two investigations.
 * server.ts fingerprints at startup and again on each /api/health; a mismatch
 * means "restart me", and the page says so.
 */
export function sourceFingerprint(roots: string[]): string {
  const hash = crypto.createHash('sha1');
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
        hash.update(p);
        hash.update(fs.readFileSync(p));
      }
    }
  };
  for (const root of roots) walk(root);
  return hash.digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Pending-approval guard for row deletion (POST /api/tasks/delete)
// ---------------------------------------------------------------------------

/** One approval_requests row, as the table actually stores it. */
export interface ApprovalRow {
  run_id: string;
  status?: string;
  created_at?: string | Date;
  expires_at?: string | Date;
  /** JSONB: [{recipientEmail, items: [{tabName, rowIndex, taskDescription, ...}]}] */
  reminders_json?: unknown;
}

export interface BlockingApproval {
  runId: string;
  createdAt?: string | Date;
  descriptions: string[];
  /**
   * True when this row could not be read into the expected shape, so we cannot
   * prove it does NOT reference the tab. It blocks on the "unverified" ground
   * rather than on a known item — see selectBlockingApprovals.
   */
  unverified: boolean;
}

/**
 * Which PENDING approvals still block deletion on `tabName`.
 *
 * Deliberately TAB-level, not row-level: any live approval on the tab blocks
 * every delete on that tab. A delete renumbers every row beneath it, and a
 * pending run holds `items[{tabName, rowIndex}]` captured BEFORE the shift — so
 * approving afterwards would log (and reason about) the wrong rows. Blocking
 * only the exact row being deleted would miss precisely that case.
 *
 * `approval_requests` has no tab column; the tab lives inside reminders_json,
 * so the match digs through the digests' items.
 *
 * FAILS CLOSED. Anything that cannot be read into the expected shape blocks,
 * flagged `unverified`, rather than being skipped. The earlier version treated
 * "I can't parse this" as "nothing to worry about", which is the one failure
 * direction that matters: a silent false negative here permits exactly the
 * delete this guard exists to prevent. Refusing a delete is recoverable in
 * seconds (approve or discard the run); renumbering every stored key under a
 * live approval is not.
 *
 * Filtering lives here rather than in SQL so the cases that matter — same tab,
 * other tab, lapsed window, unreadable row — are unit-testable with no
 * database. The caller's query is deliberately coarse; see
 * hasBlockingPendingApproval.
 */
export function selectBlockingApprovals(
  rows: ApprovalRow[],
  tabName: string,
  now: Date = new Date()
): BlockingApproval[] {
  const blocking: BlockingApproval[] = [];
  const unreadable = (row: ApprovalRow): BlockingApproval => ({
    runId: row.run_id, createdAt: row.created_at, descriptions: [], unverified: true,
  });

  for (const row of rows || []) {
    // Not a fail-open: a non-PENDING run has already been actioned, and
    // approveAndDispatchRun refuses both APPROVED and EXPIRED outright, so it
    // provably cannot dispatch.
    if (row.status !== undefined && row.status !== 'PENDING') continue;

    // expires_at, NOT status alone. Nothing sweeps PENDING -> EXPIRED on a
    // timer; approveAndDispatchRun only flips it when someone tries to approve.
    // So a lapsed run still reads PENDING while being permanently un-approvable.
    const expiresAt = new Date(row.expires_at as any);
    if (isNaN(expiresAt.getTime())) {
      blocking.push(unreadable(row)); // window unknown -> cannot prove it is closed
      continue;
    }
    if (expiresAt <= now) continue; // provably lapsed: can never dispatch

    if (!Array.isArray(row.reminders_json)) {
      blocking.push(unreadable(row)); // contents unknown -> cannot rule this tab out
      continue;
    }

    const descriptions: string[] = [];
    let unverified = false;

    for (const digest of row.reminders_json) {
      if (!digest || typeof digest !== 'object' || !Array.isArray((digest as any).items)) {
        unverified = true; // this digest's tab cannot be determined
        continue;
      }
      for (const item of (digest as any).items) {
        // A real item always carries a string tabName. Anything else is a shape
        // we do not recognise, so it cannot be ruled out.
        if (!item || typeof item !== 'object' || typeof item.tabName !== 'string') {
          unverified = true;
          continue;
        }
        if (item.tabName !== tabName) continue;
        const desc = String(item.taskDescription ?? '').trim() || `row ${item.rowIndex}`;
        if (!descriptions.includes(desc)) descriptions.push(desc);
      }
    }

    if (descriptions.length || unverified) {
      blocking.push({ runId: row.run_id, createdAt: row.created_at, descriptions, unverified });
    }
  }

  return blocking;
}

/** Longest list of task names named in one 409 before it is truncated. */
const MAX_NAMED_BLOCKING_ITEMS = 5;

/** The 409 body for a delete refused by selectBlockingApprovals. */
export function formatBlockingApprovalError(blocking: BlockingApproval[], tabName: string): string {
  const runs = blocking
    .map(b => {
      const when = new Date(b.createdAt as any);
      const drafted = isNaN(when.getTime())
        ? 'drafted earlier'
        : `drafted ${when.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
      const shown = b.descriptions.slice(0, MAX_NAMED_BLOCKING_ITEMS).join('; ');
      const rest = b.descriptions.length - MAX_NAMED_BLOCKING_ITEMS;

      // An unverified run names no task, because the whole point is that its
      // contents could not be read. Say that plainly instead of implying it is
      // a normal block the operator can reason about from the description.
      if (b.unverified) {
        const partial = b.descriptions.length ? ` — partially readable: ${shown}` : '';
        return `${b.runId} (${drafted}) — CONTENTS UNREADABLE, this tab could not be ruled out${partial}`;
      }
      return `${b.runId} (${drafted}) — ${shown}${rest > 0 ? ` +${rest} more` : ''}`;
    })
    .join(' | ');

  const one = blocking.length === 1;
  const anyUnverified = blocking.some(b => b.unverified);

  return (
    `Cannot delete from "${tabName}" yet: ${blocking.length} approval run${one ? '' : 's'} ` +
    `${one ? 'is' : 'are'} still pending on this tab` +
    (anyUnverified ? `, or could not be verified` : '') + `. ` +
    `Deleting now would shift every row below it, so ${one ? 'that run' : 'those runs'} would act on ` +
    `the wrong rows once approved. ` +
    (anyUnverified
      ? `Open the run${one ? '' : 's'} named below under Employee Monitor → Approval requests and check ${one ? 'it' : 'them'} by hand, `
      : `Approve ${one ? 'it' : 'them'} under Employee Monitor → Approval requests, `) +
    `or discard with "npm run discard:run", then retry the delete. Blocking: ${runs}`
  );
}

/**
 * Sheet date text -> "YYYY-MM-DD" for pre-filling an <input type="date">, or ''
 * when the text isn't a date at all (blank, or Report Calendar's free-text
 * "review timing" column). An HTML date input silently ignores a `value` it
 * doesn't recognise rather than erroring, so without this conversion the Edit
 * form's date fields would render blank for every non-ISO Sheet date — and
 * saving unchanged would then write that blank back over a good value.
 */
export function toISODateInput(dateStr: string): string {
  if (!dateStr) return '';
  const d = parseSheetDate(dateStr);
  if (isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Flatten a UnifiedTask into the shape the frontend renders. */
export function toDashboardTask(t: UnifiedTask) {
  return {
    tabName: t.tabName,
    rowIndex: t.rowIndex,
    idNum: t.idNum,
    taskDescription: t.taskDescriptionOrName,
    assignedTo: t.assignedToName,
    // The dedicated person column ("Names" on Staff Tracker, "Name" on Report
    // Calendar and the MIS registers). Displayed as "Name (Email ID)" instead of
    // assignedTo, which carries role labels and MIS section headers rather than
    // people. Kept as a separate field so assignedTo still round-trips on edits.
    personName: t.personName,
    emailId: t.emailId,
    taskType: t.taskType,
    dateAssigned: t.dateAssigned,
    dueDate: t.dueDate,
    // Display-only copies — DD-Mon-YY regardless of which of the Sheet's several
    // date formats the raw value arrived in. The raw fields above are untouched
    // so writes/edits still round-trip the original text.
    dateAssignedDisplay: formatDisplayDate(t.dateAssigned),
    dueDateDisplay: formatDisplayDate(t.dueDate),
    // Edit-form-only copies — see toISODateInput. Blank (and harmless) on
    // Report Calendar/MIS rows, whose "due date" is free-text Review Timing.
    dateAssignedISO: toISODateInput(t.dateAssigned),
    dueDateISO: toISODateInput(t.dueDate),
    status: t.currentStatus,
    remarks: t.remarks,
    threadId: t.threadId,
    days: t.daysOrOverdueDays,
    isValid: t.isValid,
    validationIssue: t.validationIssue || '',
    category: categorize(t.currentStatus, t.isValid),
  };
}

/** One bar of Employee Monitor's per-person stacked chart. */
export interface PersonStatusCount {
  name: string;
  /** True for the bucket of rows whose Name cell is blank — kept, never dropped. */
  blank: boolean;
  emails: string[];
  total: number;
  counts: Partial<Record<Category, number>>;
}

/**
 * Valid rows per person, by status category — Employee Monitor's stacked bars.
 *
 * Grouped on personName (the Sheet's own Name column), NOT email, so a shared
 * inbox like accounts@ splits into the people actually named on its rows.
 * Deliberately no smarter than trim + collapse spaces + case-fold: stripping
 * "Sir" or splitting "A / B" would be guessing who is who, so "Vivek" and
 * "Vivek Sir" stay two bars. A blank Name gets its own bucket rather than
 * vanishing, so the bars always sum to every valid row.
 *
 * Sorted by row count, then overdue load, then name — the page cuts at the top
 * N, and a tie at that line must land the same way on every load.
 */
export function personStatusCounts(tasks: UnifiedTask[]): PersonStatusCount[] {
  const by = new Map<string, PersonStatusCount>();
  for (const t of tasks) {
    if (!t.isValid) continue;
    const name = (t.personName || '').trim().replace(/\s+/g, ' ');
    let p = by.get(name.toLowerCase());
    if (!p) by.set(name.toLowerCase(), (p = { name: name || '(no name on the row)', blank: !name, emails: [], total: 0, counts: {} }));
    const email = (t.emailId || '').trim().toLowerCase();
    if (email && !p.emails.includes(email)) p.emails.push(email);
    const cat = categorize(t.currentStatus);
    p.counts[cat] = (p.counts[cat] || 0) + 1;
    p.total++;
  }
  return [...by.values()].sort((a, b) =>
    b.total - a.total || (b.counts.overdue || 0) - (a.counts.overdue || 0) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
async function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };

  // categorize — "early" must win over the "received" substring it contains
  assert(categorize('Received (Early)') === 'early', 'Received (Early) -> early');
  assert(categorize('Received') === 'received', 'Received -> received');
  assert(categorize('Partial/Unclear') === 'unclear', 'Partial/Unclear -> unclear');
  assert(categorize('Overdue') === 'overdue', 'Overdue -> overdue');
  assert(categorize('') === 'pending', 'blank -> pending');
  assert(categorize('Received', false) === 'attention', 'invalid row -> attention regardless of status');

  // validateNewTask — the safety filter
  const good = { tab: 'Staff Tracker', taskDescription: 'Q3 GST recon', emailId: 'a@b.com', dateAssigned: '2026-07-01' };
  assert(validateNewTask(good).ok, 'valid staff row accepted');
  assert(!validateNewTask({ ...good, emailId: '' }).ok, 'missing email rejected');
  assert(!validateNewTask({ ...good, emailId: 'not-an-email' }).ok, 'malformed email rejected');
  // The agent's own mailbox is rejected; a normal submitter address is not.
  assert(!validateNewTask({ ...good, emailId: 'mbaplclaudereply@gmail.com' }).ok, 'own-mailbox address rejected');
  assert(validateNewTask({ ...good, emailId: 'trade@ostwal.in' }).ok, 'trade@ostwal.in is a valid submitter, not own-mailbox');
  assert(!validateNewTask({ ...good, dateAssigned: '' }).ok, 'staff row without Date Assigned rejected');
  assert(!validateNewTask({ ...good, taskDescription: '  ' }).ok, 'blank description rejected');
  // Report Calendar has no Date Assigned column, so it must not be required there
  assert(
    validateNewTask({ tab: '4. Report Calendar', taskDescription: 'Monthly MIS', emailId: 'a@b.com' }).ok,
    'report row without Date Assigned accepted'
  );

  // resolveTab
  assert(resolveTab('report') === CONFIG.REPORT_CALENDAR_TAB, 'report hint -> Report Calendar');
  assert(resolveTab('Staff Tracker') === CONFIG.STAFF_TRACKER_TAB, 'staff hint -> Staff Tracker');
  assert(resolveTab(undefined) === CONFIG.STAFF_TRACKER_TAB, 'default -> Staff Tracker');
  // An object-valued tab used to throw here before any validation ran.
  assert(resolveTab({ x: 1 }) === CONFIG.STAFF_TRACKER_TAB, 'object tab falls back, does not throw');
  assert(resolveTab(['report']) === CONFIG.STAFF_TRACKER_TAB, 'array tab falls back, does not throw');

  // --- every configured report source must round-trip by its EXACT tab name ---
  // The MIS register names contain "report", so without the exact-match branch
  // they collapse onto Report Calendar and serve the wrong workbook's rows.
  for (const source of CONFIG.REPORT_SOURCES) {
    assert(resolveTab(source.tab) === source.tab, `"${source.tab}" resolves to itself, not to a substring match`);
  }
  assert(resolveTab('MIS_Closing_Report (M)') === 'MIS_Closing_Report (M)', 'MIS monthly register is not swallowed by the "report" hint');
  assert(resolveTab('MIS_Closing_Report (Y)') === 'MIS_Closing_Report (Y)', 'MIS yearly register is not swallowed by the "report" hint');
  assert(resolveTab(CONFIG.STAFF_TRACKER_TAB) === CONFIG.STAFF_TRACKER_TAB, 'exact Staff Tracker name round-trips');
  // An unknown tab name still falls back rather than being served verbatim.
  assert(resolveTab('MIS_Closing_Report (Q)') === CONFIG.REPORT_CALENDAR_TAB, 'unconfigured MIS-shaped name falls back, is never trusted');

  // --- append scope: every CONFIG.REPORT_SOURCES tab is appendable, plus Staff Tracker ---
  assert(isAppendableTab(CONFIG.STAFF_TRACKER_TAB), 'Staff Tracker is appendable');
  assert(isAppendableTab(CONFIG.REPORT_CALENDAR_TAB), 'Report Calendar is appendable');
  assert(isAppendableTab('MIS_Closing_Report (M)'), 'MIS monthly register is appendable (new reports can be added there)');
  assert(isAppendableTab('MIS_Closing_Report (Y)'), 'MIS yearly register is appendable');
  assert(!isAppendableTab('MIS_Closing_Report (Q)'), 'an unconfigured MIS-shaped name is NOT appendable — only what CONFIG.REPORT_SOURCES lists');

  // --- resolveWriteTab: strict, never a fallback guess (unlike resolveTab) ---
  assert(resolveWriteTab(CONFIG.STAFF_TRACKER_TAB) === CONFIG.STAFF_TRACKER_TAB, 'exact Staff Tracker name resolves');
  assert(resolveWriteTab('Staff Tracker') === CONFIG.STAFF_TRACKER_TAB, 'the "Staff Tracker" alias the real UI sends still resolves');
  assert(resolveWriteTab('Report Calendar') === CONFIG.REPORT_CALENDAR_TAB, 'the "Report Calendar" alias the real UI sends still resolves');
  assert(resolveWriteTab(CONFIG.REPORT_CALENDAR_TAB) === CONFIG.REPORT_CALENDAR_TAB, 'exact Report Calendar name resolves');
  assert(resolveWriteTab('MIS_Closing_Report (M)') === 'MIS_Closing_Report (M)', 'exact MIS monthly register name resolves');
  assert(resolveWriteTab('MIS_Closing_Report (Y)') === 'MIS_Closing_Report (Y)', 'exact MIS yearly register name resolves');
  // The exact incident this function exists to prevent: a malformed/unconfigured
  // MIS-shaped name must be REJECTED, never silently resolved to Report Calendar
  // the way the old resolveTab()-based write path did (it wrote a real test row
  // there before this fix).
  assert(resolveWriteTab('MIS_Closing_Report (Q)') === null, 'unconfigured MIS-shaped name is rejected, NOT silently written to Report Calendar');
  assert(resolveWriteTab('Some Random Tab') === null, 'any other unrecognised value is rejected outright');
  assert(resolveWriteTab('report') === null, 'a loose substring hint that resolveTab() would accept is rejected here — writes never guess');
  assert(resolveWriteTab(undefined) === null, 'blank/missing tab is rejected, not defaulted to Staff Tracker');
  assert(resolveWriteTab({ x: 1 } as any) === null, 'object-valued tab is rejected, not thrown on');

  // ...and validateNewTask surfaces that rejection as a clear error, writing nothing.
  const badAdd = validateNewTask({ tab: 'MIS_Closing_Report (Q)', taskDescription: 'x', emailId: 'a@b.com' });
  assert(!badAdd.ok && Boolean(badAdd.errors.tab) && badAdd.tab === '', 'malformed tab rejected with a reason, empty resolved tab');
  const badAdd2 = validateNewTask({ tab: 'Some Random Tab', taskDescription: 'x', emailId: 'a@b.com', dateAssigned: '2026-07-01' });
  assert(!badAdd2.ok && Boolean(badAdd2.errors.tab), 'a plausible-looking but unconfigured tab is rejected the same way');

  // A row added to an MIS register validates through the exact same report-shaped
  // rules Report Calendar uses (no Date Assigned column, free-text Review Timing),
  // and validateNewTask returns the SAME resolved tab the write will target.
  const misAdd = validateNewTask({ tab: 'MIS_Closing_Report (M)', taskDescription: 'New MIS item', emailId: 'a@b.com', dueDate: 'Monthly' });
  assert(misAdd.ok && misAdd.tab === 'MIS_Closing_Report (M)', 'a valid MIS row is accepted — report-shaped validation, tab echoed back exactly');
  const reportAdd = validateNewTask({ tab: 'Report Calendar', taskDescription: 'x', emailId: 'a@b.com' });
  assert(reportAdd.ok && reportAdd.tab === CONFIG.REPORT_CALENDAR_TAB, 'the "Report Calendar" alias resolves to the exact tab name in the result');

  // --- type coercion: the bug that wrote "[object Object]" to the live Sheet ---
  assert(scalarText({ x: 1 }) === null, 'object rejected, never stringified');
  assert(scalarText([1, 2]) === null, 'array rejected');
  assert(scalarText(undefined) === '' && scalarText(null) === '', 'missing -> blank');
  assert(scalarText('  padded  ') === 'padded', 'text is trimmed');
  assert(scalarText(42) === '42' && scalarText(true) === 'true', 'scalars coerce to text');

  // Object-shaped fields are rejected, not written.
  const objField = validateNewTask({ ...good, emailId: { b: 2 } as any });
  assert(!objField.ok && Boolean(objField.errors.emailId), 'object emailId rejected with an error');
  assert(objField.clean.emailId === '', 'rejected field is never carried into clean output');
  assert(!validateNewTask({ ...good, taskDescription: { a: 1 } as any }).ok, 'object description rejected');

  // Oversized text is rejected rather than written verbatim.
  const long = '1'.repeat(10_000);
  const oversize = validateNewTask({ ...good, dateAssigned: long });
  assert(!oversize.ok && Boolean(oversize.errors.dateAssigned), '10k-char date rejected on length');
  assert(!validateNewTask({ ...good, taskDescription: 'x'.repeat(MAX_TEXT_LENGTH + 1) }).ok, 'over-length description rejected');
  assert(validateNewTask({ ...good, taskDescription: 'x'.repeat(MAX_TEXT_LENGTH) }).ok, 'exactly max length still accepted');

  // Task Type must be one of the canonical options (blank = unspecified).
  assert(isAllowedTaskType('') && isAllowedTaskType('Daily'), 'blank and canonical types allowed');
  assert(!isAllowedTaskType('[object Object]'), '"[object Object]" is not a valid Task Type');
  assert(validateNewTask({ ...good, taskType: 'Monthly' }).ok, 'canonical task type accepted');
  assert(!validateNewTask({ ...good, taskType: 'Whenever' }).ok, 'unknown task type rejected');

  // Dates must parse — on the Staff Tracker only.
  assert(!validateNewTask({ ...good, dateAssigned: 'not-a-date' }).ok, 'unparseable Date Assigned rejected');
  assert(validateNewTask({ ...good, dateAssigned: '18-Jun-26' }).ok, 'hand-entered sheet date format accepted');
  assert(!validateNewTask({ ...good, dueDate: 'garbage' }).ok, 'unparseable Staff Tracker due date rejected');
  // Report Calendar's "dueDate" is free-text Review Timing, so it must NOT be date-checked.
  assert(
    validateNewTask({ tab: '4. Report Calendar', taskDescription: 'Monthly MIS', emailId: 'a@b.com', dueDate: 'Morning (8:00 AM)' }).ok,
    'Review Timing text accepted on Report Calendar'
  );

  // Clean output is what the route writes — trimmed, coerced, safe to .trim() again.
  const cleaned = validateNewTask({ ...good, taskDescription: '  Q3 GST recon  ', assignedTo: 42 as any });
  assert(cleaned.ok, 'trimmable/scalar input is valid');
  assert(cleaned.clean.taskDescription === 'Q3 GST recon', 'clean output is trimmed');
  assert(cleaned.clean.assignedTo === '42', 'numeric field coerced to text');

  // --- readBody: an oversized body must stop the stream, not just reject once ---
  // (the security-audit fix: rejecting the Promise alone left `raw += chunk`
  // running forever on every further byte a client kept sending)
  {
    const fakeReq: any = new EventEmitter();
    let destroyCalls = 0;
    fakeReq.destroy = () => { destroyCalls++; };
    const promise = readBody(fakeReq);

    // Two 600KB chunks cross the 1MB cap on the second one; two more AFTER that
    // simulate a client that keeps sending anyway — exactly the scenario that
    // used to keep `raw` growing forever even after the Promise had rejected.
    const chunk = Buffer.alloc(600_000, 'x');
    fakeReq.emit('data', chunk); // 600KB — under the cap, no action yet
    fakeReq.emit('data', chunk); // 1.2MB — crosses the cap: reject + destroy (call #1)
    fakeReq.emit('data', chunk); // must be ignored by the `done` guard, not a 2nd destroy
    fakeReq.emit('data', chunk); // must also be ignored
    assert(destroyCalls === 1, 'oversized body: req.destroy() called exactly once — later chunks ignored, not reprocessed');
    await promise.then(
      () => assert(false, 'an oversized body must not resolve'),
      err => assert(err instanceof BadRequest && /too large/.test(err.message), 'oversized body rejects as BadRequest with the expected message')
    );
  }
  {
    // A well-behaved small request must still resolve normally — the refactor
    // that added the `done` guard must not have broken the ordinary path.
    const fakeReq: any = new EventEmitter();
    fakeReq.destroy = () => {};
    const promise = readBody(fakeReq);
    fakeReq.emit('data', Buffer.from('{"a":1}'));
    fakeReq.emit('end');
    const result = await promise;
    assert(result.a === 1, 'a small valid JSON body still resolves normally');
  }
  {
    const fakeReq: any = new EventEmitter();
    fakeReq.destroy = () => {};
    const promise = readBody(fakeReq);
    fakeReq.emit('data', Buffer.from('not json'));
    fakeReq.emit('end');
    await promise.then(
      () => assert(false, 'invalid JSON must not resolve'),
      err => assert(err instanceof BadRequest && /Invalid JSON/.test(err.message), 'invalid JSON still rejected as BadRequest')
    );
  }
  {
    const fakeReq: any = new EventEmitter();
    fakeReq.destroy = () => {};
    const promise = readBody(fakeReq);
    fakeReq.emit('data', Buffer.from('[1,2,3]'));
    fakeReq.emit('end');
    await promise.then(
      () => assert(false, 'an array body must not resolve'),
      err => assert(err instanceof BadRequest && /must be a JSON object/.test(err.message), 'array body still rejected — must be a plain object')
    );
  }

  // --- isAllowedOrigin: CSRF check — only a MISMATCHED Origin is rejected ---
  assert(isAllowedOrigin(undefined, 'dashboard.example.com'), 'no Origin header at all -> allowed (non-browser clients, some same-origin requests)');
  assert(isAllowedOrigin(null, 'dashboard.example.com'), 'null Origin -> allowed');
  assert(isAllowedOrigin('https://dashboard.example.com', 'dashboard.example.com'), 'matching origin (https, no port) -> allowed');
  assert(isAllowedOrigin('http://localhost:4000', 'localhost:4000'), 'matching origin with a port -> allowed');
  assert(!isAllowedOrigin('https://evil.example.com', 'dashboard.example.com'), 'mismatched origin -> rejected (the actual CSRF defense)');
  assert(!isAllowedOrigin('http://localhost:4000', 'localhost:5000'), 'same host, different port -> rejected — host comparison includes the port');
  assert(!isAllowedOrigin('not a url', 'dashboard.example.com'), 'an Origin header that is not even a valid URL -> rejected, not thrown on');

  // --- isOversizedDigestBatch: the manual staff-reminder send cap ---
  assert(!isOversizedDigestBatch(1), 'a single item is never oversized');
  assert(!isOversizedDigestBatch(MAX_STAFF_DIGEST_BATCH), 'exactly the cap is still allowed');
  assert(isOversizedDigestBatch(MAX_STAFF_DIGEST_BATCH + 1), 'one over the cap is rejected');
  assert(isOversizedDigestBatch(10_000), 'a large batch is rejected');

  // --- parseBasicAuthPair: split on the FIRST colon only ---
  assert(
    JSON.stringify(parseBasicAuthPair('user:pass')) === JSON.stringify({ user: 'user', password: 'pass' }),
    'ordinary "user:pass" splits correctly'
  );
  assert(
    JSON.stringify(parseBasicAuthPair('user:pass:word')) === JSON.stringify({ user: 'user', password: 'pass:word' }),
    'a password containing a colon is kept whole, not truncated at the second colon — the actual bug this fixes'
  );
  assert(
    JSON.stringify(parseBasicAuthPair('user:a:b:c')) === JSON.stringify({ user: 'user', password: 'a:b:c' }),
    'multiple colons in the password all stay in the password'
  );
  assert(
    JSON.stringify(parseBasicAuthPair('justauser')) === JSON.stringify({ user: 'justauser', password: '' }),
    'no colon at all -> empty password, not a crash'
  );
  assert(
    JSON.stringify(parseBasicAuthPair(':onlypassword')) === JSON.stringify({ user: '', password: 'onlypassword' }),
    'empty user before the colon is preserved as empty, not dropped'
  );

  // --- selectBlockingApprovals: the pending-approval guard on row deletion ---
  {
    const STAFF = CONFIG.STAFF_TRACKER_TAB;
    const REPORT = CONFIG.REPORT_CALENDAR_TAB;
    const now = new Date('2026-09-22T12:00:00.000Z');
    const live = '2026-09-22T15:00:00.000Z';   // 3h ahead of `now` — inside the 4h window
    const lapsed = '2026-09-22T09:00:00.000Z'; // 3h behind `now` — window already closed

    const digest = (tab: string, rowIndex: number, taskDescription: string) => ({
      recipientEmail: 'a@b.com',
      items: [{ tabName: tab, rowIndex, taskDescription }],
    });
    const run = (over: Partial<ApprovalRow>): ApprovalRow => ({
      run_id: 'RUN-1', status: 'PENDING', created_at: '2026-09-22T11:00:00.000Z',
      expires_at: live, reminders_json: [digest(STAFF, 7, 'GST recon')], ...over,
    });

    // (a) pending + unexpired on the SAME tab -> blocks
    const sameTab = selectBlockingApprovals([run({})], STAFF, now);
    assert(sameTab.length === 1, '(a) pending unexpired approval on this tab blocks the delete');
    assert(sameTab[0].runId === 'RUN-1', '(a) the blocking run is identified by its run id');
    assert(sameTab[0].descriptions[0] === 'GST recon', '(a) the blocked task is named for the 409 message');

    // (b) pending + unexpired but a DIFFERENT tab -> does not block
    assert(
      selectBlockingApprovals([run({})], REPORT, now).length === 0,
      '(b) a pending approval on another tab never blocks this tab'
    );
    assert(
      selectBlockingApprovals([run({ reminders_json: [digest(REPORT, 3, 'Daily bank position')] })], STAFF, now).length === 0,
      '(b) matching is by the tabName inside reminders_json, not merely "an approval exists"'
    );

    // (c) status PENDING but the window has already lapsed -> does not block
    assert(
      selectBlockingApprovals([run({ expires_at: lapsed })], STAFF, now).length === 0,
      '(c) a lapsed PENDING run does not block — nothing sweeps it to EXPIRED, but it can never dispatch'
    );
    assert(
      selectBlockingApprovals([run({ expires_at: now.toISOString() })], STAFF, now).length === 0,
      '(c) expiry exactly at now is already closed, not still open'
    );

    // Already-actioned runs never block, whatever their window says.
    assert(selectBlockingApprovals([run({ status: 'APPROVED' })], STAFF, now).length === 0, 'APPROVED run does not block');
    assert(selectBlockingApprovals([run({ status: 'EXPIRED' })], STAFF, now).length === 0, 'EXPIRED run does not block');

    // --- FAIL CLOSED: an unreadable row blocks rather than being skipped ---
    // Each of these once returned "nothing blocking", which silently permitted
    // the delete. A shape we cannot read cannot be proven harmless.
    for (const bad of [null, undefined, {}, '[]', [{ items: 'nope' }], [null]]) {
      const got = selectBlockingApprovals([run({ reminders_json: bad as any })], STAFF, now);
      const label = `unreadable reminders_json (${JSON.stringify(bad) ?? 'undefined'})`;
      assert(got.length === 1, `${label} BLOCKS instead of being ignored`);
      assert(got[0].unverified === true, `${label} is flagged unverified, not reported as a known item`);
      assert(got[0].runId === 'RUN-1', `${label} still names the run so it can be checked by hand`);
      assert(got[0].descriptions.length === 0, `${label} claims no task names it could not actually read`);
    }
    assert(
      selectBlockingApprovals([run({ expires_at: 'not-a-date' })], STAFF, now)[0]?.unverified === true,
      'an unreadable expires_at blocks — the window cannot be proven closed'
    );

    // ...but fail-closed must not become block-everything: a row that reads
    // cleanly and belongs to another tab still does not block.
    assert(selectBlockingApprovals([], STAFF, now).length === 0, 'no approvals at all -> nothing blocks');
    assert(
      selectBlockingApprovals([run({ reminders_json: [digest(REPORT, 3, 'Daily bank position')] })], STAFF, now).length === 0,
      'a well-formed approval for another tab is still not blocking after the inversion'
    );
    // A readable digest whose items simply do not mention this tab is verified,
    // not unverified — an empty items array is a legitimate, readable shape.
    assert(
      selectBlockingApprovals([run({ reminders_json: [{ recipientEmail: 'a@b.com', items: [] }] })], STAFF, now).length === 0,
      'an empty items array is readable and non-blocking, not "unverified"'
    );
    // A mixed row: one readable digest for another tab + one unreadable digest.
    // The unreadable half cannot be ruled out, so the row blocks.
    const mixed = selectBlockingApprovals(
      [run({ reminders_json: [digest(REPORT, 3, 'other tab'), { items: 'nope' }] })], STAFF, now
    );
    assert(mixed.length === 1 && mixed[0].unverified === true, 'a partially unreadable row blocks on the unreadable part');
    // An item missing its tabName is an unrecognised shape, so it blocks too.
    assert(
      selectBlockingApprovals([run({ reminders_json: [{ items: [{ rowIndex: 4, taskDescription: 'no tab' }] }] })], STAFF, now)[0]?.unverified === true,
      'an item with no tabName cannot be ruled out'
    );

    // Several rows on one tab collapse to one entry per run, de-duplicated.
    const multi = selectBlockingApprovals(
      [run({ reminders_json: [digest(STAFF, 7, 'GST recon'), digest(STAFF, 9, 'GST recon'), digest(STAFF, 11, 'Bank recon')] })],
      STAFF, now
    );
    assert(multi.length === 1 && multi[0].descriptions.length === 2, 'repeated task names are de-duplicated for the message');

    // An item with no description still names the row, never "undefined".
    const unnamed = selectBlockingApprovals([run({ reminders_json: [digest(STAFF, 42, '')] })], STAFF, now);
    assert(unnamed[0].descriptions[0] === 'row 42', 'a blank task description falls back to the row number');

    // --- formatBlockingApprovalError: what the operator actually reads ---
    const msg = formatBlockingApprovalError(sameTab, STAFF);
    assert(msg.includes('RUN-1') && msg.includes('GST recon'), 'the 409 names the run and the task');
    assert(msg.includes('discard:run'), 'the 409 tells the operator how to clear the block');
    assert(msg.includes('2026-09-22 11:00'), 'the 409 says when the blocking run was drafted');
    const manyMsg = formatBlockingApprovalError(
      [{ runId: 'RUN-2', createdAt: '2026-09-22T11:00:00.000Z', descriptions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], unverified: false }],
      STAFF
    );
    assert(manyMsg.includes('+2 more'), 'a long blocking list is truncated rather than dumped whole');

    // The unverified 409 must say WHY it refused, and must not invent a task name.
    const unverifiedMsg = formatBlockingApprovalError(
      selectBlockingApprovals([run({ reminders_json: null as any })], STAFF, now), STAFF
    );
    assert(unverifiedMsg.includes('RUN-1'), 'the unverified 409 names the run_id for manual checking');
    assert(unverifiedMsg.includes('UNREADABLE'), 'the unverified 409 says the contents could not be read');
    assert(unverifiedMsg.includes('could not be verified'), 'the unverified 409 distinguishes itself from a normal block');
    assert(unverifiedMsg.includes('discard:run'), 'the unverified 409 still tells the operator how to clear it');
  }

  // --- sourceFingerprint: the stale-server detector ---
  {
    const tmp = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ccc-fp-'));
    try {
      fs.mkdirSync(path.join(tmp, 'sub'));
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const a = 1;');
      fs.writeFileSync(path.join(tmp, 'sub', 'b.ts'), 'export const b = 2;');
      const base = sourceFingerprint([tmp]);
      assert(sourceFingerprint([tmp]) === base, 'fingerprint is stable when nothing changed');

      fs.writeFileSync(path.join(tmp, 'sub', 'b.ts'), 'export const b = 3;');
      assert(sourceFingerprint([tmp]) !== base, 'editing a nested source file changes the fingerprint (server is stale)');
      fs.writeFileSync(path.join(tmp, 'sub', 'b.ts'), 'export const b = 2;');
      assert(sourceFingerprint([tmp]) === base, 'reverting the edit restores the fingerprint');

      fs.writeFileSync(path.join(tmp, 'x.test.ts'), 'test');
      fs.writeFileSync(path.join(tmp, 'notes.md'), 'notes');
      assert(sourceFingerprint([tmp]) === base, 'test files and non-.ts files never mark the server stale');

      fs.writeFileSync(path.join(tmp, 'c.ts'), 'export const c = 4;');
      assert(sourceFingerprint([tmp]) !== base, 'a new source file changes the fingerprint');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // --- toISODateInput: feeds <input type="date"> pre-fill in the Edit form ---
  assert(toISODateInput('18-Jun-26') === '2026-06-18', 'sheet-format date -> ISO for the date input');
  assert(toISODateInput('6/21/2026') === '2026-06-21', 'slash date -> ISO for the date input');
  assert(toISODateInput('2026-07-28') === '2026-07-28', 'already-ISO date is stable');
  assert(toISODateInput('') === '', 'blank stays blank, never becomes today');
  assert(toISODateInput('Morning (8:00 AM)') === '', 'non-date text (Review Timing) -> blank, not garbage');

  // toDashboardTask carries both the display copy and the edit-form ISO copy,
  // without disturbing the raw round-trip field writes still depend on.
  {
    const unified: any = {
      tabName: CONFIG.STAFF_TRACKER_TAB, rowIndex: 5, idNum: '3', taskDescriptionOrName: 'Recon',
      assignedToName: 'Accounts team', personName: 'Karnesh',
      emailId: 'a@b.com', taskType: 'Monthly', dateAssigned: '18-Jun-26',
      dueDate: '21-Jun-26', currentStatus: 'Pending', remarks: '', threadId: '', daysOrOverdueDays: '', isValid: true,
    };
    const flat = toDashboardTask(unified);
    // personName is carried through separately from assignedTo — the Name column
    // displays the former, while edits still round-trip the latter.
    assert(flat.personName === 'Karnesh', 'the Sheet person column is exposed as personName');
    assert(flat.assignedTo === 'Accounts team', 'the Assigned To / Source value is still carried, unchanged');
    assert(flat.dateAssigned === '18-Jun-26', 'raw dateAssigned untouched, for write round-trips');
    assert(flat.dateAssignedDisplay === '18-Jun-26', 'display copy formatted DD-Mon-YY');
    assert(flat.dateAssignedISO === '2026-06-18', 'edit-form copy formatted YYYY-MM-DD');
    assert(flat.dueDateISO === '2026-06-21', 'due date gets the same ISO treatment');
  }

  // --- personStatusCounts: Employee Monitor groups by person, not by inbox ---
  {
    const row = (personName: string, emailId: string, currentStatus: string, isValid = true): any =>
      ({ personName, emailId, currentStatus, isValid });
    const rows = [
      row('Gourav Ranka', 'accounts@mbapl.com', 'Pending'),
      row('Gourav Ranka', 'accounts@mbapl.com', 'Overdue'),
      row('Sonam', 'accounts@mbapl.com', 'Received'),
      row('  karnesh ', 'banking@ostwal.in', 'Pending'),
      row('Karnesh', 'Accounts@mbapl.com', 'Pending'),
      row('Vivek', 'vivek@mbapl.com', 'Pending'),
      row('Vivek Sir', 'vivek@mbapl.com', 'Pending'),
      row('', 'x@y.com', 'Pending'),
      row('Gourav Ranka', 'accounts@mbapl.com', 'Pending', false), // invalid: never counted
    ];
    const people = personStatusCounts(rows);
    const by = (n: string) => people.find(p => p.name.toLowerCase() === n.toLowerCase());
    assert(by('Gourav Ranka')?.total === 2 && by('Sonam')?.total === 1, 'a shared inbox splits into the people named on its rows');
    assert(by('Karnesh')?.total === 2 && by('Karnesh')!.emails.length === 2, 'one person across two inboxes is one bar; case/space variants merge');
    assert(Boolean(by('Vivek')) && Boolean(by('Vivek Sir')), '"Vivek" and "Vivek Sir" stay separate — no guessing who is who');
    assert(people.some(p => p.blank && p.total === 1), 'a blank Name gets its own bucket, not dropped');
    assert(people.reduce((n, p) => n + p.total, 0) === 8, 'bars sum to every VALID row, invalid ones excluded');
    assert(by('Gourav Ranka')?.counts.overdue === 1 && by('Gourav Ranka')?.counts.pending === 1, 'counts are by status category');
    assert(people[0].name === 'Gourav Ranka', 'sorted by row count, ties broken by overdue load');
    assert(people[1].name.toLowerCase() === 'karnesh', 'then alphabetically — deterministic at the top-N cut line');
  }

  console.log('✅ dashboard/logic.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('dashboard/logic.ts')) {
  demo().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
