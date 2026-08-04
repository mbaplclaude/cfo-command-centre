import { INotificationChannel, DraftReminderItem, SendResult } from './interface.js';

/**
 * WhatsApp Channel Interface Stub (Pluggable for future extension)
 * Out of scope for v1 as per specification.
 */
export class WhatsAppChannelStub implements INotificationChannel {
  public channelName = 'WhatsApp (Future Integration Stub)';

  public async createDrafts(reminders: DraftReminderItem[]): Promise<DraftReminderItem[]> {
    console.log(`[WhatsApp Stub] ${reminders.length} WhatsApp drafts logged (channel not active in v1).`);
    return reminders;
  }

  public async sendApprovedReminders(reminders: DraftReminderItem[]): Promise<SendResult[]> {
    console.log(`[WhatsApp Stub] ${reminders.length} WhatsApp messages held (channel not active in v1).`);
    // Nothing is actually delivered, so report every item as not sent rather than
    // letting a stub masquerade as a successful dispatch.
    return reminders.map(reminder => ({
      reminder,
      sent: false,
      error: 'WhatsApp channel is not active in v1',
    }));
  }

  public async sendOperatorSummary(
    runId: string,
    reminders: DraftReminderItem[],
    invalidRows: any[],
    expiresAt: Date
  ): Promise<string> {
    console.log(`[WhatsApp Stub] Operator summary stub called for Run ID: ${runId}`);
    return 'whatsapp-stub-msg-id';
  }
}
