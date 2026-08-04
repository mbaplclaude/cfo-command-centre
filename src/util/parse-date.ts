/**
 * The one date parser for Sheet-sourced date text.
 *
 * The Sheet contains at least four hand-entered formats side by side
 * ("18-Jun-26", "6/21/2026", "13/07/2026", "2026-07-28"), plus ISO timestamps
 * the report scheduler generates. Both TimeBoxMatcher and CadenceEngine used to
 * carry their own copy of a parser that handled only two of those, which silently
 * disabled reminders for every row using the others.
 *
 * Self-check: npm run check:parse-date
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Two-digit years are this century: "26" -> 2026. */
function normaliseYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/**
 * Parse Sheet date text into a Date, or an Invalid Date when unparseable.
 *
 * Formats handled:
 *   - ISO timestamps ("2026-07-29T08:00:00.000Z") — delegated to Date, time kept
 *   - ISO dates       ("2026-07-28")             — local midnight
 *   - Abbreviated month ("21-Jun-26", "21 Jun 2026", "Jun 21 2026")
 *   - Numeric slash/dash/dot ("13/07/2026", "6/21/2026", "18.06.2026")
 *
 * Ambiguity rule for all-numeric dates: whichever of the first two components
 * exceeds 12 is the day. When BOTH are <= 12 the value is genuinely ambiguous
 * and day-first is assumed, matching the previous behaviour and the sheet's
 * Indian locale — "6/1/2026" reads as 1 June, not 6 January.
 */
export function parseSheetDate(dateStr: string): Date {
  const raw = (dateStr || '').trim();
  if (!raw) return new Date(NaN);

  // ISO timestamp — let Date handle it so the time of day survives.
  if (/\dT\d/.test(raw) || /Z$|[+-]\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw);
  }

  const parts = raw.split(/[\/\-.\s]+/).filter(Boolean);
  if (parts.length < 3) {
    // Not a recognised triple; give Date a chance rather than failing outright.
    const fallback = new Date(raw);
    return isNaN(fallback.getTime()) ? new Date(NaN) : fallback;
  }

  const [a, b, c] = parts;

  // Any component that is a month name pins the layout unambiguously.
  const monthNameIndex = [a, b, c].findIndex(p => MONTHS[p.toLowerCase()] !== undefined);
  if (monthNameIndex !== -1) {
    const month = MONTHS[parts[monthNameIndex].toLowerCase()];
    const others = parts.filter((_, i) => i !== monthNameIndex);
    const nums = others.map(p => parseInt(p, 10));
    if (nums.some(isNaN)) return new Date(NaN);

    // Order is preserved by the filter, so the remaining pair reads day-then-year
    // for both "21-Jun-26" and "Jun 21 2026". Only a leading 4-digit component
    // ("2026-Jun-21") reverses that.
    const yearFirst = others[0].length === 4;
    const day = yearFirst ? nums[1] : nums[0];
    const year = yearFirst ? nums[0] : nums[1];
    return new Date(normaliseYear(year), month, day);
  }

  const n = [a, b, c].map(p => parseInt(p, 10));
  if (n.some(isNaN)) return new Date(NaN);

  // Year-first (4-digit leading component): YYYY-MM-DD
  if (a.length === 4) {
    return new Date(n[0], n[1] - 1, n[2]);
  }

  // Day-first unless the second component proves it is the day.
  const secondIsDay = n[1] > 12 && n[0] <= 12;
  const day = secondIsDay ? n[1] : n[0];
  const month = secondIsDay ? n[0] : n[1];
  return new Date(normaliseYear(n[2]), month - 1, day);
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };
  const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  // --- the bug that silently disabled cadence on 5+ live rows ---
  assert(ymd(parseSheetDate('21-Jun-26')) === '2026-6-21', '"21-Jun-26" -> 21 Jun 2026');
  assert(ymd(parseSheetDate('18-Jun-26')) === '2026-6-18', '"18-Jun-26" -> 18 Jun 2026');
  assert(ymd(parseSheetDate('28-Jun-26')) === '2026-6-28', '"28-Jun-26" -> 28 Jun 2026');
  assert(!isNaN(parseSheetDate('21-Jun-26').getTime()), 'abbreviated month is no longer an Invalid Date');

  // month-name variants
  assert(ymd(parseSheetDate('21 Jun 2026')) === '2026-6-21', 'space-separated month name');
  assert(ymd(parseSheetDate('Jun 21 2026')) === '2026-6-21', 'month-first layout');
  assert(ymd(parseSheetDate('5-Sept-26')) === '2026-9-5', '4-letter "Sept" accepted');
  assert(ymd(parseSheetDate('1-JAN-27')) === '2027-1-1', 'uppercase month, year rollover');

  // --- the second silent bug: M/D/YYYY rolled the month over ---
  // Old code did new Date(2026, 21-1, 6) = Sep 2027. Must be 21 Jun 2026.
  assert(ymd(parseSheetDate('6/21/2026')) === '2026-6-21', '"6/21/2026" -> 21 Jun 2026, not Sep 2027');
  assert(ymd(parseSheetDate('6/22/2026')) === '2026-6-22', '"6/22/2026" -> 22 Jun 2026');

  // --- day-first numeric still reads day-first ---
  assert(ymd(parseSheetDate('13/07/2026')) === '2026-7-13', '"13/07/2026" -> 13 Jul 2026');
  assert(ymd(parseSheetDate('18.06.2026')) === '2026-6-18', 'dot separator, day-first');

  // --- genuinely ambiguous: day-first is the documented assumption ---
  assert(ymd(parseSheetDate('6/1/2026')) === '2026-1-6', '"6/1/2026" reads day-first -> 6 Jan 2026');

  // --- ISO ---
  assert(ymd(parseSheetDate('2026-07-28')) === '2026-7-28', 'ISO date');
  assert(parseSheetDate('2026-07-29T08:30:00.000Z').getTime() === Date.parse('2026-07-29T08:30:00.000Z'), 'ISO timestamp keeps its time');
  assert(parseSheetDate('2026-07-29T08:30:00.000Z').toISOString().includes('08:30'), 'ISO time of day survives');

  // --- unparseable input stays Invalid rather than becoming a wrong date ---
  assert(isNaN(parseSheetDate('').getTime()), 'blank -> Invalid Date');
  assert(isNaN(parseSheetDate('   ').getTime()), 'whitespace -> Invalid Date');
  assert(isNaN(parseSheetDate('Morning (8:00 AM)').getTime()), 'review-timing text is not a date');
  assert(isNaN(parseSheetDate('not-a-date-at-all').getTime()), 'garbage -> Invalid Date');
  assert(isNaN(parseSheetDate('21-Xyz-26').getTime()), 'unknown month name -> Invalid Date');

  console.log('✅ src/util/parse-date.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('util/parse-date.ts')) {
  demo();
}
