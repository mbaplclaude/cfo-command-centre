/**
 * Self-check for the Gemini attachment summariser.
 *
 * Every case injects a fake GenerativeClient — this file never touches the
 * network and never needs GEMINI_API_KEY. That is the whole point: the graceful
 * degradation paths are the ones most likely to be hit in production (no key, a
 * refused call, a blank response), and they must be provable without a live
 * account or a bill.
 *
 * Run: npm run check:gemini-summarizer
 */
import * as XLSX from 'xlsx';
import {
  summarizeAttachment, buildSummaryPrompt, normaliseSummary,
  GEMINI_MODEL, MAX_SUMMARY_CHARS, MAX_SNIPPET_CHARS, GenerativeClient,
  summarizeExcelAttachment, extractExcelText, buildExcelSummaryPrompt, isSupportedSpreadsheet,
  MAX_EXCEL_SHEETS, MAX_EXCEL_ROWS, MAX_EXCEL_TEXT_CHARS, AttachmentFetcher,
} from './gemini-summarizer.js';

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

/**
 * Build a real .xlsx in memory. Nothing is read from disk and nothing is
 * downloaded — this exercises the actual SheetJS parse path against bytes in the
 * exact format Gmail would hand us.
 */
function makeWorkbook(sheets: Array<{ name: string; rows: unknown[][] }>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows as any[][]), s.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** A fake Gmail that hands back a locally-built workbook. No API, no token. */
function fakeGmail(buffer: Buffer): AttachmentFetcher & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    async getAttachment(messageId: string, attachmentId: string) {
      calls.push([messageId, attachmentId]);
      return buffer;
    },
  };
}

/** A Gmail that fails the way a deleted message or an expired token does. */
function failingGmail(message: string): AttachmentFetcher {
  return {
    async getAttachment() {
      throw new Error(message);
    },
  };
}

/** A fake model that records what it was asked and replies with canned text. */
function fakeClient(reply: string): GenerativeClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async generateContent(prompt: string) {
      prompts.push(prompt);
      return { response: { text: () => reply } };
    },
  };
}

/** A fake model that fails the way a real outage / bad key / quota trip does. */
function failingClient(message: string): GenerativeClient {
  return {
    async generateContent() {
      throw new Error(message);
    },
  };
}

async function demo() {
  const SUBJECT = 'Re: July 2026 GL anomaly report — expense scrutiny';
  const SNIPPET = 'Sir, please find attached the GL anomaly report for July 2026 with the expense scrutiny comparison against June. Two cost centres are still pending confirmation from plant finance.';
  const FILES = ['GL_Anomaly_July2026.xlsx'];

  const REAL_REPLY =
    'The email is a submission of the July 2026 GL anomaly report from the accounts team. ' +
    'The attached workbook contains a general-ledger anomaly listing for July 2026, alongside ' +
    'an expense scrutiny comparison against the June figures. It is used by the finance office ' +
    'to review unusual ledger movements before the monthly close is signed off. The sender notes ' +
    'that two cost centres are still awaiting confirmation from plant finance, so the figures are ' +
    'not yet final.';

  // --- the happy path ---
  {
    const client = fakeClient(REAL_REPLY);
    const summary = await summarizeAttachment(SUBJECT, SNIPPET, FILES, client);
    assert(summary === REAL_REPLY, 'a clean model response is returned verbatim');
    assert(client.prompts.length === 1, 'exactly one model call per submission');

    // It must be a real summary, not the one-liner this replaced.
    const sentences = (summary || '').split(/[.!?](?:\s|$)/).filter(s => s.trim().length > 0);
    assert(sentences.length >= 3 && sentences.length <= 6, `a 3–5 sentence summary, got ${sentences.length}`);
    assert((summary || '').length > 200, 'substantially longer than a one-line label');
  }

  // --- the prompt carries everything the model needs, and asks for prose ---
  {
    const client = fakeClient(REAL_REPLY);
    await summarizeAttachment(SUBJECT, SNIPPET, FILES, client);
    const prompt = client.prompts[0];
    assert(prompt.includes(SUBJECT), 'prompt includes the email subject');
    assert(prompt.includes(SNIPPET), 'prompt includes the body snippet');
    assert(prompt.includes('GL_Anomaly_July2026.xlsx'), 'prompt includes the attachment filename');
    assert(/3 to 5 complete sentences/.test(prompt), 'prompt asks for 3–5 sentences, not a one-liner');
    // The model cannot open the file, so it must be told not to invent its contents.
    assert(/cannot see inside the attachment/.test(prompt), 'prompt forbids asserting unseen file contents');
    assert(/fewer rather than padding or speculating/.test(prompt), 'prompt prefers brevity over speculation');
  }

  // --- graceful degradation: every one of these must be null, never a throw ---
  {
    // No API key in production is modelled by a null client.
    assert(await summarizeAttachment(SUBJECT, SNIPPET, FILES, null) === null, 'no GEMINI_API_KEY -> null, no throw');

    // Nothing attached: there is no attachment to summarise.
    assert(await summarizeAttachment(SUBJECT, SNIPPET, [], fakeClient(REAL_REPLY)) === null, 'no attachments -> null');
    assert(await summarizeAttachment(SUBJECT, SNIPPET, ['', '   '], fakeClient(REAL_REPLY)) === null, 'blank filenames -> null');

    // A filename with no subject and no body is too thin to describe honestly.
    assert(await summarizeAttachment('', '', FILES, fakeClient(REAL_REPLY)) === null, 'no subject and no body -> null');
    assert(await summarizeAttachment('  ', '  ', FILES, fakeClient(REAL_REPLY)) === null, 'whitespace-only subject/body -> null');

    // Real API failure modes.
    assert(await summarizeAttachment(SUBJECT, SNIPPET, FILES, failingClient('API key not valid')) === null, 'bad key -> null, no throw');
    assert(await summarizeAttachment(SUBJECT, SNIPPET, FILES, failingClient('429 Resource exhausted')) === null, 'quota exhausted -> null, no throw');

    // A response that arrives but says nothing usable.
    assert(await summarizeAttachment(SUBJECT, SNIPPET, FILES, fakeClient('')) === null, 'empty response -> null');
    assert(await summarizeAttachment(SUBJECT, SNIPPET, FILES, fakeClient('   \n  \n')) === null, 'whitespace-only response -> null');
  }

  // --- a call is only made when there is something to summarise ---
  {
    const client = fakeClient(REAL_REPLY);
    await summarizeAttachment(SUBJECT, SNIPPET, [], client);
    assert(client.prompts.length === 0, 'no attachments -> the model is never called (no wasted spend)');

    const client2 = fakeClient(REAL_REPLY);
    await summarizeAttachment('', '', FILES, client2);
    assert(client2.prompts.length === 0, 'no text to work from -> the model is never called');
  }

  // --- normaliseSummary strips the markdown Gemini adds despite being asked not to ---
  {
    assert(normaliseSummary('Plain prose about a report.') === 'Plain prose about a report.', 'plain prose passes through');
    assert(normaliseSummary('**Bold** claim.') === 'Bold claim.', 'bold markers stripped');
    assert(
      normaliseSummary('- First point.\n- Second point.') === 'First point. Second point.',
      'bullet list flattened into prose'
    );
    assert(normaliseSummary('• Bulleted.\n* Starred.') === 'Bulleted. Starred.', 'unicode and asterisk bullets stripped');
    assert(normaliseSummary('Line one.\n\n\nLine two.') === 'Line one. Line two.', 'blank lines collapsed');
    assert(normaliseSummary('  spaced   out   text.  ') === 'spaced out text.', 'whitespace collapsed and trimmed');
    assert(normaliseSummary('') === null, 'empty -> null');
    assert(normaliseSummary('\n \n') === null, 'whitespace-only -> null');

    // One runaway response must not bloat the stored row.
    const huge = normaliseSummary('x'.repeat(MAX_SUMMARY_CHARS + 500));
    assert(huge !== null && huge.length === MAX_SUMMARY_CHARS, `oversized response capped at ${MAX_SUMMARY_CHARS}`);
    assert(huge!.endsWith('…'), 'a truncated summary is visibly truncated');
  }

  // --- a very long email body is bounded before it reaches the model ---
  {
    const client = fakeClient(REAL_REPLY);
    await summarizeAttachment(SUBJECT, 'y'.repeat(MAX_SNIPPET_CHARS + 5000), FILES, client);
    assert(!client.prompts[0].includes('y'.repeat(MAX_SNIPPET_CHARS + 1)), 'body is truncated to the snippet cap');
  }

  // --- prompt builder is stable on empty-ish input (it is called only via the guards above) ---
  {
    const p = buildSummaryPrompt('', '', []);
    assert(p.includes('(no subject)') && p.includes('(none)') && p.includes('(empty)'), 'placeholders instead of blank fields');
  }

  // =========================================================================
  // Excel file-content reading. Gmail and Gemini are BOTH faked; the workbook is
  // real .xlsx bytes built in memory, so the SheetJS parse path is genuinely run.
  // =========================================================================

  // --- format gate: only .xlsx ---
  {
    assert(isSupportedSpreadsheet('report.xlsx'), '.xlsx supported');
    assert(isSupportedSpreadsheet('REPORT.XLSX'), 'extension check is case-insensitive');
    assert(isSupportedSpreadsheet('  spaced.xlsx  '), 'surrounding whitespace tolerated');
    for (const bad of ['a.pdf', 'a.doc', 'a.docx', 'a.png', 'a.csv', 'a.xls', 'a.xlsx.exe', 'noext', '']) {
      assert(!isSupportedSpreadsheet(bad), `"${bad}" is not treated as .xlsx`);
    }
    // .xls is deliberately excluded: a different format, and silently mis-parsing
    // it would produce a confident summary of the wrong thing.
    assert(!isSupportedSpreadsheet('legacy.xls'), 'legacy .xls is not claimed as supported');
  }

  // --- extraction reads real cell values ---
  {
    const buf = makeWorkbook([
      { name: 'Budget', rows: [['Month', 'Budget', 'Actual'], ['Apr-26', 100000, 92500], ['May-26', 110000, 118200]] },
      { name: 'CostCentres', rows: [['CC', 'Amount'], ['CC100', 5000]] },
    ]);
    const out = extractExcelText(buf);
    assert(out.sheets.length === 2, 'both sheets extracted');
    assert(out.sheets[0].name === 'Budget', 'sheet names preserved in order');
    // The actual figures must survive — this is the whole difference from the
    // filename-only summariser.
    assert(out.sheets[0].text.includes('92500'), 'real cell values present in extracted text');
    assert(out.sheets[0].text.includes('Apr-26'), 'period labels present');
    assert(out.sheets[1].text.includes('CC100'), 'second sheet content present');
    assert(out.sheets[0].rowCount === 3, 'row count reflects rows read');
    assert(out.omittedSheets.length === 0, 'nothing omitted for a 2-sheet file');
    assert(out.rowsTruncated === false, 'a small sheet is not reported as truncated');
  }

  // --- the 5-sheet cap ---
  {
    const many = Array.from({ length: MAX_EXCEL_SHEETS + 3 }, (_, i) => ({
      name: `S${i + 1}`,
      rows: [['h'], [`v${i + 1}`]],
    }));
    const out = extractExcelText(makeWorkbook(many));
    assert(out.sheets.length === MAX_EXCEL_SHEETS, `at most ${MAX_EXCEL_SHEETS} sheets read`);
    assert(out.omittedSheets.length === 3, 'sheets beyond the cap are reported, not silently dropped');
    assert(out.omittedSheets[0] === `S${MAX_EXCEL_SHEETS + 1}`, 'the omitted list names the right sheets');
  }

  // --- the 200-row cap ---
  {
    const rows: unknown[][] = [['Month', 'Amount']];
    for (let i = 0; i < MAX_EXCEL_ROWS + 500; i++) rows.push([`m${i}`, i]);
    const out = extractExcelText(makeWorkbook([{ name: 'Big', rows }]));
    assert(out.sheets[0].rowCount <= MAX_EXCEL_ROWS, `no more than ${MAX_EXCEL_ROWS} rows read`);
    assert(out.rowsTruncated === true, 'hitting the row cap is flagged as truncated');
    // Proof the cap applied at parse time rather than after materialising 700 rows.
    assert(!out.sheets[0].text.includes('m690'), 'rows past the cap never reach the extracted text');
  }

  // --- prompt carries the real contents, the caps, and the completeness question ---
  {
    const buf = makeWorkbook([{ name: 'GL', rows: [['Account', 'Jul-26'], ['Freight', 41200]] }]);
    const prompt = buildExcelSummaryPrompt('GL anomaly July.xlsx', 'Re: July GL', extractExcelText(buf));
    assert(prompt.includes('41200'), 'actual figures reach the model');
    assert(prompt.includes('GL anomaly July.xlsx') && prompt.includes('Re: July GL'), 'filename and subject included');
    assert(prompt.includes('--- SHEET: GL'), 'sheet is labelled so the model can attribute figures');
    assert(/which periods, months or financial year\(s\)/.test(prompt), 'asks which periods are covered');
    assert(/complete submission or a partial one/.test(prompt), 'asks about completeness');
    assert(/anomalies/.test(prompt), 'asks for visible anomalies');
    assert(/4 to 6 complete sentences/.test(prompt), 'asks for a real summary, not a one-liner');
    assert(/Do not invent figures/.test(prompt), 'forbids inventing figures');
    assert(prompt.includes('The whole file was read.'), 'an untruncated read says so');
  }

  // --- our truncation must never be reported as the SENDER's incompleteness ---
  {
    const rows: unknown[][] = [['h', 'v']];
    for (let i = 0; i < MAX_EXCEL_ROWS + 10; i++) rows.push([`r${i}`, i]);
    const prompt = buildExcelSummaryPrompt('big.xlsx', 's', extractExcelText(makeWorkbook([{ name: 'A', rows }])));
    assert(prompt.includes('READ LIMITS'), 'truncation is disclosed to the model');
    assert(/that is OUR truncation/.test(prompt), 'model is told the truncation is ours, not the sender\'s');
  }

  // --- oversized corpus is bounded before it is sent ---
  {
    const rows: unknown[][] = [['col']];
    for (let i = 0; i < MAX_EXCEL_ROWS - 1; i++) rows.push(['x'.repeat(400)]);
    const prompt = buildExcelSummaryPrompt('wide.xlsx', 's', extractExcelText(makeWorkbook([{ name: 'W', rows }])));
    assert(prompt.includes('[…truncated]'), 'an oversized corpus is truncated and says so');
    assert(prompt.length < MAX_EXCEL_TEXT_CHARS + 3000, 'prompt stays bounded regardless of file size');
  }

  // --- the happy path, end to end with both dependencies faked ---
  {
    const EXCEL_REPLY =
      'This workbook contains a budget-versus-actual comparison for the first two months of FY27. ' +
      'It covers April 2026 and May 2026 across three columns: month, budgeted amount and actual spend. ' +
      'April came in under budget at 92,500 against 100,000, while May overspent at 118,200 against 110,000. ' +
      'The May overspend of roughly 8,200 is the figure a reviewer should look at first. ' +
      'Only two months are present, so this appears to be a partial year-to-date submission rather than a full-year file.';
    const buf = makeWorkbook([{ name: 'Budget', rows: [['Month', 'Budget', 'Actual'], ['Apr-26', 100000, 92500], ['May-26', 110000, 118200]] }]);
    const gmail = fakeGmail(buf);
    const model = fakeClient(EXCEL_REPLY);

    const summary = await summarizeExcelAttachment(gmail, 'msg-1', 'att-1', 'Budget FY27.xlsx', 'Re: budget', model);
    assert(summary === EXCEL_REPLY, 'the model response is returned');
    assert(gmail.calls.length === 1, 'exactly one Gmail download');
    assert(gmail.calls[0][0] === 'msg-1' && gmail.calls[0][1] === 'att-1', 'messageId and attachmentId are both passed through');
    assert(model.prompts.length === 1, 'exactly one Gemini call');
    assert(model.prompts[0].includes('118200'), 'the prompt the model saw contained real cell values');
    const sentences = (summary || '').split(/[.!?](?:\s|$)/).filter(s => s.trim());
    assert(sentences.length >= 4, `a 4+ sentence summary, got ${sentences.length}`);
  }

  // --- graceful degradation: null on every failure, and no wasted work ---
  {
    const buf = makeWorkbook([{ name: 'A', rows: [['h'], ['v']] }]);

    // Unsupported format: rejected before Gmail is even touched.
    const g1 = fakeGmail(buf);
    assert(await summarizeExcelAttachment(g1, 'm', 'a', 'scan.pdf', 's', fakeClient('x')) === null, '.pdf -> null');
    assert(g1.calls.length === 0, 'an unsupported format never downloads the attachment');

    // No API key (modelled by a null client): checked before the download, so no
    // Gmail quota is spent on a summary that cannot be produced.
    const g2 = fakeGmail(buf);
    assert(await summarizeExcelAttachment(g2, 'm', 'a', 'f.xlsx', 's', null) === null, 'no GEMINI_API_KEY -> null');
    assert(g2.calls.length === 0, 'missing key short-circuits before the Gmail download');

    // Missing identifiers.
    assert(await summarizeExcelAttachment(fakeGmail(buf), '', 'a', 'f.xlsx', 's', fakeClient('x')) === null, 'blank messageId -> null');
    assert(await summarizeExcelAttachment(fakeGmail(buf), 'm', '', 'f.xlsx', 's', fakeClient('x')) === null, 'blank attachmentId -> null');

    // Gmail failures — the script must step over these, not die.
    assert(await summarizeExcelAttachment(failingGmail('Requested entity was not found'), 'm', 'a', 'f.xlsx', 's', fakeClient('x')) === null, 'deleted message -> null');
    assert(await summarizeExcelAttachment(failingGmail('invalid_grant'), 'm', 'a', 'f.xlsx', 's', fakeClient('x')) === null, 'expired token -> null');

    // Empty download.
    assert(await summarizeExcelAttachment(fakeGmail(Buffer.alloc(0)), 'm', 'a', 'f.xlsx', 's', fakeClient('x')) === null, '0-byte download -> null');

    // Not actually a workbook, despite the extension. SheetJS sniffs formats and
    // would parse these into a bogus one-cell "sheet", so the magic-byte gate is
    // what stops us describing a file we never really read.
    for (const [label, bytes] of [
      ['plain text', Buffer.from('this is plain text, not a zip container')],
      ['a PDF', Buffer.from('%PDF-1.7\n%mangled')],
      ['a PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ['an HTML error page', Buffer.from('<html><body>403 Forbidden</body></html>')],
      ['two bytes', Buffer.from([0x50, 0x4b])],
    ] as Array<[string, Buffer]>) {
      const g = fakeGmail(bytes);
      const m = fakeClient('should not be called');
      assert(await summarizeExcelAttachment(g, 'm', 'a', 'lies.xlsx', 's', m) === null, `${label} named .xlsx -> null, no throw`);
      assert(m.prompts.length === 0, `${label} never reaches the model`);
    }

    // A structurally valid but contentless workbook.
    const emptyWb = fakeGmail(makeWorkbook([{ name: 'Blank', rows: [] }]));
    const emptyModel = fakeClient('should not be called');
    assert(await summarizeExcelAttachment(emptyWb, 'm', 'a', 'blank.xlsx', 's', emptyModel) === null, 'no readable cells -> null');
    assert(emptyModel.prompts.length === 0, 'an empty workbook never reaches the model');

    // Gemini failures.
    assert(await summarizeExcelAttachment(fakeGmail(buf), 'm', 'a', 'f.xlsx', 's', failingClient('429 quota')) === null, 'quota trip -> null');
    assert(await summarizeExcelAttachment(fakeGmail(buf), 'm', 'a', 'f.xlsx', 's', fakeClient('')) === null, 'blank model response -> null');
    assert(await summarizeExcelAttachment(fakeGmail(buf), 'm', 'a', 'f.xlsx', 's', fakeClient('  \n ')) === null, 'whitespace-only response -> null');
  }

  // --- markdown stripping applies to the file-content path too ---
  {
    const buf = makeWorkbook([{ name: 'A', rows: [['h'], ['v']] }]);
    const out = await summarizeExcelAttachment(fakeGmail(buf), 'm', 'a', 'f.xlsx', 's', fakeClient('- **Point one.**\n- Point two.'));
    assert(out === 'Point one. Point two.', 'bullets and bold stripped from the Excel summary too');
  }

  // --- the model is a cheap flash tier, pinned rather than an alias ---
  // A "-latest" alias would change model under this pinned prompt without a code
  // change; a preview model can vanish. Both are worse than an explicit bump.
  assert(/flash/.test(GEMINI_MODEL), 'uses a flash-tier model, not Pro');
  assert(!/latest/.test(GEMINI_MODEL), 'model is pinned, not a shifting -latest alias');
  assert(!/preview/.test(GEMINI_MODEL), 'model is stable, not a preview that can be withdrawn');

  console.log('✅ src/classifier/gemini-summarizer.test.ts — filename + Excel file-content assertions passed (Gmail and Gemini both mocked, no network)');
}

demo().catch(err => {
  console.error(err.message);
  process.exit(1);
});
