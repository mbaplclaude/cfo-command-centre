import { DigestItem } from '../classifier/cadence.js';

/**
 * One daily digest email for one recipient.
 *
 * Replaces the old one-email-per-row shape: `items` carries every row bundled
 * into this single message, so the send path stays "one item = one email" while
 * the recipient receives exactly one mail per day covering everything.
 *
 * `items` is what per-row bookkeeping (reminder_logs, the per-period cap) iterates
 * over — one digest send counts as one occurrence against each included row.
 */
export interface DraftReminderItem {
  tabName: string;
  recipientName: string;
  recipientEmail: string;
  reminderType: string;
  subject: string;
  body: string;
  items: DigestItem[];
  draftId?: string;
}

/** Outcome of one attempted dispatch. `messageId` is proof of a real send. */
export interface SendResult {
  reminder: DraftReminderItem;
  sent: boolean;
  messageId?: string;
  sentAt?: Date;
  error?: string;
}

export interface INotificationChannel {
  channelName: string;
  
  /**
   * Draft reminder messages for recipient approval
   */
  createDrafts(reminders: DraftReminderItem[]): Promise<DraftReminderItem[]>;

  /**
   * Dispatch approved reminder drafts.
   *
   * Returns one result per reminder so callers can record TRUE send confirmation
   * (the Gmail message id) rather than assuming success. One failing recipient
   * must not abort the rest of the batch.
   */
  sendApprovedReminders(reminders: DraftReminderItem[]): Promise<SendResult[]>;

  /**
   * Send summary email to operator for human approval
   */
  sendOperatorSummary(
    runId: string,
    reminders: DraftReminderItem[],
    invalidRows: any[],
    expiresAt: Date,
    chronicRows?: Array<{ tabName: string; rowIndex: number; title: string; recipientEmail: string; overdueDays: number; count: number }>
  ): Promise<string>;
}
