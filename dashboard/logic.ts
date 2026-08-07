/**
 * Pure dashboard logic — categorisation + new-task validation.
 * Kept separate from server.ts so it can be self-checked without booting a server.
 * Run the self-check with: npm run check:dashboard
 */
import { CONFIG } from '../src/config/index.js';
import { UnifiedTask } from '../src/types/index.js';
import { TASK_TYPE_OPTIONS } from '../src/util/task-type.js';
import { parseSheetDate } from '../src/util/parse-date.js';

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

/** Flatten a UnifiedTask into the shape the frontend renders. */
export function toDashboardTask(t: UnifiedTask) {
  return {
    tabName: t.tabName,
    rowIndex: t.rowIndex,
    idNum: t.idNum,
    taskDescription: t.taskDescriptionOrName,
    assignedTo: t.assignedToName,
    emailId: t.emailId,
    taskType: t.taskType,
    dateAssigned: t.dateAssigned,
    dueDate: t.dueDate,
    status: t.currentStatus,
    remarks: t.remarks,
    threadId: t.threadId,
    days: t.daysOrOverdueDays,
    isValid: t.isValid,
    validationIssue: t.validationIssue || '',
    category: categorize(t.currentStatus, t.isValid),
  };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
function demo() {
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

  console.log('✅ dashboard/logic.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('dashboard/logic.ts')) {
  demo();
}
