import { GoogleSheetsClient } from './google/sheets.js';
import { GmailClient } from './google/gmail.js';
import { CadenceEngine, CHRONIC_REMINDER_CAP, buildDigestContent, DigestItem } from './classifier/cadence.js';
import { resolveReportPeriod } from './classifier/report-schedule.js';
import { evaluateRowSubmission } from './pipeline/row-evaluation.js';
import { DatabaseClient } from './db/client.js';
import {
  getReminderHistory,
  countToday,
  countSince,
  logDraftedReminders,
  reminderKey,
  recordSubmission,
} from './db/reminder-history.js';
import { parseSheetDate } from './util/parse-date.js';
import { isMailSuppressed } from './util/task-type.js';
import { LLMReasoner } from './classifier/llm-reasoner.js';
import { GmailNotificationChannel } from './channels/gmail-channel.js';
import { DraftReminderItem } from './channels/interface.js';
import { EmployeeStatsAggregator } from './stats/employee-stats.js';
import { CONFIG } from './config/index.js';
import { UnifiedTask } from './types/index.js';

class CFOAgent {
  private sheetsClient = new GoogleSheetsClient();
  private gmailClient = new GmailClient();
  private llmReasoner = new LLMReasoner();
  private notificationChannel = new GmailNotificationChannel();

  public async runPipeline(options: {
    dryRun?: boolean;
    approveRunId?: string;
    showStatsOnly?: boolean;
    /** Evaluate ONLY "4. Report Calendar". Used by the hourly scheduled task. */
    reportsOnly?: boolean;
  }) {
    console.log('\n======================================================');
    console.log('🤖 CFO COMMAND CENTRE AGENT (v2)');
    console.log('======================================================\n');

    // Handle CLI Approval Dispatch Command
    if (options.approveRunId) {
      await this.approveAndDispatchRun(options.approveRunId);
      return;
    }

    // Step 1: Read Google Sheet Tabs
    //
    // The hourly scheduled task passes reportsOnly, so Staff Tracker is not read,
    // evaluated, reminded on, or mentioned in the operator summary. Staff Tracker
    // reminders are sent manually from the dashboard instead.
    const reportsOnly = Boolean(options.reportsOnly);

    console.log('📊 STEP 1: Reading Google Sheet Tabs...');
    if (reportsOnly) {
      console.log(`   Scope: "${CONFIG.REPORT_CALENDAR_TAB}" only — "${CONFIG.STAFF_TRACKER_TAB}" is excluded from scheduled runs.`);
    }

    const staffResult = reportsOnly
      ? { rows: [], invalidRows: [] }
      : await this.sheetsClient.readStaffTracker();
    const reportResult = await this.sheetsClient.readReportCalendar();

    const allInvalidRows = [...staffResult.invalidRows, ...reportResult.invalidRows];

    console.log(`✅ Read Completed:`);
    console.log(`   - Staff Tracker valid tasks: ${staffResult.rows.length}`);
    console.log(`   - Report Calendar valid tasks: ${reportResult.rows.length}`);
    console.log(`   - Invalid / Skipped rows (Safety Filter): ${allInvalidRows.length}`);

    if (options.showStatsOnly) {
      const allTasks: UnifiedTask[] = [
        ...staffResult.rows.map(r => ({
          tabName: '3. Staff Tracker' as const,
          rowIndex: r.rowIndex,
          idNum: r.idNum,
          taskDescriptionOrName: r.taskDescription,
          assignedToName: r.assignedTo,
          emailId: r.emailId,
          taskType: r.taskType,
          dateAssigned: r.dateAssigned,
          dueDate: r.dueDate,
          currentStatus: r.status,
          remarks: r.remarks,
          threadId: r.threadId,
          daysOrOverdueDays: r.days,
          isValid: true,
        })),
        ...reportResult.rows.map(r => ({
          tabName: '4. Report Calendar' as const,
          rowIndex: r.rowIndex,
          idNum: r.idNum,
          taskDescriptionOrName: r.reportName,
          assignedToName: r.sourceWhoSends,
          emailId: r.emailId,
          taskType: r.taskType,
          dateAssigned: '',
          dueDate: r.reviewTiming,
          currentStatus: r.status,
          remarks: r.remarks,
          threadId: r.threadId,
          daysOrOverdueDays: r.overdueDays,
          isValid: true,
        })),
      ];
      const stats = EmployeeStatsAggregator.calculateStats(allTasks);
      EmployeeStatsAggregator.printStatsTable(stats);
      return;
    }

    // Step 2 & 3: Match Gmail Replies & Time-boxing — BOTH tracker tabs
    console.log('\n📧 STEP 2 & 3: Searching Gmail & Time-boxing Submissions...');
    const pendingReminders: DraftReminderItem[] = [];
    /** Eligible rows, flat, before they are grouped into one digest per recipient. */
    const digestCandidates: Array<{ recipientEmail: string; recipientName: string; item: DigestItem }> = [];
    const unscheduledReports: string[] = [];

    /**
     * Both tabs are normalised into this shape so time-boxing, classification,
     * cadence and write-back run through ONE code path. The tabs differ only in
     * how the window is derived and which columns get written.
     */
    interface EvalUnit {
      tabName: string;
      rowIndex: number;
      taskId: string;
      title: string;
      recipientName: string;
      recipientEmail: string;
      taskType: string;
      /** Gmail search floor and time-box window start. */
      windowStart: string;
      /** Drives the date math — ISO for reports so the time of day survives. */
      dueDate: string;
      /** What a recipient reads; equals dueDate for Staff Tracker rows. */
      dueDateLabel: string;
      currentStatus: string;
      threadId: string;
      writeBack: (status: string, remarks: string, threadId: string) => Promise<void>;
    }

    const units: EvalUnit[] = [];

    for (const row of staffResult.rows) {
      units.push({
        tabName: CONFIG.STAFF_TRACKER_TAB,
        rowIndex: row.rowIndex,
        taskId: row.idNum || `STAFF-${row.rowIndex}`,
        title: row.taskDescription,
        recipientName: row.assignedTo,
        recipientEmail: row.emailId,
        taskType: row.taskType,
        windowStart: row.dateAssigned,
        dueDate: row.dueDate,
        dueDateLabel: row.dueDate,
        currentStatus: row.status,
        threadId: row.threadId,
        writeBack: (status, remarks, threadId) =>
          this.sheetsClient.updateStaffTrackerRow(row.rowIndex, status, remarks, row.days, threadId),
      });
    }

    for (const row of reportResult.rows) {
      // Report Calendar has no date columns — resolve the current period from
      // Review Timing + Task Type. No recognised cadence means skip, not guess:
      // assuming "daily" would email someone every day for a quarterly report.
      // "No Mail Sent" is an explicit opt-out, not a data problem — report it as
      // such rather than lumping it in with rows whose cadence is unrecognised.
      if (isMailSuppressed(row.taskType)) {
        unscheduledReports.push(
          `[Row ${row.rowIndex}] "${row.reportName}" — Task Type "${row.taskType}": excluded from all reminder mail by choice`
        );
        continue;
      }

      const period = resolveReportPeriod(row.reviewTiming, row.taskType);
      if (!period) {
        unscheduledReports.push(
          `[Row ${row.rowIndex}] "${row.reportName}" — Task Type "${row.taskType || '(blank)'}" has no recognised cadence`
        );
        continue;
      }

      units.push({
        tabName: CONFIG.REPORT_CALENDAR_TAB,
        rowIndex: row.rowIndex,
        taskId: row.idNum || `REPORT-${row.rowIndex}`,
        title: row.reportName,
        recipientName: row.sourceWhoSends || row.name,
        recipientEmail: row.emailId,
        taskType: row.taskType,
        windowStart: period.periodStart.toISOString(),
        dueDate: period.dueDate.toISOString(),
        dueDateLabel: period.label,
        currentStatus: row.status,
        threadId: row.threadId,
        writeBack: (status, remarks, threadId) =>
          this.sheetsClient.updateReportCalendarRow(row.rowIndex, status, remarks, row.overdueDays, threadId),
      });
    }

    console.log(`   Evaluating ${units.length} row(s): ${units.filter(u => u.tabName === CONFIG.STAFF_TRACKER_TAB).length} staff task(s) + ${units.filter(u => u.tabName === CONFIG.REPORT_CALENDAR_TAB).length} report(s).`);

    // Reminder history drives both the per-day throttle and the per-period cap.
    // This THROWS if the database is unreachable — proceeding without it would
    // re-send everything issued today and ignore the cap entirely.
    const db = new DatabaseClient();
    const reminderHistory = await getReminderHistory(db);
    if (reminderHistory.size > 0) {
      console.log(`   Reminder history loaded for ${reminderHistory.size} row(s).`);
    }
    const chronicRows: Array<{ tabName: string; rowIndex: number; title: string; recipientEmail: string; overdueDays: number; count: number }> = [];

    if (unscheduledReports.length > 0) {
      console.log(`\n   ⏭️  Skipped ${unscheduledReports.length} Report Calendar row(s) with no recognised cadence (never reminded, never guessed):`);
      unscheduledReports.forEach(r => console.log(`      - ${r}`));
    }

    for (const unit of units) {
      const kind = unit.tabName === CONFIG.STAFF_TRACKER_TAB ? 'Staff Task' : 'Report';
      console.log(`\n🔍 Evaluating ${kind} [Row ${unit.rowIndex}]: "${unit.title}" assigned to ${unit.recipientEmail}`);
      if (unit.dueDateLabel !== unit.dueDate) {
        console.log(`   └─ Current period due: ${unit.dueDateLabel}`);
      }

      const { classification, selectedReply } = await evaluateRowSubmission(unit, {
        gmailClient: this.gmailClient,
        llmReasoner: this.llmReasoner,
      });

      if (classification && classification.status !== 'Irrelevant') {
        // Perform Write-back if not dry-run
        if (!options.dryRun) {
          await unit.writeBack(
            classification.status,
            classification.remarks,
            classification.threadId || unit.threadId
          );

          // Persist the submission so the dashboard can link to the thread and
          // its attachments — the Sheet has no column for either.
          if (selectedReply) {
            const rec = await recordSubmission(db, {
              tabName: unit.tabName,
              rowIndex: unit.rowIndex,
              senderEmail: unit.recipientEmail,
              messageId: selectedReply.id,
              threadId: selectedReply.threadId,
              subject: selectedReply.subject,
              dateReceived: selectedReply.date,
              classification: classification.status,
              remarks: classification.remarks,
              snippet: selectedReply.snippet,
              attachments: selectedReply.attachments,
            });
            if (rec.error) console.warn(`   ⚠️ Could not record submission: ${rec.error}`);
          }
        }

        if (classification.status === 'Received' || classification.status === 'Received (Early)') {
          // Forward submission to sourabh@mbapl.com
          console.log(`   └─ ↗️ Forwarding verified submission to ${CONFIG.REPLY_FORWARD_EMAIL}`);
        }
      } else {
        if (classification) {
          // Judged unrelated to this row. Nothing is written, and the row still
          // owes a submission — so fall through to the reminder cadence rather
          // than silently treating it as handled.
          console.log(`   └─ Reply judged unrelated to this row — treated as no submission.`);
        }

        // Staff Tracker reminders are sent manually from the dashboard (operator
        // reviews and edits each email, then clicks send). Generating drafts and
        // an approval request for them here would create a competing second flow
        // for the same rows, so the automated cadence covers reports only.
        if (unit.tabName === CONFIG.STAFF_TRACKER_TAB) {
          console.log(`   └─ Status: ${unit.currentStatus} — no automated reminder (Staff Tracker is sent manually from the dashboard).`);
          continue;
        }

        // No submission found -> is this row due/overdue enough to go into its
        // recipient's digest today?
        const rowHistory = reminderHistory.get(reminderKey(unit.tabName, unit.rowIndex));
        const alreadyToday = countToday(rowHistory);
        // The period a cap counts over: the report period for report rows, the
        // task's own lifetime (from Date Assigned) for one-time staff rows.
        const alreadyThisPeriod = countSince(rowHistory, parseSheetDate(unit.windowStart));

        const eligibility = CadenceEngine.evaluateDigestEligibility(
          unit.currentStatus,
          unit.taskType,
          unit.dueDate,
          alreadyThisPeriod
        );

        if (eligibility.chronicallyOverdue) {
          console.log(
            `   └─ 🚩 CHRONICALLY OVERDUE (${eligibility.overdueDays} days, ${alreadyThisPeriod} digest(s) this period ` +
              `— cap ${CHRONIC_REMINDER_CAP} reached). Excluded from the digest; needs manual escalation.`
          );
          chronicRows.push({
            tabName: unit.tabName,
            rowIndex: unit.rowIndex,
            title: unit.title,
            recipientEmail: unit.recipientEmail,
            overdueDays: eligibility.overdueDays,
            count: alreadyThisPeriod,
          });
        } else if (!eligibility.eligible) {
          console.log(`   └─ Not in today's digest: ${eligibility.reason}`);
        } else if (alreadyToday > 0) {
          // One digest per recipient per day. This row already contributed to a
          // digest today, so it must not pull its recipient into a second one.
          console.log(`   └─ Already covered by today's digest — one digest per recipient per day.`);
        } else {
          console.log(`   └─ ⚠️ DUE/OVERDUE (${eligibility.overdueDays} day(s)) — added to ${unit.recipientEmail}'s digest.`);
          digestCandidates.push({
            recipientEmail: unit.recipientEmail,
            recipientName: unit.recipientName,
            item: {
              tabName: unit.tabName,
              rowIndex: unit.rowIndex,
              taskDescription: unit.title,
              dueLabel: unit.dueDateLabel,
              overdueDays: eligibility.overdueDays,
            },
          });
        }
      }
    }

    // Bundle every eligible row into ONE digest per recipient. This is the whole
    // point of the change: a person with a daily report, a weekly and a monthly
    // all overdue receives a single email, not three.
    const byRecipient = new Map<string, { recipientName: string; items: typeof digestCandidates[number]['item'][] }>();
    for (const c of digestCandidates) {
      const key = c.recipientEmail.trim().toLowerCase();
      if (!byRecipient.has(key)) byRecipient.set(key, { recipientName: c.recipientName, items: [] });
      byRecipient.get(key)!.items.push(c.item);
    }

    for (const [emailKey, group] of byRecipient) {
      // Preserve the address exactly as the Sheet spells it, rather than the
      // lower-cased grouping key.
      const original = digestCandidates.find(c => c.recipientEmail.trim().toLowerCase() === emailKey)!.recipientEmail;
      const { subject, body } = buildDigestContent(group.recipientName, group.items);
      pendingReminders.push({
        tabName: group.items[0].tabName,
        recipientName: group.recipientName,
        recipientEmail: original,
        reminderType: 'DAILY_DIGEST',
        subject,
        body,
        items: group.items,
      });
    }

    if (pendingReminders.length > 0) {
      const totalItems = pendingReminders.reduce((n, r) => n + r.items.length, 0);
      console.log(`\n📬 Digest bundling: ${totalItems} due/overdue item(s) -> ${pendingReminders.length} email(s), one per recipient.`);
    }

    if (chronicRows.length > 0) {
      console.log(`\n🚩 CHRONICALLY OVERDUE — ${chronicRows.length} row(s) past the ${CHRONIC_REMINDER_CAP}-reminder cap, no longer auto-chased:`);
      chronicRows.forEach(r =>
        console.log(`   - [${r.tabName} row ${r.rowIndex}] "${r.title}" <${r.recipientEmail}> — ${r.overdueDays} days overdue, ${r.count} reminders sent`)
      );
      console.log(`   These need a manual decision rather than another email.`);
    }

    // Step 4: Human-in-the-loop Approval & Draft Creation
    if (options.dryRun && pendingReminders.length > 0) {
      // A dry run evaluates only. Creating drafts or emailing the operator would
      // both be outbound side effects, so stop here and just report the plan.
      const totalItems = pendingReminders.reduce((n, r) => n + r.items.length, 0);
      console.log(`\n🧪 DRY RUN: ${pendingReminders.length} digest email(s) covering ${totalItems} item(s) WOULD be drafted (no drafts created, no email sent):`);
      pendingReminders.forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.recipientName} <${r.recipientEmail}> — ONE email, ${r.items.length} item(s)`);
        console.log(`      Subject: ${r.subject}`);
        r.items.forEach(item => {
          console.log(`        • [${item.tabName} row ${item.rowIndex}] "${item.taskDescription}" — due ${item.dueLabel} (${item.overdueDays} day(s) overdue)`);
        });
      });
      console.log('\n✅ CFO Agent Execution Complete (dry run — zero writes, zero drafts, zero emails).\n');
      return;
    }

    if (pendingReminders.length > 0) {
      console.log(`\n🛡️ STEP 4: Creating Gmail Drafts & Preparing Human Approval Summary...`);
      const runId = `RUN-${Date.now()}`;
      const expiresAt = new Date(Date.now() + CONFIG.APPROVAL_TIMEOUT_HOURS * 3600 * 1000);

      const draftedReminders = await this.notificationChannel.createDrafts(pendingReminders);

      // Record the drafts immediately. Until this is on the books, the next run
      // re-drafts the same reminders — the live run produced a duplicate set of 9.
      const logResult = await logDraftedReminders(db, draftedReminders, runId);
      if (logResult.error) {
        console.warn(`   ⚠️ Could not record drafted reminders (${logResult.error}) — the next run may re-draft them.`);
      } else {
        console.log(`   └─ Recorded ${logResult.logged} drafted reminder(s) against today's throttle.`);
      }

      if (CONFIG.REQUIRE_APPROVAL) {
        // Persist the run BEFORE notifying the operator — an approval that cannot be
        // looked up later is worse than one the operator never hears about.
        const summaryText =
          `${draftedReminders.length} reminder(s) awaiting approval; ` +
          `${allInvalidRows.length} row(s) in Needs Attention.`;
        try {
          await db.query(
            `INSERT INTO approval_requests (run_id, status, summary_text, reminders_json, expires_at)
             VALUES ($1, 'PENDING', $2, $3::jsonb, $4)
             ON CONFLICT (run_id) DO NOTHING`,
            [runId, summaryText, JSON.stringify(draftedReminders), expiresAt.toISOString()]
          );
        } catch (dbErr: any) {
          console.warn(`   ⚠️ Could not persist approval request (approval by Run ID will not work): ${dbErr.message}`);
        }

        await this.notificationChannel.sendOperatorSummary(runId, draftedReminders, allInvalidRows, expiresAt, chronicRows);
        console.log(`\n======================================================`);
        console.log(`⏸️ RUN HELD FOR OPERATOR APPROVAL (REQUIRE_APPROVAL=true)`);
        console.log(`To approve and send these ${draftedReminders.length} reminders, run:`);
        console.log(`\n   npm run agent -- --approve ${runId}\n`);
        console.log(`======================================================\n`);
      } else {
        console.log(`⚡ REQUIRE_APPROVAL=false. Direct sending approved reminders...`);
        await this.notificationChannel.sendApprovedReminders(draftedReminders);
      }
    } else {
      console.log('\n🎉 No overdue reminders needed for this run.');
    }

    console.log('\n✅ CFO Agent Execution Complete.\n');
  }

  private async approveAndDispatchRun(runId: string) {
    return await approveAndDispatchRun(runId);
  }
}

/**
 * Standalone approval function shared by CLI (--approve) and dashboard API.
 * Validates the run exists, checks timeout, dispatches reminders, and updates DB.
 */
export async function approveAndDispatchRun(runId: string): Promise<{ success: boolean; message: string }> {
  const db = new DatabaseClient();
  const notificationChannel = new GmailNotificationChannel();

  console.log(`\n✅ Approving and dispatching run ID: ${runId}`);

  try {
    // 1. Look up the approval request in DB
    const result = await db.query(
      'SELECT * FROM approval_requests WHERE run_id = $1',
      [runId]
    );

    if (result.rows.length === 0) {
      const msg = `Run ID "${runId}" not found in approval_requests table.`;
      console.warn(`⚠️ ${msg}`);
      return { success: false, message: msg };
    }

    const approval = result.rows[0];

    // 2. Check if already actioned
    if (approval.status === 'APPROVED') {
      const msg = `Run ID "${runId}" has already been approved.`;
      console.warn(`⚠️ ${msg}`);
      return { success: false, message: msg };
    }

    // 3. Check 4-hour timeout
    const expiresAt = new Date(approval.expires_at);
    const now = new Date();
    if (now > expiresAt) {
      await db.query(
        'UPDATE approval_requests SET status = $1 WHERE run_id = $2',
        ['EXPIRED', runId]
      );
      const msg = `Run ID "${runId}" has expired (deadline was ${expiresAt.toISOString()}). Cannot approve.`;
      console.warn(`⚠️ ${msg}`);
      return { success: false, message: msg };
    }

    // 4. Parse reminders from stored JSON and dispatch
    const reminders = approval.reminders_json || [];
    let sentCount = 0;
    let failedCount = 0;

    if (Array.isArray(reminders) && reminders.length > 0) {
      // Per-reminder results, so each row's log reflects what actually happened.
      const results = await notificationChannel.sendApprovedReminders(reminders);

      // 5. Log each dispatch outcome with its true status and Gmail message id.
      for (const r of results) {
        // One log row per ITEM in the digest. The recipient received a single
        // email, but each row it covered records its own SENT/FAILED occurrence,
        // which is what keeps the per-period cap counting per row.
        //
        // task_id is an FK into `tasks`, which the pipeline never populates —
        // writing the sheet's row number there raises a foreign-key violation.
        // The stable text identity goes in task_key instead.
        const items = Array.isArray(r.reminder.items) ? r.reminder.items : [];
        for (const item of items) {
          await db.query(
            `INSERT INTO reminder_logs
               (task_key, recipient_email, reminder_type, status, draft_id, message_id, error_text, sent_at, approval_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              item.tabName && item.rowIndex ? reminderKey(item.tabName, item.rowIndex) : null,
              r.reminder.recipientEmail,
              r.reminder.reminderType || 'APPROVED',
              r.sent ? 'SENT' : 'FAILED',
              r.reminder.draftId || null,
              r.messageId || null,
              r.error || null,
              (r.sentAt || new Date()).toISOString(),
              approval.id,
            ]
          );
        }
        // Counts are per EMAIL — that is what "N sent, M failed" means to the
        // operator reading the result of an approval.
        if (r.sent) sentCount++;
        else failedCount++;
      }
    }

    // 6. Record the outcome. A batch where nothing sent is not an approval success.
    const allFailed = reminders.length > 0 && sentCount === 0;
    await db.query('UPDATE approval_requests SET status = $1 WHERE run_id = $2', [
      allFailed ? 'PENDING' : 'APPROVED',
      runId,
    ]);

    if (allFailed) {
      const msg = `Run ID "${runId}": all ${failedCount} reminder(s) FAILED to send — left PENDING so it can be retried.`;
      console.error(`❌ ${msg}`);
      return { success: false, message: msg };
    }

    const msg =
      `Run ID "${runId}" approved. ${sentCount} reminder(s) sent` +
      (failedCount > 0 ? `, ${failedCount} FAILED (see reminder_logs.error_text).` : '.');
    console.log(msg);
    return { success: true, message: msg };
  } catch (err: any) {
    const msg = `Error approving run "${runId}": ${err.message}`;
    console.error(`❌ ${msg}`);
    return { success: false, message: msg };
  }
}

// Command-line execution entrypoint.
// Guarded so that importing approveAndDispatchRun (e.g. from the dashboard server)
// does not kick off a full pipeline run as a side effect of the import.
const invokedDirectly =
  Boolean(process.argv[1]) && /(^|[\\/])agent\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const showStatsOnly = args.includes('--stats');
  // The hourly scheduled task passes this; Staff Tracker is then not read at all.
  const reportsOnly = args.includes('--reports-only');
  const approveIdx = args.indexOf('--approve');
  const approveRunId = approveIdx !== -1 ? args[approveIdx + 1] : undefined;

  const agent = new CFOAgent();
  agent.runPipeline({ dryRun, approveRunId, showStatsOnly, reportsOnly }).catch(err => {
    console.error('\n❌ Unhandled Agent Error:', err);
    process.exit(1);
  });
}
