import { INotificationChannel, DraftReminderItem, SendResult } from './interface.js';
import { GmailClient } from '../google/gmail.js';
import { CONFIG } from '../config/index.js';

export class GmailNotificationChannel implements INotificationChannel {
  public channelName = 'Gmail';
  private gmailClient = new GmailClient();

  public async createDrafts(reminders: DraftReminderItem[]): Promise<DraftReminderItem[]> {
    const updatedReminders: DraftReminderItem[] = [];

    for (const item of reminders) {
      try {
        console.log(`⏳ Creating Gmail Draft for ${item.recipientEmail} (digest of ${item.items.length} item(s))...`);
        const draftId = await this.gmailClient.createDraft(item.recipientEmail, item.subject, item.body);
        console.log(`  └─ ✅ Draft created with ID: ${draftId}`);
        updatedReminders.push({ ...item, draftId });
      } catch (err: any) {
        console.error(`❌ Failed to create draft for ${item.recipientEmail}:`, err.message);
        updatedReminders.push(item);
      }
    }

    return updatedReminders;
  }

  public async sendApprovedReminders(reminders: DraftReminderItem[]): Promise<SendResult[]> {
    const results: SendResult[] = [];

    for (const item of reminders) {
      console.log(`⏳ Sending approved reminder to ${item.recipientEmail} ("${item.subject}")...`);
      try {
        const messageId = await this.gmailClient.sendEmail(item.recipientEmail, item.subject, item.body);
        // A message id back from Gmail is the only real proof of delivery to the
        // API; anything less is an assumption.
        if (!messageId) throw new Error('Gmail accepted the request but returned no message id');
        console.log(`  └─ ✅ Sent (Message ID: ${messageId})`);
        results.push({ reminder: item, sent: true, messageId, sentAt: new Date() });
      } catch (err: any) {
        // Keep going: one bad recipient must not silently drop the whole batch.
        console.error(`  └─ ❌ Send FAILED for ${item.recipientEmail}: ${err.message}`);
        results.push({ reminder: item, sent: false, error: err.message });
      }
    }

    const sent = results.filter(r => r.sent).length;
    console.log(`  └─ Dispatch summary: ${sent} sent, ${results.length - sent} failed.`);
    return results;
  }

  /**
   * Tell an assignee a task was just assigned to them.
   *
   * Deliberately NOT gated by REQUIRE_APPROVAL. That gate exists for reminders —
   * automated, recurring, chasing mail that a human never individually authorised.
   * This is the direct result of a person clicking "Add to Sheet" seconds earlier,
   * so a human is already in the loop; holding it for a second approval would mean
   * the assignee learns of the task later than the operator expects.
   * Set NOTIFY_ASSIGNEE_ON_ADD=false to disable.
   */
  public async sendAssignmentNotification(task: {
    taskDescription: string;
    recipientName: string;
    recipientEmail: string;
    dueDate: string;
    dateAssigned: string;
    taskType: string;
    tabName: string;
  }): Promise<string> {
    const subject = `New task assigned: ${task.taskDescription}`;
    const lines = [
      `Hi ${task.recipientName || 'there'},`,
      '',
      `A new item has been assigned to you in the OGI Finance Office tracker.`,
      '',
      `  Task:      ${task.taskDescription}`,
      `  Type:      ${task.taskType || 'One-Time'}`,
      `  Assigned:  ${task.dateAssigned || '(not set)'}`,
      `  Due:       ${task.dueDate || '(not set)'}`,
      `  Tracker:   ${task.tabName}`,
      '',
      `Please reply to this email with your submission when complete — replying here`,
      `is what marks the task as received, so keep this thread for your response.`,
      '',
      'Thank you,',
      'OGI Finance Office',
    ];

    console.log(`⏳ Sending assignment notification to ${task.recipientEmail}...`);
    const messageId = await this.gmailClient.sendEmail(task.recipientEmail, subject, lines.join('\n'));
    console.log(`  └─ ✅ Assignment notification sent (Message ID: ${messageId})`);
    return messageId;
  }

  public async sendOperatorSummary(
    runId: string,
    reminders: DraftReminderItem[],
    invalidRows: any[],
    expiresAt: Date,
    chronicRows: Array<{ tabName: string; rowIndex: number; title: string; recipientEmail: string; overdueDays: number; count: number }> = []
  ): Promise<string> {
    const subject = `[APPROVAL REQUIRED] CFO Command Centre: ${reminders.length} Reminders Prepared (Run ID: ${runId})`;

    let body = `CFO Command Centre - Human Approval Required\n`;
    body += `========================================================\n\n`;
    body += `The CFO Agent has completed its evaluation run (Run ID: ${runId}).\n`;
    body += `REQUIRE_APPROVAL is enabled. ${reminders.length} reminder drafts have been prepared.\n\n`;

    body += `APPROVAL INSTRUCTIONS:\n`;
    body += `To approve and dispatch these reminders, execute the following command in your terminal before ${expiresAt.toLocaleString()}:\n\n`;
    body += `   npm run agent -- --approve ${runId}\n\n`;

    const totalItems = reminders.reduce((n, r) => n + r.items.length, 0);
    body += `SUMMARY OF PENDING DIGESTS (${reminders.length} email(s) covering ${totalItems} item(s)):\n`;
    body += `--------------------------------------------------------\n`;
    body += `One consolidated digest per recipient — not one email per task.\n\n`;
    reminders.forEach((r, idx) => {
      body += `${idx + 1}. ${r.recipientName} <${r.recipientEmail}> — ${r.items.length} item(s)\n`;
      body += `   Subject: ${r.subject}\n`;
      r.items.forEach(item => {
        body += `     • [${item.tabName} Row ${item.rowIndex}] "${item.taskDescription}" — due ${item.dueLabel} (${item.overdueDays} day(s) overdue)\n`;
      });
      body += `   Draft ID: ${r.draftId || 'N/A'}\n\n`;
    });

    if (chronicRows.length > 0) {
      body += `🚩 CHRONICALLY OVERDUE — NEEDS MANUAL ESCALATION (${chronicRows.length}):\n`;
      body += `--------------------------------------------------------\n`;
      body += `These rows have received ${chronicRows[0].count >= 10 ? '10 or more' : 'the maximum'} reminders this period.\n`;
      body += `Automatic reminders have STOPPED for them — they need a decision, not another email.\n\n`;
      chronicRows.forEach((r, idx) => {
        body += `${idx + 1}. [${r.tabName} Row ${r.rowIndex}] "${r.title}"\n`;
        body += `   Assignee: ${r.recipientEmail}\n`;
        body += `   ${r.overdueDays} day(s) overdue · ${r.count} reminder(s) already sent this period\n\n`;
      });
    }

    if (invalidRows.length > 0) {
      body += `NEEDS ATTENTION REPORT (Skipped ${invalidRows.length} Rows with Invalid/Missing Data):\n`;
      body += `--------------------------------------------------------\n`;
      invalidRows.forEach((inv, idx) => {
        body += `${idx + 1}. [${inv.tabName} Row ${inv.rowIndex}] "${inv.taskDescriptionOrName}"\n`;
        body += `   Email: ${inv.emailId || '(Missing)'} | Issue: ${inv.validationIssue}\n\n`;
      });
    }

    body += `Note: If no approval is received within ${CONFIG.APPROVAL_TIMEOUT_HOURS} hours, this summary will be re-sent once and then held.\n`;

    console.log(`⏳ Sending Operator Approval Summary to ${CONFIG.OPERATOR_EMAIL}...`);
    const messageId = await this.gmailClient.sendEmail(CONFIG.OPERATOR_EMAIL, subject, body);
    console.log(`  └─ ✅ Operator summary sent (Message ID: ${messageId})`);

    return messageId;
  }
}
