/**
 * Regression tests for time-boxing window enforcement.
 *
 * The property under test: a submission only satisfies the CURRENT period. A
 * daily report due 26-Jul is not satisfied by a 20-Jul or 25-Jul email, however
 * genuine that email was for its own day. Without this, one submission would
 * close a recurring row forever.
 *
 * Run: npm run check:timebox
 */
import { TimeBoxMatcher } from './timebox.js';
import { resolveReportPeriod } from './report-schedule.js';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// --- Daily: only the due day itself counts -----------------------------------
// A daily report due 26-Jul-26, window = 26-Jul 00:00 .. 26-Jul 23:59.
{
  const dailyPeriod = resolveReportPeriod('Morning (8:00 AM)', 'Daily', new Date(2026, 6, 26, 13, 0));
  assert(dailyPeriod !== null, 'daily period resolves');
  const windowStart = dailyPeriod!.periodStart.toISOString();
  const due = dailyPeriod!.dueDate.toISOString();

  const sixDaysEarly = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 20, 9, 0), windowStart, due, 'Daily');
  assert(!sixDaysEarly.isWithin, 'daily due 26-Jul is NOT satisfied by a 20-Jul submission');

  const oneDayEarly = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 25, 9, 0), windowStart, due, 'Daily');
  assert(!oneDayEarly.isWithin, 'daily due 26-Jul is NOT satisfied by a 25-Jul submission');

  const onTime = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 26, 7, 30), windowStart, due, 'Daily');
  assert(onTime.isWithin, 'a submission on the due day IS within the daily window');
  assert(onTime.isEarly, 'before 08:00 on the due day counts as early');

  const lateSameDay = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 26, 20, 0), windowStart, due, 'Daily');
  assert(lateSameDay.isWithin, 'later the same day is still inside the daily window');
  assert(!lateSameDay.isEarly, 'after the due time is not early');

  const nextDay = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 27, 8, 0), windowStart, due, 'Daily');
  assert(!nextDay.isWithin, 'the following day falls outside the daily window');
}

// --- Weekly: the ISO week of the due date ------------------------------------
{
  // Week of Mon 27-Jul-26, due Friday 31-Jul.
  const weekly = resolveReportPeriod('Every Friday', 'Weekly', new Date(2026, 6, 29, 13, 0));
  const windowStart = weekly!.periodStart.toISOString();
  const due = weekly!.dueDate.toISOString();

  const previousWeek = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 24, 9, 0), windowStart, due, 'Weekly');
  assert(!previousWeek.isWithin, 'weekly due 31-Jul is NOT satisfied by a 24-Jul (previous week) submission');

  const insideWeek = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 29, 9, 0), windowStart, due, 'Weekly');
  assert(insideWeek.isWithin, 'a mid-week submission IS within the weekly window');
}

// --- Monthly: the calendar month of the due date -----------------------------
{
  // July 2026, due 15-Jul.
  const monthly = resolveReportPeriod('15th of month', 'Monthly', new Date(2026, 6, 20, 13, 0));
  const windowStart = monthly!.periodStart.toISOString();
  const due = monthly!.dueDate.toISOString();

  const lastMonth = TimeBoxMatcher.isWithinWindow(new Date(2026, 5, 15, 9, 0), windowStart, due, 'Monthly');
  assert(!lastMonth.isWithin, 'monthly due 15-Jul is NOT satisfied by a 15-Jun submission');

  const sameMonth = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 14, 9, 0), windowStart, due, 'Monthly');
  assert(sameMonth.isWithin, 'a submission earlier the same month IS within the monthly window');

  const nextMonth = TimeBoxMatcher.isWithinWindow(new Date(2026, 7, 2, 9, 0), windowStart, due, 'Monthly');
  assert(!nextMonth.isWithin, 'the next month falls outside the monthly window');
}

// --- Quarterly ---------------------------------------------------------------
{
  const quarterly = resolveReportPeriod('EOD', 'Quarterly', new Date(2026, 7, 10, 13, 0)); // Q3
  const windowStart = quarterly!.periodStart.toISOString();
  const due = quarterly!.dueDate.toISOString();

  const priorQuarter = TimeBoxMatcher.isWithinWindow(new Date(2026, 4, 15, 9, 0), windowStart, due, 'Quarterly');
  assert(!priorQuarter.isWithin, 'Q3 report is NOT satisfied by a Q2 (May) submission');

  const inQuarter = TimeBoxMatcher.isWithinWindow(new Date(2026, 7, 10, 9, 0), windowStart, due, 'Quarterly');
  assert(inQuarter.isWithin, 'an in-quarter submission IS within the quarterly window');
}

// --- Abbreviated-month dates now time-box instead of failing open ------------
{
  // This is the format that used to produce an Invalid Date.
  const late = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 15, 9, 0), '18-Jun-26', '21-Jun-26', 'Routine');
  assert(!late.isWithin, '15-Jul submission is outside a 21-Jun one-time window');
  assert(!late.reason.includes('could not be parsed'), '"21-Jun-26" parses now');

  const onTime = TimeBoxMatcher.isWithinWindow(new Date(2026, 5, 20, 9, 0), '18-Jun-26', '21-Jun-26', 'Routine');
  assert(onTime.isWithin, '20-Jun submission is inside an 18-Jun..21-Jun window');
}

// --- A blank Task Type behaves as One-Time ----------------------------------
{
  const blank = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 28, 9, 0), '2026-07-28', '2026-07-28', '');
  assert(blank.isWithin, 'blank Task Type time-boxes as one-time (due day window)');

  const afterBlank = TimeBoxMatcher.isWithinWindow(new Date(2026, 6, 29, 9, 0), '2026-07-28', '2026-07-28', '');
  assert(!afterBlank.isWithin, 'blank Task Type still rejects a next-day submission');
}

// --- Unparseable due date must fail CLOSED, never silently accept ------------
{
  const unparseable = TimeBoxMatcher.isWithinWindow(new Date(), '', 'Morning (8:00 AM)', 'Daily');
  assert(!unparseable.isWithin, 'an unparseable due date does not count as within window');
  assert(unparseable.reason.includes('could not be parsed'), 'the reason names the parse failure');
}

console.log('✅ src/classifier/timebox.test.ts — all time-boxing window assertions passed');
