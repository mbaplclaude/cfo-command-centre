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

/** Resolve a loose tab hint ("report", "4. Report Calendar") to a real sheet tab name. */
export function resolveTab(tab?: unknown): string {
  // scalarText, not `tab || ''`: an object-valued `tab` in a JSON body reached
  // .toLowerCase() here and threw before the route's own validation ever ran.
  return (scalarText(tab) || '').toLowerCase().includes('report')
    ? CONFIG.REPORT_CALENDAR_TAB
    : CONFIG.STAFF_TRACKER_TAB;
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
): { ok: boolean; errors: Record<string, string>; clean: CleanNewTask } {
  const errors: Record<string, string> = {};
  const tabName = resolveTab(input.tab);
  const isStaff = tabName === CONFIG.STAFF_TRACKER_TAB;

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

  return { ok: Object.keys(errors).length === 0, errors, clean };
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
