/**
 * Report Calendar rows carry no Date Assigned / Due Date — only a "Review Timing"
 * descriptor such as "Morning (8:00 AM)" or "Morning", plus a Task Type cadence
 * (Daily / Weekly / Monthly / Quarterly). This resolves those two fields into a
 * concrete window for the CURRENT period so the same time-boxing, classification
 * and cadence logic used for Staff Tracker rows can be applied to reports.
 *
 * Self-check: npm run check:report-schedule
 */

import { CONFIG } from '../config/index.js';
import { normaliseTaskType } from '../util/task-type.js';

export interface ReportPeriod {
  /** Start of the current period — used as the Gmail search floor and window start. */
  periodStart: Date;
  /** When this period's report is due, including time of day. */
  dueDate: Date;
  /** Human-readable due description for reminder emails. */
  label: string;
  cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
}

/** FINANCIAL_YEAR_START_MONTH (1-12) as a JS month index, clamped to a real month. */
function fyStartMonthIndex(): number {
  const m = CONFIG.FINANCIAL_YEAR_START_MONTH;
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m - 1 : 3; // default April
}

/**
 * Time of day a report is expected, parsed from the Review Timing text.
 *
 * A clock time must carry a colon or an am/pm marker — a bare number is NOT a
 * time. Otherwise "5th of month" parses as 05:00 and every monthly report ends
 * up due at dawn.
 */
function parseTimeOfDay(reviewTiming: string): { hour: number; minute: number } {
  const text = (reviewTiming || '').toLowerCase();

  const clock = text.match(/(\d{1,2}):(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)/);
  if (clock) {
    let hour = parseInt(clock[1] ?? clock[4], 10);
    const minute = clock[2] ? parseInt(clock[2], 10) : 0;
    const meridiem = clock[3] ?? clock[5];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }

  // Fall back to the named part of the day.
  if (text.includes('morning')) return { hour: 9, minute: 0 };
  if (text.includes('noon')) return { hour: 12, minute: 0 };
  if (text.includes('afternoon')) return { hour: 14, minute: 0 };
  if (text.includes('evening') || text.includes('eod') || text.includes('end of day')) {
    return { hour: 18, minute: 0 };
  }

  // ponytail: unspecified timing means end of business day; add a Due Time column
  // to the sheet if reports ever need per-row precision beyond this.
  return { hour: 18, minute: 0 };
}

/**
 * Grace period after a period end ("Q-end + 30 days", "Within 15 days of Q-end")
 * -> number of days to add. Ignoring it would chase people up to a month early.
 */
function parseGraceDays(reviewTiming: string): number {
  const text = (reviewTiming || '').toLowerCase();
  const match = text.match(/(?:\+\s*|within\s+)(\d{1,3})\s*(?:calendar\s*)?days?/);
  if (!match) return 0;
  const days = parseInt(match[1], 10);
  return days >= 0 && days <= 180 ? days : 0;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Named weekday in the Review Timing ("Every Monday") -> JS day index, or null.
 * Without this, a Monday report is chased on Friday.
 */
function parseWeekday(reviewTiming: string): number | null {
  const text = (reviewTiming || '').toLowerCase();
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (text.includes(WEEKDAYS[i]) || new RegExp(`\\b${WEEKDAYS[i].slice(0, 3)}\\b`).test(text)) {
      return i;
    }
  }
  return null;
}

/**
 * Day-of-month in the Review Timing ("5th of month", "day 10") -> 1-31, or null.
 * Without this, a report due on the 5th is treated as due at month end.
 */
function parseDayOfMonth(reviewTiming: string): number | null {
  const text = (reviewTiming || '').toLowerCase();
  const ordinal = text.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)\b/) || text.match(/\bday\s+(\d{1,2})\b/);
  if (!ordinal) return null;
  const day = parseInt(ordinal[1], 10);
  return day >= 1 && day <= 31 ? day : null;
}

function atTime(date: Date, hour: number, minute: number): Date {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function startOfDay(date: Date): Date {
  return atTime(date, 0, 0);
}

/**
 * Resolve the current period for a Report Calendar row.
 *
 * Returns null when Task Type carries no recognisable cadence — those rows are
 * skipped rather than guessed at, because guessing "daily" would email people
 * every day for a report that may be quarterly.
 */
export function resolveReportPeriod(
  reviewTiming: string,
  taskType: string,
  now: Date = new Date()
): ReportPeriod | null {
  const { hour, minute } = parseTimeOfDay(reviewTiming);
  const type = (taskType || '').toLowerCase();
  const timingText = (reviewTiming || '').trim();

  if (type.includes('daily')) {
    return {
      periodStart: startOfDay(now),
      dueDate: atTime(now, hour, minute),
      label: timingText || 'today',
      cadence: 'daily',
    };
  }

  if (type.includes('weekly')) {
    // ISO week starting Monday. Due on the weekday named in Review Timing
    // ("Every Monday"), else Friday.
    const daysSinceMonday = (now.getDay() + 6) % 7;
    const monday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday));
    const named = parseWeekday(reviewTiming);
    const offsetFromMonday = named === null ? 4 : (named + 6) % 7;
    const due = atTime(
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offsetFromMonday),
      hour,
      minute
    );
    return {
      periodStart: monday,
      dueDate: due,
      label: `${timingText || 'this week'} (due ${due.toLocaleDateString('en-IN')})`,
      cadence: 'weekly',
    };
  }

  if (type.includes('monthly')) {
    // Due on the day named in Review Timing ("5th of month"), else month end.
    const first = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const named = parseDayOfMonth(reviewTiming);
    // A named day is the deadline itself; otherwise it's month end plus any grace.
    const due =
      named === null
        ? atTime(addDays(new Date(now.getFullYear(), now.getMonth(), lastDayOfMonth), parseGraceDays(reviewTiming)), hour, minute)
        : atTime(new Date(now.getFullYear(), now.getMonth(), Math.min(named, lastDayOfMonth)), hour, minute);
    return {
      periodStart: first,
      dueDate: due,
      label: `${timingText || 'this month'} (due ${due.toLocaleDateString('en-IN')})`,
      cadence: 'monthly',
    };
  }

  // Checked BEFORE quarterly/monthly is irrelevant (no substring overlap), but it
  // must come before the fall-through. normaliseTaskType already rejects
  // "Half-Yearly", so anything landing here is a true 12-month cadence.
  if (normaliseTaskType(taskType) === 'yearly') {
    // Financial year, not calendar year: these registers are keyed to the Indian
    // FY (GSTR 9, depreciation run, year-end scrutiny). Configurable because the
    // FY start month is a business fact, not something this code can derive.
    const startMonth = fyStartMonthIndex();
    const fyStartYear = now.getMonth() >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
    const first = startOfDay(new Date(fyStartYear, startMonth, 1));
    // Day 0 of the start month, one year on = the last day of the FY.
    const lastDay = new Date(fyStartYear + 1, startMonth, 0);
    const due = atTime(addDays(lastDay, parseGraceDays(reviewTiming)), hour, minute);
    return {
      periodStart: first,
      dueDate: due,
      label: `${timingText || 'this year'} (due ${due.toLocaleDateString('en-IN')})`,
      cadence: 'yearly',
    };
  }

  if (type.includes('quarterly')) {
    const quarter = Math.floor(now.getMonth() / 3);
    const first = startOfDay(new Date(now.getFullYear(), quarter * 3, 1));
    const lastDay = new Date(now.getFullYear(), quarter * 3 + 3, 0);
    const due = atTime(addDays(lastDay, parseGraceDays(reviewTiming)), hour, minute);
    return {
      periodStart: first,
      dueDate: due,
      label: `${timingText || 'this quarter'} (due ${due.toLocaleDateString('en-IN')})`,
      cadence: 'quarterly',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };

  // Wednesday 2026-07-15, 13:00 local
  const now = new Date(2026, 6, 15, 13, 0, 0);

  // --- daily ---
  const daily = resolveReportPeriod('Morning (8:00 AM)', 'Daily', now)!;
  assert(daily.cadence === 'daily', 'daily cadence detected');
  assert(daily.dueDate.getHours() === 8 && daily.dueDate.getMinutes() === 0, 'daily due at 08:00');
  assert(daily.dueDate.getDate() === 15, 'daily due today');
  assert(daily.periodStart.getHours() === 0 && daily.periodStart.getDate() === 15, 'daily window starts today 00:00');

  // half-hour and 12-hour handling
  assert(resolveReportPeriod('Morning (8:30 AM)', 'Daily', now)!.dueDate.getMinutes() === 30, '8:30 AM minutes parsed');
  assert(resolveReportPeriod('Evening (5:00 PM)', 'Daily', now)!.dueDate.getHours() === 17, '5 PM -> 17:00');
  assert(resolveReportPeriod('Noon (12:00 PM)', 'Daily', now)!.dueDate.getHours() === 12, '12 PM -> 12:00');
  assert(resolveReportPeriod('(12:00 AM)', 'Daily', now)!.dueDate.getHours() === 0, '12 AM -> 00:00');

  // named part of day when no clock time is given
  assert(resolveReportPeriod('Morning', 'Daily', now)!.dueDate.getHours() === 9, 'bare "Morning" -> 09:00');
  assert(resolveReportPeriod('', 'Daily', now)!.dueDate.getHours() === 18, 'blank timing -> 18:00');

  // a bare number is not a clock time — "5th of month" must not become 05:00
  assert(resolveReportPeriod('5th of month', 'Monthly', now)!.dueDate.getHours() === 18, '"5th" is a date, not 5 AM');

  // --- weekly: Monday start, named weekday due, else Friday ---
  const weekly = resolveReportPeriod('Morning (9:00 AM)', 'Weekly', now)!;
  assert(weekly.periodStart.getDay() === 1 && weekly.periodStart.getDate() === 13, 'weekly starts Monday 13th');
  assert(weekly.dueDate.getDay() === 5 && weekly.dueDate.getDate() === 17, 'unnamed weekday -> Friday 17th');

  const mondayReport = resolveReportPeriod('Every Monday', 'Weekly', now)!;
  assert(mondayReport.dueDate.getDay() === 1 && mondayReport.dueDate.getDate() === 13, '"Every Monday" -> Monday 13th');
  const fridayReport = resolveReportPeriod('Every Friday', 'Weekly', now)!;
  assert(fridayReport.dueDate.getDay() === 5, '"Every Friday" -> Friday');
  assert(resolveReportPeriod('Every Wed', 'Weekly', now)!.dueDate.getDay() === 3, 'abbreviated "Wed" -> Wednesday');
  // Sunday is the END of the ISO week that started Monday, not the start of it
  assert(resolveReportPeriod('Every Sunday', 'Weekly', now)!.dueDate.getDate() === 19, '"Every Sunday" -> Sunday 19th');

  // Sunday must map back to the Monday that began the same ISO week
  const sunday = new Date(2026, 6, 19, 10, 0, 0);
  assert(resolveReportPeriod('Morning', 'Weekly', sunday)!.periodStart.getDate() === 13, 'Sunday maps to Monday 13th');

  // --- monthly: named day of month, else month end ---
  const monthly = resolveReportPeriod('EOD', 'Monthly', now)!;
  assert(monthly.periodStart.getDate() === 1 && monthly.periodStart.getMonth() === 6, 'monthly starts 1 Jul');
  assert(monthly.dueDate.getDate() === 31, 'unnamed day -> month end 31 Jul');

  assert(resolveReportPeriod('5th of month', 'Monthly', now)!.dueDate.getDate() === 5, '"5th of month" -> 5 Jul');
  assert(resolveReportPeriod('day 10', 'Monthly', now)!.dueDate.getDate() === 10, '"day 10" -> 10 Jul');
  // A 31st-of-month rule must clamp in a 30-day month rather than roll into the next
  const june = new Date(2026, 5, 15, 13, 0, 0);
  assert(resolveReportPeriod('31st of month', 'Monthly', june)!.dueDate.getMonth() === 5, '31st clamps inside June');
  assert(resolveReportPeriod('31st of month', 'Monthly', june)!.dueDate.getDate() === 30, '31st -> 30 Jun');

  const quarterly = resolveReportPeriod('EOD', 'Quarterly', now)!;
  assert(quarterly.periodStart.getMonth() === 6, 'Q3 starts in July');
  assert(quarterly.dueDate.getMonth() === 8 && quarterly.dueDate.getDate() === 30, 'Q3 ends 30 Sep');

  // --- grace periods after a period end must not be ignored ---
  const qPlus30 = resolveReportPeriod('Q-end + 30 days', 'Quarterly', now)!;
  assert(qPlus30.dueDate.getMonth() === 9 && qPlus30.dueDate.getDate() === 30, '"Q-end + 30 days" -> 30 Oct');
  const qWithin15 = resolveReportPeriod('Within 15 days of Q-end', 'Quarterly', now)!;
  assert(qWithin15.dueDate.getMonth() === 9 && qWithin15.dueDate.getDate() === 15, '"Within 15 days of Q-end" -> 15 Oct');
  // grace applies to month end too, but a named day is the deadline itself
  assert(resolveReportPeriod('Within 7 days of month-end', 'Monthly', now)!.dueDate.getDate() === 7, 'month-end + 7 -> 7 Aug');
  assert(resolveReportPeriod('5th of month', 'Monthly', now)!.dueDate.getDate() === 5, 'named day ignores grace parsing');

  // --- yearly: the MIS (Y) register's only cadence, keyed to the financial year ---
  // Default FY starts in April, so 15-Jul-2026 sits in FY 2026-27: 1 Apr 26 -> 31 Mar 27.
  const yearly = resolveReportPeriod('Yearly', 'Yearly', now)!;
  assert(yearly.cadence === 'yearly', 'yearly cadence detected');
  assert(yearly.periodStart.getMonth() === 3 && yearly.periodStart.getDate() === 1, 'FY starts 1 April');
  assert(yearly.periodStart.getFullYear() === 2026, 'July 2026 belongs to FY starting Apr 2026');
  assert(yearly.dueDate.getMonth() === 2 && yearly.dueDate.getDate() === 31, 'FY ends 31 March');
  assert(yearly.dueDate.getFullYear() === 2027, 'FY 2026-27 ends in 2027');
  // A date BEFORE the FY start belongs to the previous financial year.
  const feb = new Date(2026, 1, 10, 13, 0, 0);
  const yearlyFeb = resolveReportPeriod('Yearly', 'Yearly', feb)!;
  assert(yearlyFeb.periodStart.getFullYear() === 2025, 'Feb 2026 belongs to FY starting Apr 2025');
  assert(yearlyFeb.dueDate.getFullYear() === 2026 && yearlyFeb.dueDate.getMonth() === 2, 'that FY ends 31 Mar 2026');
  assert(resolveReportPeriod('Annual', 'Annual', now)!.cadence === 'yearly', '"Annual" resolves yearly');
  assert(resolveReportPeriod('Yearly + 30 days', 'Yearly', now)!.dueDate.getMonth() === 3, 'FY-end + 30 days -> 30 Apr');

  // --- unknown cadence is skipped, never guessed ---
  assert(resolveReportPeriod('Morning (8:00 AM)', '', now) === null, 'blank task type -> null');
  assert(resolveReportPeriod('Morning (8:00 AM)', 'One-time', now) === null, 'unrecognised cadence -> null');
  // "Half-Yearly" must NOT be treated as a 12-month cadence just because it
  // contains "yearly" — there is no half-yearly window, so it is skipped.
  assert(resolveReportPeriod('Half-Yearly', 'Half-Yearly', now) === null, 'Half-Yearly -> null, not yearly');

  // --- ISO round-trip: the string handed to timebox/cadence must keep the time ---
  const iso = daily.dueDate.toISOString();
  assert(new Date(iso).getHours() === 8, 'ISO due date round-trips with its time of day');

  console.log('✅ src/classifier/report-schedule.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('classifier/report-schedule.ts')) {
  demo();
}
