/**
 * Gemini-backed attachment summariser.
 *
 * Produces the "Attachment Summary" shown in the dashboard's agent-detail panel:
 * a real 3–5 sentence read of what a matched submission email and its attachment
 * are about, written for a CFO office that wants to know what arrived without
 * opening the file.
 *
 * Deliberately isolated from LLMReasoner (Anthropic, classification): this is a
 * descriptive nicety, whereas classification decides what gets written to the
 * Sheet. Keeping them in separate modules with separate keys means an outage or
 * an unpaid balance on one provider cannot affect the other.
 *
 * Every failure path returns null rather than throwing — no key, an empty email,
 * a refused call, a blank response. A missing summary must degrade to "nothing
 * shown", never to a broken row or an invented description of a file nobody read.
 *
 * Self-check (mocked, no network): npm run check:gemini-summarizer
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { CONFIG } from '../config/index.js';

/**
 * Flash, not Pro: this is a short descriptive pass over text we already have.
 *
 * gemini-1.5-flash (and 2.5-flash) return 404 "no longer available to new users"
 * on this project's key — the 1.5/2.5 series is closed to new callers. This is the
 * current stable flash tier that key can actually reach. Deliberately NOT
 * "gemini-flash-latest": an alias silently changes model under a pinned prompt,
 * and a summary that shifts wording between runs is harder to trust than one that
 * needs an explicit bump here. Verify a replacement with ListModels before editing.
 */
export const GEMINI_MODEL = 'gemini-3.5-flash';

/** How much of the email body to hand the model. Snippets are short; this is headroom. */
export const MAX_SNIPPET_CHARS = 2000;

/** Upper bound on what we will store, so one runaway response can't bloat a row. */
export const MAX_SUMMARY_CHARS = 1200;

/**
 * Hard caps on how much of a workbook is read.
 *
 * A real finance model can be tens of thousands of rows across dozens of sheets;
 * feeding that to a model is slow, expensive and pointless — the header rows and
 * the first screenful are what identify a file. MAX_EXCEL_ROWS is applied by
 * SheetJS at PARSE time (`sheetRows`), not by slicing afterwards, so a 50,000-row
 * sheet is never fully materialised in memory in the first place.
 */
export const MAX_EXCEL_SHEETS = 5;
export const MAX_EXCEL_ROWS = 200;

/** Belt-and-braces cap on the extracted text handed to the model. */
export const MAX_EXCEL_TEXT_CHARS = 12000;

/**
 * Only .xlsx. Everything else — .pdf, .doc(x), .png, .csv, .xls — is skipped
 * silently by the caller rather than guessed at: this function's whole value is
 * that it reports what is REALLY inside the file, and it can only do that for a
 * format it can actually parse.
 */
export function isSupportedSpreadsheet(filename: string): boolean {
  return /\.xlsx$/i.test((filename || '').trim());
}

/**
 * The minimal slice of the SDK this module uses.
 *
 * Declared as an interface so the self-check can inject a fake and assert real
 * behaviour (prompt contents, trimming, failure handling) without a network call
 * or an API key. Production passes nothing and the real SDK is constructed lazily.
 */
export interface GenerativeClient {
  generateContent(prompt: string): Promise<{ response: { text(): string } }>;
}

/** Build the prompt. Exported so the self-check can assert what the model is asked. */
export function buildSummaryPrompt(subject: string, snippet: string, attachmentNames: string[]): string {
  return `You are assisting the CFO's office of a mid-sized Indian manufacturing group.
A staff member has emailed in a submission against a tracked finance task. Summarise
what arrived so a finance manager can triage it without opening the attachment.

EMAIL SUBJECT: ${subject || '(no subject)'}
ATTACHMENT FILENAME(S): ${attachmentNames.length ? attachmentNames.join(', ') : '(none)'}
EMAIL BODY:
"""
${snippet.slice(0, MAX_SNIPPET_CHARS) || '(empty)'}
"""

Write 3 to 5 complete sentences covering, as far as the material above supports it:
- what the email is about and what the sender says they are submitting
- what the attachment appears to contain (type of document, the period or entity it
  covers, and what it is used for)
- anything a reviewer should note, such as a stated caveat, a partial submission,
  or a reference to a follow-up

Ground every statement in the subject, filenames and body text given above. You
cannot see inside the attachment, so describe what it is rather than asserting
figures or conclusions it might contain. If the material is too thin to support
five sentences, write fewer rather than padding or speculating. Reply with the
summary prose only — no headings, no bullet points, no preamble.`;
}

/**
 * Normalise a model response into a storable summary, or null if unusable.
 *
 * Strips the markdown/bullet furniture Gemini adds despite being asked for prose,
 * so a stray "- " or "**" never reaches the dashboard verbatim.
 */
export function normaliseSummary(raw: string): string | null {
  const cleaned = (raw || '')
    .replace(/\*\*/g, '')
    .split('\n')
    .map(line => line.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_SUMMARY_CHARS ? `${cleaned.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : cleaned;
}

/** Lazily built real client; null whenever GEMINI_API_KEY is absent. */
let cachedClient: GenerativeClient | null = null;

function getClient(): GenerativeClient | null {
  if (cachedClient) return cachedClient;
  if (!CONFIG.GEMINI_API_KEY) return null;
  const model = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY).getGenerativeModel({ model: GEMINI_MODEL });
  cachedClient = {
    generateContent: (prompt: string) => model.generateContent(prompt),
  };
  return cachedClient;
}

/**
 * Summarise a matched submission's email + attachment in 3–5 sentences.
 *
 * Returns null — never throws — when GEMINI_API_KEY is unset, there are no
 * attachments to describe, there is no text to work from, or the call fails.
 *
 * @param client injected only by the self-check; production leaves it undefined.
 */
export async function summarizeAttachment(
  subject: string,
  snippet: string,
  attachmentNames: string[],
  client?: GenerativeClient | null
): Promise<string | null> {
  const names = (attachmentNames || []).filter(n => n && n.trim());
  // Nothing was attached, so there is nothing for this function to be about.
  if (names.length === 0) return null;
  // No subject and no body: the filename alone is not enough to describe honestly.
  if (!(subject || '').trim() && !(snippet || '').trim()) return null;

  const active = client === undefined ? getClient() : client;
  if (!active) return null; // no GEMINI_API_KEY — skip silently, by design

  try {
    const result = await active.generateContent(buildSummaryPrompt(subject || '', snippet || '', names));
    return normaliseSummary(result?.response?.text() || '');
  } catch (err: any) {
    console.warn(`⚠️ Gemini attachment summary unavailable (${err?.message || err}) — storing no summary for this submission.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Real file-content reading — downloads the .xlsx and summarises what is INSIDE
// it, rather than inferring from the filename.
// ---------------------------------------------------------------------------

/** What one worksheet contributed, after the row/sheet caps were applied. */
export interface ExtractedSheet {
  name: string;
  /** CSV-ish text of the capped rows — compact, and what a model reads best. */
  text: string;
  rowCount: number;
}

export interface ExtractedWorkbook {
  sheets: ExtractedSheet[];
  /** Sheets present in the file beyond MAX_EXCEL_SHEETS, so the prompt can say so. */
  omittedSheets: string[];
  /** True when any sheet hit MAX_EXCEL_ROWS and may continue past what we read. */
  rowsTruncated: boolean;
}

/**
 * The subset of GmailClient this module needs.
 *
 * Declared structurally so the self-check can inject a fake that returns a
 * locally-built workbook — no Gmail call, no token, no network. GmailClient
 * already satisfies it: `getAttachment` performs the
 * gmail.users.messages.attachments.get call and base64url-decodes the payload
 * into a Buffer, so that decoding is reused here rather than written twice.
 */
export interface AttachmentFetcher {
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}

/**
 * Pull readable text out of an .xlsx buffer, under the sheet and row caps.
 *
 * Parse options are deliberately narrow: formulas, HTML and styles are all
 * switched off. This is an attacker-shaped input — a file a third party emailed
 * in — so nothing is asked of the parser beyond the cell values we actually use,
 * and `sheetRows` bounds the work before a huge sheet is ever expanded.
 *
 * Throws on a corrupt/unparseable buffer; callers treat that as "no summary".
 */
export function extractExcelText(buffer: Buffer): ExtractedWorkbook {
  // An .xlsx is a ZIP container, so real ones begin "PK\x03\x04". This check is
  // not decoration: SheetJS SNIFFS the format rather than trusting the extension,
  // and will happily parse plain text or CSV bytes into a one-cell "worksheet"
  // without throwing. Something named .xlsx that is really a text file, a PDF or
  // an HTML error page would otherwise be summarised as though it were a
  // workbook — a confident description of a file we never actually read.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('not a ZIP/OOXML container (bad magic bytes) — file is not a real .xlsx');
  }

  // Imported lazily so the module stays importable (and self-checkable) even if
  // the optional xlsx dependency is missing from a given deployment.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx');

  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    sheetRows: MAX_EXCEL_ROWS,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellDates: true,
  });

  const allNames: string[] = workbook.SheetNames || [];
  const kept = allNames.slice(0, MAX_EXCEL_SHEETS);
  const sheets: ExtractedSheet[] = [];
  let rowsTruncated = false;

  for (const name of kept) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    if (rows.length >= MAX_EXCEL_ROWS) rowsTruncated = true;
    const text = rows
      .map(row => (row || []).map(cell => (cell === null || cell === undefined ? '' : String(cell))).join(' | '))
      .join('\n');
    sheets.push({ name, text, rowCount: rows.length });
  }

  return { sheets, omittedSheets: allNames.slice(MAX_EXCEL_SHEETS), rowsTruncated };
}

/**
 * Prompt for the file-content summary. Exported so the self-check can assert
 * that the real cell values reach the model and that the caps are disclosed.
 */
export function buildExcelSummaryPrompt(
  filename: string,
  subject: string,
  extracted: ExtractedWorkbook
): string {
  let corpus = extracted.sheets
    .map(s => `--- SHEET: ${s.name} (${s.rowCount} row(s) read) ---\n${s.text}`)
    .join('\n\n');
  if (corpus.length > MAX_EXCEL_TEXT_CHARS) {
    corpus = `${corpus.slice(0, MAX_EXCEL_TEXT_CHARS)}\n[…truncated]`;
  }

  // Stated explicitly so the model never describes a partial read as the whole
  // file — "complete or partial submission" is one of the questions being asked,
  // and our own truncation must not be mistaken for the sender's incompleteness.
  const limits: string[] = [];
  if (extracted.rowsTruncated) limits.push(`only the first ${MAX_EXCEL_ROWS} rows of each sheet were read`);
  if (extracted.omittedSheets.length) {
    limits.push(`${extracted.omittedSheets.length} further sheet(s) were not read (${extracted.omittedSheets.join(', ')})`);
  }

  return `You are assisting the CFO's office of a mid-sized Indian manufacturing group.
A staff member emailed in this spreadsheet against a tracked finance task. Its actual
contents are given below — you are reading the real cell values, not guessing.

FILE NAME: ${filename || '(unnamed)'}
EMAIL SUBJECT: ${subject || '(no subject)'}
SHEETS READ: ${extracted.sheets.map(s => s.name).join(', ') || '(none)'}
${limits.length ? `READ LIMITS: ${limits.join('; ')}.` : 'The whole file was read.'}

WORKBOOK CONTENTS:
"""
${corpus || '(no readable cells)'}
"""

Write 4 to 6 complete sentences covering:
- what data this file actually contains, judging from the headers and values
- which periods, months or financial year(s) it covers, naming them explicitly
- the key figures, totals or visible anomalies a reviewer should look at, with
  actual numbers where the data supports it
- whether this looks like a complete submission or a partial one, and why

Base every statement on the cell values above. Where a READ LIMITS note appears,
that is OUR truncation — do not present it as the sender submitting incomplete
data; judge completeness from the content itself (missing months, blank totals,
placeholder rows). Do not invent figures that are not shown. Reply with the
summary prose only — no headings, no bullet points, no preamble.`;
}

/**
 * Download an .xlsx attachment, read what is inside it, and summarise that.
 *
 * This is the real-content counterpart to summarizeAttachment() above, which can
 * only reason from the filename and covering note. Returns null — never throws —
 * on every failure path: unsupported format, a Gmail fetch that fails (deleted
 * message, expired token), an unparseable workbook, a missing GEMINI_API_KEY, or
 * a refused/blank model response. A daily unattended script must not die on one
 * bad file.
 *
 * @param client injected only by the self-check; production leaves it undefined.
 */
export async function summarizeExcelAttachment(
  gmailClient: AttachmentFetcher,
  messageId: string,
  attachmentId: string,
  filename: string,
  subject: string,
  client?: GenerativeClient | null
): Promise<string | null> {
  if (!isSupportedSpreadsheet(filename)) return null;
  if (!messageId || !attachmentId) return null;

  // Checked BEFORE the download: without a key the summary cannot be produced, so
  // spending a Gmail attachment fetch (and its quota) would buy nothing.
  const active = client === undefined ? getClient() : client;
  if (!active) return null;

  let buffer: Buffer;
  try {
    buffer = await gmailClient.getAttachment(messageId, attachmentId);
  } catch (err: any) {
    console.warn(`   ⚠️ Could not download "${filename}" from Gmail (${err?.message || err}) — skipping.`);
    return null;
  }
  if (!buffer || buffer.length === 0) {
    console.warn(`   ⚠️ "${filename}" downloaded as 0 bytes — skipping.`);
    return null;
  }

  let extracted: ExtractedWorkbook;
  try {
    extracted = extractExcelText(buffer);
  } catch (err: any) {
    console.warn(`   ⚠️ Could not parse "${filename}" as .xlsx (${err?.message || err}) — skipping.`);
    return null;
  }
  // A workbook whose every sheet is empty gives the model nothing to describe.
  if (extracted.sheets.length === 0 || extracted.sheets.every(s => !s.text.trim())) {
    console.warn(`   ⚠️ "${filename}" contains no readable cells — skipping.`);
    return null;
  }

  try {
    const result = await active.generateContent(buildExcelSummaryPrompt(filename, subject || '', extracted));
    return normaliseSummary(result?.response?.text() || '');
  } catch (err: any) {
    console.warn(`   ⚠️ Gemini file-content summary failed for "${filename}" (${err?.message || err}) — skipping.`);
    return null;
  }
}
