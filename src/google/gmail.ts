import { google, gmail_v1 } from 'googleapis';
import { CONFIG } from '../config/index.js';
import { GmailMessageSummary, GmailAttachment } from '../types/index.js';

export class GmailClient {
  private gmail: gmail_v1.Gmail | null = null;
  private oauth2Client: any = null;

  /**
   * Get authenticated OAuth2 client using client credentials and stored refresh token
   */
  public async getClient(): Promise<gmail_v1.Gmail> {
    if (this.gmail) return this.gmail;

    if (!CONFIG.GMAIL_CLIENT_ID || !CONFIG.GMAIL_CLIENT_SECRET || !CONFIG.GMAIL_REFRESH_TOKEN) {
      throw new Error(
        'Gmail OAuth2 credentials missing! Please run `npm run auth:gmail` to generate GMAIL_REFRESH_TOKEN and set credentials in .env.'
      );
    }

    this.oauth2Client = new google.auth.OAuth2(
      CONFIG.GMAIL_CLIENT_ID,
      CONFIG.GMAIL_CLIENT_SECRET,
      CONFIG.GMAIL_REDIRECT_URI
    );

    this.oauth2Client.setCredentials({
      refresh_token: CONFIG.GMAIL_REFRESH_TOKEN,
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    return this.gmail;
  }

  /**
   * Search Gmail inbox for messages from sender Email ID received after date
   */
  public async searchRepliesFrom(
    senderEmail: string,
    afterDate?: string | Date
  ): Promise<GmailMessageSummary[]> {
    const gmail = await this.getClient();

    // Enforce Rule 4: Exclude own / sender addresses
    const cleanedSender = senderEmail.trim().toLowerCase();
    if (CONFIG.OWN_SENDER_EMAILS.includes(cleanedSender)) {
      return [];
    }

    let query = `from:${cleanedSender}`;
    if (afterDate) {
      const d = typeof afterDate === 'string' ? new Date(afterDate) : afterDate;
      if (!isNaN(d.getTime())) {
        const formattedDate = d.toISOString().split('T')[0];
        query += ` after:${formattedDate}`;
      }
    }

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20,
    });

    const messages = response.data.messages || [];
    const results: GmailMessageSummary[] = [];

    for (const msg of messages) {
      if (!msg.id) continue;
      const details = await this.getMessageDetails(msg.id);
      if (details) {
        // Exclude messages from self
        const fromHeader = details.from.toLowerCase();
        const isSelf = CONFIG.OWN_SENDER_EMAILS.some(own => fromHeader.includes(own));
        if (!isSelf) {
          results.push(details);
        }
      }
    }

    return results;
  }

  /**
   * Fetch full message details by ID
   */
  public async getMessageDetails(messageId: string): Promise<GmailMessageSummary | null> {
    const gmail = await this.getClient();
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const msg = response.data;
    if (!msg || !msg.payload) return null;

    const headers = msg.payload.headers || [];
    const getHeader = (name: string) =>
      headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const from = getHeader('from');
    const to = getHeader('to');
    const subject = getHeader('subject');
    const dateStr = getHeader('date');
    const date = dateStr ? new Date(dateStr) : new Date();

    // Extract body text & collect attachment metadata
    let bodyText = msg.snippet || '';
    const attachments: GmailAttachment[] = [];

    const parseParts = (parts: any[]) => {
      for (const part of parts) {
        if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType || 'application/octet-stream',
            sizeBytes: Number(part.body.size || 0),
            attachmentId: part.body.attachmentId,
            messageId: msg.id!,
          });
        }
        if (part.mimeType === 'text/plain' && part.body && part.body.data) {
          bodyText = Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          parseParts(part.parts);
        }
      }
    };

    if (msg.payload.parts) {
      parseParts(msg.payload.parts);
    }

    return {
      id: msg.id!,
      threadId: msg.threadId || '',
      from,
      to,
      subject,
      date,
      bodyText,
      snippet: msg.snippet || '',
      hasAttachments: attachments.length > 0,
      attachments,
    };
  }

  /**
   * Fetch one attachment's bytes. Gmail attachment ids are only meaningful
   * together with the message they belong to, hence both parameters.
   */
  public async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const gmail = await this.getClient();
    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    const data = response.data.data || '';
    return Buffer.from(data, 'base64url');
  }

  /**
   * Create a Gmail Draft for a reminder email (does not send)
   */
  public async createDraft(to: string, subject: string, body: string): Promise<string> {
    const gmail = await this.getClient();
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const messageParts = [
      `From: ${CONFIG.GMAIL_ACCOUNT}`,
      `To: ${to}`,
      `Subject: ${utf8Subject}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body,
    ];
    const message = messageParts.join('\n');
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedMessage,
        },
      },
    });

    return draft.data.id || '';
  }

  /**
   * List every draft in the mailbox with enough metadata to identify it.
   * drafts.list returns ids only, so each one needs a metadata fetch.
   */
  public async listDrafts(): Promise<Array<{ draftId: string; messageId: string; subject: string; to: string; date: string }>> {
    const gmail = await this.getClient();
    const drafts: Array<{ draftId: string; messageId: string; subject: string; to: string; date: string }> = [];

    let pageToken: string | undefined;
    do {
      const list = await gmail.users.drafts.list({ userId: 'me', maxResults: 100, pageToken });
      for (const d of list.data.drafts || []) {
        if (!d.id) continue;
        const detail = await gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'metadata' });
        const headers = detail.data.message?.payload?.headers || [];
        const header = (name: string) =>
          headers.find((h: any) => (h.name || '').toLowerCase() === name.toLowerCase())?.value || '';
        drafts.push({
          draftId: d.id,
          messageId: detail.data.message?.id || '',
          subject: header('subject'),
          to: header('to'),
          date: header('date'),
        });
      }
      pageToken = list.data.nextPageToken || undefined;
    } while (pageToken);

    return drafts;
  }

  /** Permanently delete a draft. The draft is removed, not sent. */
  public async deleteDraft(draftId: string): Promise<void> {
    const gmail = await this.getClient();
    await gmail.users.drafts.delete({ userId: 'me', id: draftId });
  }

  /**
   * Send email (e.g. summary to operator or forwarding verified response)
   */
  public async sendEmail(to: string, subject: string, body: string): Promise<string> {
    const gmail = await this.getClient();
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const messageParts = [
      `From: ${CONFIG.GMAIL_ACCOUNT}`,
      `To: ${to}`,
      `Subject: ${utf8Subject}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body,
    ];
    const message = messageParts.join('\n');
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const sent = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    return sent.data.id || '';
  }
}
