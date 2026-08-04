/**
 * Digest eligibility + digest content regression tests.
 *
 * Run: npm run check:cadence
 */
import { CadenceEngine, buildDigestContent, CHRONIC_REMINDER_CAP, DigestItem } from './cadence.js';
import { NO_MAIL_TASK_TYPE } from '../util/task-type.js';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

/** A due date `hoursAgo` in the past, as an ISO string (keeps the time of day). */
function dueHoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
}

const ev = (taskType: string, dueDateStr: string, remindersThisPeriod = 0, status = 'Pending') =>
  CadenceEngine.evaluateDigestEligibility(status, taskType, dueDateStr, remindersThisPeriod);

// --- Every cadence answers the same question now: is it due or overdue? ------
{
  for (const type of ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Routine', '']) {
    assert(ev(type, dueHoursAgo(48)).eligible, `${type || '(blank)'}: overdue -> eligible`);
    assert(!ev(type, dueHoursAgo(-48)).eligible, `${type || '(blank)'}: not yet due -> not eligible`);
  }

  // The old +1h / +4h daily escalation is gone: a daily row 2h past due is
  // simply "due", with no separate 1h vs 4h treatment.
  const daily2h = ev('Daily', dueHoursAgo(2));
  const daily5h = ev('Daily', dueHoursAgo(5));
  assert(daily2h.eligible && daily5h.eligible, 'daily is eligible whenever overdue');
  assert(daily2h.overdueDays === 0 && daily5h.overdueDays === 0, 'sub-day overdue counts as 0 days');
}

// --- Received rows are never chased -----------------------------------------
{
  assert(!ev('Monthly', dueHoursAgo(999), 0, 'Received').eligible, 'Received: not eligible');
  assert(!ev('Daily', dueHoursAgo(999), 0, 'Received (Early)').eligible, 'Received (Early): not eligible');
}

// --- "No Mail Sent" is excluded outright ------------------------------------
{
  const suppressed = ev(NO_MAIL_TASK_TYPE, dueHoursAgo(9999));
  assert(!suppressed.eligible, 'No Mail Sent: never eligible, however overdue');
  assert(suppressed.reason.includes('No Mail Sent'), 'reason names the suppression');
  assert(!suppressed.chronicallyOverdue, 'suppressed rows are not "chronic" — they are simply opted out');

  // Flipping the type back restores eligibility with no residual state.
  assert(ev('Weekly', dueHoursAgo(9999)).eligible, 'No Mail Sent -> Weekly is immediately eligible again');
}

// --- The per-period cap now applies to EVERY cadence, daily included --------
{
  assert(CHRONIC_REMINDER_CAP === 10, 'cap is 10 per period');

  for (const type of ['Daily', 'Monthly', 'Weekly', 'Quarterly', '']) {
    const below = ev(type, dueHoursAgo(48), CHRONIC_REMINDER_CAP - 1);
    assert(below.eligible && !below.chronicallyOverdue, `${type || '(blank)'}: eligible below the cap`);

    const at = ev(type, dueHoursAgo(48), CHRONIC_REMINDER_CAP);
    assert(!at.eligible, `${type || '(blank)'}: stops at the cap`);
    assert(at.chronicallyOverdue, `${type || '(blank)'}: flagged chronically overdue at the cap`);
  }

  // A row that isn't due yet is never "chronic", regardless of history.
  assert(!ev('Monthly', dueHoursAgo(-48), 99).chronicallyOverdue, 'future-dated row is never chronic');
}

// --- Unparseable dates fail closed ------------------------------------------
{
  assert(!ev('Daily', 'Morning (8:00 AM)').eligible, 'unparseable due date -> not eligible');
  assert(!ev('Daily', '').eligible, 'blank due date -> not eligible');
  // The abbreviated-month format that used to break parsing still works.
  assert(ev('Routine', '21-Jun-26').eligible, '"21-Jun-26" parses and is overdue');
}

// --- Digest content: one email, every item listed ---------------------------
{
  const items: DigestItem[] = [
    { tabName: '3. Staff Tracker', rowIndex: 6, taskDescription: 'Bank statement reconciliation', dueLabel: '21-Jun-26', overdueDays: 38 },
    { tabName: '4. Report Calendar', rowIndex: 9, taskDescription: 'Debtor/creditor movement', dueLabel: 'Morning', overdueDays: 0 },
    { tabName: '4. Report Calendar', rowIndex: 15, taskDescription: 'Group P&L (consolidated)', dueLabel: '5th of month', overdueDays: 24 },
  ];

  const { subject, body } = buildDigestContent('Karnesh', items);

  // ONE email covering everything — the whole point of the change.
  assert(subject.includes('3 items'), 'subject states the combined count');
  items.forEach(i => assert(body.includes(i.taskDescription), `body lists "${i.taskDescription}"`));
  assert(body.includes('Karnesh'), 'addressed to the recipient');
  assert(body.split('OGI Finance Office').length === 2, 'signed exactly once — it is one email, not three concatenated');

  // Most-overdue first, so the worst item leads.
  const posWorst = body.indexOf('Bank statement reconciliation');
  const posMid = body.indexOf('Group P&L');
  const posLeast = body.indexOf('Debtor/creditor movement');
  assert(posWorst < posMid && posMid < posLeast, 'items ordered most-overdue first');

  assert(body.includes('38 days overdue'), 'overdue age rendered');
  assert(body.includes('due today'), 'a 0-day item reads "due today", not "0 days overdue"');

  // Singular wording when there is only one item.
  const one = buildDigestContent('Vivek', [items[0]]);
  assert(one.subject.includes('Bank statement reconciliation'), 'single-item subject names the task');
  assert(!one.subject.includes('items'), 'single item does not say "items"');
  assert(one.body.includes('The following item is awaiting'), 'singular body wording');

  // Missing name must not render "Hi ,"
  assert(buildDigestContent('', items).body.startsWith('Hi there,'), 'blank recipient name falls back to "there"');
}

console.log('✅ src/classifier/cadence.test.ts — digest eligibility and content assertions passed');
