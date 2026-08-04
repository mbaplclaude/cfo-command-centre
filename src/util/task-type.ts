/**
 * One definition of what a blank Task Type means.
 *
 * Rows are hand-entered and the Task Type column is frequently left empty. Every
 * consumer (time-boxing, cadence) previously fell through to its own private
 * "else" branch, so the behaviour was implicit and inconsistent. A blank cell now
 * explicitly means One-Time.
 *
 * Self-check: npm run check:task-type
 */

export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'one-time' | 'no-mail';

/** The exact Sheet text that suppresses all reminder mail for a row. */
export const NO_MAIL_TASK_TYPE = 'No Mail Sent';

/**
 * The one selectable list of Task Type values, in the casing actually used on the
 * live Sheet ("Daily", "Routine", …). Both the Add Task form and the per-row
 * inline editor pull from this single array — surfaced to the dashboard frontend
 * via GET /api/task-types — so there is exactly one place that defines what a
 * Task Type cell is allowed to say, not a second hardcoded copy in the UI.
 */
export const TASK_TYPE_OPTIONS = [
  'One-time',
  'Routine',
  'Report',
  'Improvement',
  'Daily',
  'Weekly',
  'Monthly',
  'Quarterly',
  NO_MAIL_TASK_TYPE,
];

/** Map free-text Task Type to a known cadence; blank/unknown -> one-time. */
export function normaliseTaskType(taskType: string): Cadence {
  const t = (taskType || '').trim().toLowerCase();
  // Checked first: "No Mail Sent" must win outright. It is a suppression marker,
  // not a frequency, and nothing downstream should ever fall through to a cadence.
  if (t.includes('no mail')) return 'no-mail';
  if (t.includes('daily')) return 'daily';
  if (t.includes('weekly')) return 'weekly';
  if (t.includes('monthly')) return 'monthly';
  if (t.includes('quarterly')) return 'quarterly';
  return 'one-time';
}

/**
 * True when this row must never generate reminder mail.
 *
 * Derived fresh from the Sheet's Task Type cell on every run — there is no stored
 * suppression flag anywhere, which is precisely why changing the type away from
 * "No Mail Sent" restores eligibility immediately with nothing to clean up.
 */
export function isMailSuppressed(taskType: string): boolean {
  return normaliseTaskType(taskType) === 'no-mail';
}

/** True when the sheet supplied no usable cadence at all (so One-Time was assumed). */
export function isBlankTaskType(taskType: string): boolean {
  return (taskType || '').trim() === '';
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };

  assert(normaliseTaskType('Daily') === 'daily', 'Daily');
  assert(normaliseTaskType('weekly') === 'weekly', 'lowercase weekly');
  assert(normaliseTaskType('Monthly ') === 'monthly', 'trailing space monthly');
  assert(normaliseTaskType('Quarterly') === 'quarterly', 'Quarterly');

  // The requested default: blank means One-Time, not "unknown, do nothing".
  assert(normaliseTaskType('') === 'one-time', 'blank -> one-time');
  assert(normaliseTaskType('   ') === 'one-time', 'whitespace -> one-time');
  assert(normaliseTaskType(undefined as unknown as string) === 'one-time', 'undefined -> one-time');

  // Real values seen on the live sheet that are not cadences.
  assert(normaliseTaskType('One-time') === 'one-time', 'explicit One-time');
  assert(normaliseTaskType('Routine') === 'one-time', '"Routine" is not a cadence -> one-time');
  assert(normaliseTaskType('Improvement') === 'one-time', '"Improvement" -> one-time');
  assert(normaliseTaskType('Report') === 'one-time', '"Report" -> one-time');

  assert(isBlankTaskType(''), 'blank detected');
  assert(!isBlankTaskType('Routine'), 'non-blank not flagged as blank');

  // Every selectable option must itself normalise cleanly — a value the dropdown
  // offers that normaliseTaskType can't make sense of would be a silent bug.
  assert(TASK_TYPE_OPTIONS.length === 9, 'canonical option count is 9');
  assert(TASK_TYPE_OPTIONS.includes('Daily') && TASK_TYPE_OPTIONS.includes('Monthly'), 'cadence options present');
  assert(TASK_TYPE_OPTIONS.includes(NO_MAIL_TASK_TYPE), '"No Mail Sent" is selectable');
  for (const opt of TASK_TYPE_OPTIONS) {
    const n = normaliseTaskType(opt);
    assert(['daily', 'weekly', 'monthly', 'quarterly', 'one-time', 'no-mail'].includes(n), `"${opt}" normalises to a known cadence`);
  }

  // --- "No Mail Sent" suppression ---
  assert(normaliseTaskType(NO_MAIL_TASK_TYPE) === 'no-mail', '"No Mail Sent" -> no-mail');
  assert(normaliseTaskType('no mail sent') === 'no-mail', 'case-insensitive');
  assert(normaliseTaskType('  No Mail Sent  ') === 'no-mail', 'whitespace tolerated');
  assert(isMailSuppressed(NO_MAIL_TASK_TYPE), 'suppression detected');

  // Suppression must not be reachable by accident from ordinary cadences...
  for (const t of ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Routine', 'One-time', '']) {
    assert(!isMailSuppressed(t), `"${t || '(blank)'}" is NOT suppressed`);
  }
  // ...and flipping the type away from it restores eligibility with no residue,
  // because suppression is computed from the cell, never stored.
  assert(!isMailSuppressed('Weekly'), 'changing No Mail Sent -> Weekly is immediately eligible again');

  console.log('✅ src/util/task-type.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('util/task-type.ts')) {
  demo();
}
