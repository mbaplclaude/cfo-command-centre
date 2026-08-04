/**
 * Deterministic submission gates, applied before and after AI classification.
 *
 * A Gmail search can only filter by sender and date, so every tracker row sharing
 * a sender sees the same replies. These two gates stop one unrelated email from
 * closing several rows, and work with or without an ANTHROPIC_API_KEY:
 *
 *   1. Title overlap  — the reply must mention something from the row's title.
 *   2. Attachment     — "Received" requires an actual attachment, else it is
 *                       capped at Partial/Unclear for human review.
 *
 * Self-check: npm run check:relevance
 */
import { GmailMessageSummary, TaskStatus } from '../types/index.js';

/**
 * Words too generic to identify a specific task or report. Without this list,
 * "Monthly report update" would match nearly every row on the sheet.
 */
const STOPWORDS = new Set([
  // grammar
  'the', 'and', 'for', 'with', 'from', 'not', 'are', 'was', 'were', 'has', 'have', 'had',
  'this', 'that', 'these', 'those', 'you', 'your', 'our', 'its', 'all', 'any', 'per', 'via',
  'into', 'onto', 'out', 'off', 'about', 'over', 'under', 'than', 'then', 'also', 'but',
  // email furniture
  're', 'fwd', 'fw', 'reminder', 'reminders', 'overdue', 'due', 'today', 'urgent', 'please',
  'find', 'attached', 'attachment', 'regards', 'thanks', 'thank', 'dear', 'hi', 'hello',
  'mail', 'email', 'sent', 'sending', 'send', 'submit', 'submitted', 'submission',
  // generic finance/task filler
  'report', 'reports', 'reporting', 'update', 'updates', 'updated', 'status', 'task', 'tasks',
  'daily', 'weekly', 'monthly', 'quarterly', 'annual', 'yearly', 'period', 'periodic',
  'morning', 'evening', 'afternoon', 'month', 'week', 'year', 'quarter', 'date', 'time',
  'new', 'old', 'final', 'draft', 'copy', 'detail', 'details', 'data', 'info', 'information',
  'review', 'check', 'note', 'notes', 'set', 'list', 'sheet', 'file', 'files',
]);

/**
 * Everything the sender actually typed, with the quoted reply chain removed.
 *
 * Replies quote earlier reminders, and one thread can accumulate several — so a
 * reply about report A ends up containing the full text of the reminder for task
 * B. Matching against that quoted chain closes the wrong row, which is exactly
 * what "SAP cost center budget upload" did on live mail.
 */
export function stripQuotedText(bodyText: string): string {
  const body = bodyText || '';
  const markers = [
    /^>/m,                                  // standard quote prefix
    /^-{2,}\s*Original Message\s*-{2,}/im,  // Outlook
    /^_{5,}/m,                              // Outlook divider
    /^On .{0,120}\bwrote:/im,               // Gmail / Apple Mail
    /^From:\s.+$/im,                        // forwarded header block
    /^Sent from my /im,
  ];

  let cut = body.length;
  for (const marker of markers) {
    const found = body.search(marker);
    if (found !== -1 && found < cut) cut = found;
  }
  return body.slice(0, cut).trim();
}

/** Distinctive terms from a task/report title, deduped. */
export function significantTerms(title: string): string[] {
  const tokens = (title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

export interface OverlapResult {
  /** True when the reply may relate to this row (or we cannot tell — see indeterminate). */
  matches: boolean;
  shared: string[];
  /** How many shared terms were needed for this title. */
  required: number;
  /** The title carried no distinctive terms, so relevance could not be judged. */
  indeterminate: boolean;
}

/**
 * How many title terms a reply must share.
 *
 * One is not enough: finance titles reuse domain words, so "SAP cost center
 * BUDGET upload" and "BUDGET vs actuals variance" overlap on "budget", and
 * "LENDER covenant compliance" overlaps "KPL LENDER assessment note" on "lender"
 * — both observed closing the wrong row on live mail. Two terms is the smallest
 * threshold that separates them. Titles with only one distinctive term fall back
 * to needing that one.
 *
 * ponytail: fixed threshold, deliberately. Score terms by how many row titles
 * contain them (rarity weighting) only if real submissions start getting chased.
 */
function requiredSharedTerms(termCount: number): number {
  return Math.min(2, termCount);
}

/**
 * Does this reply mention anything specific to the row's title?
 *
 * Matching is whole-word so "act" does not match "actuals". Subject and body are
 * both searched, because a reply may carry the title only in quoted text.
 *
 * When a title has no distinctive terms at all ("Daily report"), the result is
 * `indeterminate` and `matches` is true: refusing every reply would mean that row
 * could never be marked Received and would be chased forever.
 * ponytail: rename such rows in the sheet rather than adding fuzzy matching here.
 */
export function hasTitleOverlap(title: string, email: Pick<GmailMessageSummary, 'subject' | 'bodyText'>): OverlapResult {
  const terms = significantTerms(title);
  if (terms.length === 0) {
    return { matches: true, shared: [], required: 0, indeterminate: true };
  }

  // Subject + only what the sender typed. Quoted chains are excluded on purpose.
  const haystack = `${email.subject || ''} ${stripQuotedText(email.bodyText || '').substring(0, 4000)}`.toLowerCase();
  const shared = terms.filter(term => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  });

  const required = requiredSharedTerms(terms.length);
  return { matches: shared.length >= required, shared, required, indeterminate: false };
}

export interface AttachmentGateResult {
  status: TaskStatus;
  remarks: string;
  downgraded: boolean;
}

/**
 * "Received" requires a real attachment. A reply that merely claims completion is
 * capped at Partial/Unclear so a human confirms it, rather than silently closing
 * the row on the strength of an assertion.
 */
export function requireAttachmentForReceived(
  status: TaskStatus,
  remarks: string,
  hasAttachments: boolean
): AttachmentGateResult {
  const claimsReceipt = status === 'Received' || status === 'Received (Early)';
  if (!claimsReceipt || hasAttachments) {
    return { status, remarks, downgraded: false };
  }

  return {
    status: 'Partial/Unclear',
    remarks: `${remarks} (No attachment — held for human review instead of "${status}")`,
    downgraded: true,
  };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`FAIL: ${msg}`);
  };
  const mail = (subject: string, bodyText = '') => ({ subject, bodyText });

  // --- the exact cross-contamination seen in the live run must be rejected ---
  const expScrutiny = mail('Re: Reminder: Exp Scrutiny / Comparison with Previous Period — Due Today');
  assert(!hasTitleOverlap('EBITDA & KPI dashboard', expScrutiny).matches, 'Exp Scrutiny email !== EBITDA dashboard');
  assert(!hasTitleOverlap('Budget vs actuals variance', expScrutiny).matches, 'Exp Scrutiny email !== Budget variance');
  assert(!hasTitleOverlap('SAP cost center budget upload — FY27', expScrutiny).matches, 'Exp Scrutiny email !== SAP upload');

  const crisil = mail('Re: Reminder: CRISIL / rating agency update — Due Today');
  assert(!hasTitleOverlap('Lender covenant compliance', crisil).matches, 'CRISIL email !== Lender covenant');
  assert(!hasTitleOverlap('RXIL Integration', crisil).matches, 'CRISIL email !== RXIL Integration');
  // ...but it MUST still match the row it genuinely belongs to
  assert(hasTitleOverlap('CRISIL / rating agency update', crisil).matches, 'CRISIL email matches its own row');

  // --- a single shared DOMAIN word must not be enough (both seen on live mail) ---
  const budgetVariance = mail('Re: Reminder: Budget vs actuals variance — Due Today');
  const sapOverlap = hasTitleOverlap('SAP cost center budget upload — FY27', budgetVariance);
  assert(sapOverlap.shared.length === 1 && !sapOverlap.matches, 'shared "budget" alone !== SAP upload row');
  const lenderDraft = mail('Re: Overdue: KPL lender assessment note draft — 24 day(s) past due');
  const covenantOverlap = hasTitleOverlap('Lender covenant compliance', lenderDraft);
  assert(covenantOverlap.shared.length === 1 && !covenantOverlap.matches, 'shared "lender" alone !== covenant row');
  // ...while the rows those emails DO belong to still match
  assert(hasTitleOverlap('Budget vs actuals variance', budgetVariance).matches, 'budget variance email matches its own row');
  assert(hasTitleOverlap('KPL lender assessment note draft', lenderDraft).matches, 'lender draft email matches its own row');

  // --- genuine submissions still get through ---
  assert(hasTitleOverlap('Stock & inventory position', mail('Inventory position as of today')).matches, 'inventory reply matches');
  assert(
    hasTitleOverlap('Group P&L (consolidated)', mail('Please find attached', 'Consolidated group numbers attached')).matches,
    'title terms found in body when subject is bare'
  );

  // --- whole-word matching: no substring false positives ---
  assert(!hasTitleOverlap('Budget vs actuals variance', mail('actual usage report')).matches, '"actual" !== "actuals"');
  // Deliberate trade-off: one term is below threshold, so a terse genuine reply is
  // chased again rather than closing the wrong row.
  assert(!hasTitleOverlap('Budget vs actuals variance', mail('variance analysis attached')).matches, 'single term is below threshold');
  assert(hasTitleOverlap('Budget vs actuals variance', mail('actuals variance attached')).matches, 'two terms clear the threshold');

  // A one-term title needs only that term — it has nothing else to offer.
  const single = hasTitleOverlap('RXIL', mail('RXIL done'));
  assert(single.required === 1 && single.matches, 'single-term title needs only one match');

  // --- quoted reply chains must not supply the match (the Row 7 leak) ---
  const quotedChain = mail(
    'Re: Reminder: Budget vs actuals variance — Due Today',
    'Please find attached.\n\nOn Mon, 13 Jul 2026, CFO Command Centre wrote:\n> Your task "SAP cost center budget upload — FY27" was due on 17-Jun-26\n> Please reply with your submission.'
  );
  assert(
    !hasTitleOverlap('SAP cost center budget upload — FY27', quotedChain).matches,
    'quoted reminder for another task must not close this row'
  );
  assert(hasTitleOverlap('Budget vs actuals variance', quotedChain).matches, 'own-row match survives quote stripping');

  // the sender's own words still count, and each quote style is cut
  assert(hasTitleOverlap('Group P&L (consolidated)', mail('x', 'Consolidated group attached\n> quoted noise')).matches, 'text above the quote counts');
  assert(stripQuotedText('Real text\n-----Original Message-----\nquoted').trim() === 'Real text', 'Outlook divider cut');
  assert(stripQuotedText('Real text\nFrom: someone@x.com\nquoted').trim() === 'Real text', 'forward header cut');
  assert(stripQuotedText('Just this').trim() === 'Just this', 'unquoted body is untouched');

  // --- generic-only titles cannot be judged, so they are let through ---
  const generic = hasTitleOverlap('Monthly report update', mail('Anything at all'));
  assert(generic.indeterminate && generic.matches, 'all-stopword title -> indeterminate, not blocked');
  assert(significantTerms('Daily report').length === 0, '"Daily report" has no distinctive terms');
  // short but meaningful acronyms are kept
  assert(significantTerms('GST reconciliation').includes('gst'), '3-letter acronym GST kept');
  assert(!significantTerms('Monthly GST report').includes('monthly'), 'cadence word dropped');

  // --- attachment gate ---
  const noAttach = requireAttachmentForReceived('Received', 'Submitted via email', false);
  assert(noAttach.status === 'Partial/Unclear' && noAttach.downgraded, 'Received without attachment -> Partial/Unclear');
  assert(noAttach.remarks.includes('No attachment'), 'downgrade is explained in remarks');

  const withAttach = requireAttachmentForReceived('Received', 'Submitted via email', true);
  assert(withAttach.status === 'Received' && !withAttach.downgraded, 'Received with attachment is untouched');

  const early = requireAttachmentForReceived('Received (Early)', 'r', false);
  assert(early.status === 'Partial/Unclear', 'Received (Early) is gated too');

  // non-receipt verdicts pass through unchanged, attachment or not
  for (const s of ['Partial/Unclear', 'Overdue', 'Pending', 'Irrelevant'] as TaskStatus[]) {
    const out = requireAttachmentForReceived(s, 'r', false);
    assert(out.status === s && !out.downgraded, `${s} passes through the attachment gate`);
  }

  console.log('✅ src/classifier/relevance.ts self-check passed');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('classifier/relevance.ts')) {
  demo();
}
