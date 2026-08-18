/**
 * Self-check for the CFO AI Assistant chat module.
 *
 * Gemini and Postgres are both faked — this file never touches the network, never
 * needs GEMINI_API_KEY, and never opens a connection. The paths that matter most
 * in production are exactly the ones a live test cannot prove cheaply: that the
 * prompt tells the model the truth about where an attachment summary came from,
 * that a missing key degrades to an honest sentence instead of a blank bubble,
 * and that a malformed sessionId never reaches a WHERE clause.
 *
 * Run: npm run check:chat
 */
import {
  ChatContext, ContextTask, GenerativeClient,
  CHAT_MODEL, MAX_MESSAGE_CHARS, HISTORY_LIMIT, SYSTEM_PROMPT,
  isValidSessionId, cleanMessage, buildContextBlock, buildChatPrompt,
  normaliseReply, askGemini, loadDbContext, loadHistory,
} from './chat.js';
import { GEMINI_MODEL } from '../src/classifier/gemini-summarizer.js';

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

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

function task(over: Partial<ContextTask> = {}): ContextTask {
  return {
    tabName: '4. Report Calendar', rowIndex: 12, name: 'MIS Monthly', assignedTo: 'Amarjyoti',
    email: 'amarjyoti@example.com', dueDate: '2026-08-10', status: 'Overdue', overdueDays: '8',
    isValid: true, ...over,
  };
}

function ctx(over: Partial<ChatContext> = {}): ChatContext {
  return {
    tasks: [task()], submissions: [], reminders: [], needsAttention: [],
    approvals: [], directory: [], warnings: [], ...over,
  };
}

async function demo() {
  // --- input validation (trust boundary: both values reach SQL and an LLM) ---
  assert(isValidSessionId('3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607'), 'a real UUID is accepted');
  assert(!isValidSessionId('../../etc/passwd'), 'a path-shaped sessionId is rejected');
  assert(!isValidSessionId("' OR 1=1 --"), 'an injection-shaped sessionId is rejected');
  assert(!isValidSessionId(''), 'an empty sessionId is rejected');
  assert(!isValidSessionId(undefined), 'a missing sessionId is rejected');

  assert(cleanMessage('  what is overdue?  ') === 'what is overdue?', 'a question is trimmed');
  assert(cleanMessage('   ') === null, 'a blank question is rejected');
  assert(cleanMessage(42) === null, 'a non-string question is rejected');
  assert(cleanMessage('x'.repeat(MAX_MESSAGE_CHARS)) !== null, 'a question exactly at the cap is accepted');
  assert(cleanMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)) === null, 'a question over the cap is rejected');

  // --- context block carries the real values, and only the real values ---
  {
    const block = buildContextBlock(ctx({
      tasks: [task({ name: 'GSTR 9 filing', assignedTo: 'Priya', overdueDays: '3' })],
      directory: [{ name: 'Amarjyoti Das', email: 'amarjyoti@example.com', department: 'Finance' }],
      approvals: [{ run_id: 'RUN-999', summary_text: '4 reminders awaiting approval', created_at: '2026-08-17T00:00:00Z', expires_at: '2026-08-17T04:00:00Z' }],
    }));
    assert(block.includes('GSTR 9 filing'), 'task name reaches the model');
    assert(block.includes('Priya'), 'assignee reaches the model');
    assert(block.includes('overdue 3'), 'overdue days reach the model');
    assert(block.includes('amarjyoti@example.com'), 'the directory email reaches the model — this is what resolves a first name to a sender');
    assert(block.includes('RUN-999'), 'a pending approval run reaches the model');
    assert(/TRACKED ROWS \(1\)/.test(block), 'counts are stated, so the model can say how many more there are');
  }

  // --- the provenance of an attachment summary is stated, not implied ---
  // This is the assertion that keeps the honesty rule enforceable: if the prompt
  // stops distinguishing the two, the model has no way to obey rule 2 and will
  // present a filename guess as a read of the file.
  {
    const real = buildContextBlock(ctx({
      submissions: [{ task_key: '4. Report Calendar|12', sender_email: 'a@b.com', subject: 'Budget Comparison', date_received: '2026-08-15T09:00:00Z', classification: 'RECEIVED', attachment_count: 1, attachment_summary: 'Total spend 4.2 crore against 3.8 budgeted.', summary_from_file_content: true }],
    }));
    assert(real.includes('READ FROM THE REAL FILE CONTENTS'), 'a file-content summary is labelled as one');
    assert(real.includes('Total spend 4.2 crore'), 'the summary text itself reaches the model');

    const guess = buildContextBlock(ctx({
      submissions: [{ task_key: 'x|1', sender_email: 'a@b.com', subject: 'S', date_received: '2026-08-15T09:00:00Z', classification: 'RECEIVED', attachment_count: 1, attachment_summary: 'Looks like a budget file.', summary_from_file_content: false }],
    }));
    assert(guess.includes('INFERRED FROM FILENAME AND COVERING NOTE ONLY'), 'a filename-guess summary is labelled as one');
    assert(!guess.includes('READ FROM THE REAL FILE'), 'a guess is never labelled as a real read');

    const none = buildContextBlock(ctx({
      submissions: [{ task_key: 'x|1', sender_email: 'a@b.com', subject: 'S', date_received: '2026-08-15T09:00:00Z', classification: 'RECEIVED', attachment_count: 2, attachment_summary: null }],
    }));
    assert(none.includes('ATTACHMENT SUMMARY: none stored'), 'an attachment with no summary is declared missing, not silently omitted');
  }

  // --- empty context reads as empty, never as absent ---
  {
    const block = buildContextBlock(ctx({ tasks: [] }));
    assert(block.includes('TRACKED ROWS (0)') && block.includes('(none)'), 'empty sections say "(none)" so the model does not treat silence as unknown');
  }

  // --- a DB read that failed is disclosed to the model, not hidden ---
  {
    const block = buildContextBlock(ctx({ warnings: ['Recent submissions could not be read (Database unavailable)'] }));
    assert(block.includes('CONTEXT GAPS'), 'a failed context read becomes a stated gap');
    assert(block.includes('Database unavailable'), 'the reason for the gap reaches the model');
  }

  // --- the standing rules survive prompt edits ---
  assert(/NEVER invent data/i.test(SYSTEM_PROMPT), 'the no-fabrication rule is present');
  assert(/No markdown/i.test(SYSTEM_PROMPT), 'the plain-text rule is present');
  assert(/cannot open files or search email/i.test(SYSTEM_PROMPT), 'the model is told it has no live Gmail access');

  // --- full prompt: instructions + context + history + question ---
  {
    const prompt = buildChatPrompt(
      ctx(),
      [{ role: 'user', content: 'who is late?' }, { role: 'assistant', content: 'Amarjyoti is 8 days late.' }],
      'and what did he send?'
    );
    assert(prompt.includes(SYSTEM_PROMPT), 'the system prompt is included');
    assert(prompt.includes('CFO: who is late?'), 'a prior user turn is replayed');
    assert(prompt.includes('ASSISTANT: Amarjyoti is 8 days late.'), 'a prior assistant turn is replayed — this is what makes "he" resolvable');
    assert(prompt.includes("CFO'S QUESTION: and what did he send?"), 'the new question is the last thing asked');
    assert(prompt.indexOf('=== END CONTEXT ===') < prompt.indexOf("CFO'S QUESTION"), 'the question comes after the context, not buried inside it');
  }
  {
    const prompt = buildChatPrompt(ctx(), [], 'first question');
    assert(!prompt.includes('CONVERSATION SO FAR'), 'a first turn carries no empty conversation header');
  }

  // --- reply normalisation keeps paragraphs, drops markdown ---
  assert(normaliseReply('**Bold** answer') === 'Bold answer', 'bold markers are stripped');
  assert(normaliseReply('## Heading\ntext') === 'Heading\ntext', 'heading markers are stripped');
  assert(normaliseReply('- one\n- two') === 'one\ntwo', 'bullet markers are stripped but the line break survives');
  assert(normaliseReply('para one\n\n\n\npara two') === 'para one\n\npara two', 'runs of blank lines collapse to one');
  assert(normaliseReply('   ') === null, 'a blank response is null, so the caller can substitute an honest sentence');
  {
    const long = normaliseReply('y'.repeat(20000))!;
    assert(long.length <= 8000 && long.endsWith('…'), 'a runaway reply is capped and visibly elided');
  }

  // --- askGemini: never throws, never returns empty ---
  {
    const out = await askGemini('p', fakeClient('**A** clear answer.'));
    assert(out === 'A clear answer.', 'a normal reply comes back cleaned');
  }
  {
    // null (not undefined) is the "no GEMINI_API_KEY" state — undefined would
    // build the real client and try to reach the network.
    const out = await askGemini('p', null);
    assert(/GEMINI_API_KEY is not set/.test(out), 'an unconfigured key produces an honest sentence, not a blank bubble');
  }
  {
    const out = await askGemini('p', { async generateContent() { throw new Error('429 quota'); } });
    assert(/could not reach the AI service/i.test(out), 'a failed call degrades to a retry message instead of throwing');
    assert(!/429/.test(out), 'the provider error text is not leaked to the CFO');
  }
  {
    const out = await askGemini('p', fakeClient('   '));
    assert(/could not produce an answer/i.test(out), 'a blank model response becomes a real sentence');
  }

  // --- history: newest N turns, replayed oldest first ---
  {
    const seen: any[] = [];
    const rows = await loadHistory(
      async (sql, params) => { seen.push({ sql, params }); return { rows: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }; },
      '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607'
    );
    assert(rows.length === 2 && rows[0].role === 'user', 'history comes back as {role, content}');
    assert(seen[0].params[0] === '3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607', 'the session id is passed as a bound parameter, never interpolated');
    assert(seen[0].params[1] === HISTORY_LIMIT, `the default limit is HISTORY_LIMIT (${HISTORY_LIMIT})`);
    assert(/ORDER BY created_at DESC/.test(seen[0].sql) && /ORDER BY created_at ASC/.test(seen[0].sql),
      'newest-first inside the LIMIT, oldest-first outside — the other way round keeps the wrong ten turns');
  }

  // --- loadDbContext: bounded, windowed, and failures become warnings ---
  {
    const sqls: string[] = [];
    const out = await loadDbContext(async sql => { sqls.push(sql); return { rows: [{ x: 1 }] }; });
    assert(sqls.length === 4, 'four context reads: submissions, reminders, approvals, directory');
    assert(sqls.every(s => /LIMIT \d+/.test(s)), 'every context read is capped — an uncapped one grows the prompt without bound as the tables fill');
    assert(sqls.filter(s => /INTERVAL '30 days'/.test(s)).length === 2, 'submissions and reminders are windowed to 30 days');
    assert(/status = 'PENDING'/.test(sqls[2]), 'only pending approvals are included');
    assert(out.warnings.length === 0, 'a clean read produces no warnings');
    assert(out.submissions.length === 1 && out.directory.length === 1, 'rows are routed to the right context fields');
  }
  {
    const out = await loadDbContext(async () => ({ rows: [], error: 'Database unavailable' }));
    assert(out.warnings.length === 4, 'every failed read becomes its own stated gap');
    assert(out.submissions.length === 0, 'a failed read contributes no rows');
  }

  // --- the model is one this key can actually reach, and stays pinned ---
  // No Pro tier is usable on this account (1.5/2.5 are closed to new callers,
  // 3.1-pro-preview and pro-latest have no free quota), so the feature runs on
  // flash. See the CHAT_MODEL doc comment.
  assert(!/^gemini-(1\.5|2\.5)/.test(CHAT_MODEL), 'not the 1.5/2.5 series — both 404 "no longer available to new users" on this key');
  // Cast: both are literal-typed consts, so tsc would call the comparison
  // unintentional — the guard is against a future edit pointing chat at the
  // summariser's cheaper model, which reads one email rather than the whole book.
  assert(String(CHAT_MODEL) !== String(GEMINI_MODEL), 'chat uses a higher tier than the summariser, which only reads one email at a time');
  assert(!/latest/.test(CHAT_MODEL), 'model is pinned, not a shifting -latest alias');
  assert(!/preview/.test(CHAT_MODEL), 'model is stable, not a preview that can be withdrawn');

  console.log('✅ dashboard/chat.test.ts — chat context, prompt, validation and degradation assertions passed (Gemini and Postgres both mocked, no network)');
}

demo().catch(err => {
  console.error(err.message);
  process.exit(1);
});
