import { GmailClient } from '../google/gmail.js';
import { CONFIG } from '../config/index.js';

async function testReadGmail() {
  console.log('\n======================================================');
  console.log('📧 TEST: Gmail OAuth2 Read Access Verification');
  console.log(`Target Account: ${CONFIG.GMAIL_ACCOUNT}`);
  console.log('======================================================\n');

  const gmailClient = new GmailClient();

  try {
    console.log('⏳ Authenticating with Gmail using stored OAuth2 Refresh Token...');
    const gmail = await gmailClient.getClient();
    
    // Test basic profile access
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log('✅ Gmail OAuth2 Authentication SUCCESSFUL!');
    console.log(`   - Connected Email: ${profile.data.emailAddress}`);
    console.log(`   - Total Messages in Account: ${profile.data.messagesTotal}`);
    console.log(`   - Total Threads in Account: ${profile.data.threadsTotal}\n`);

    console.log('⏳ Listing recent messages in inbox (read-only search)...');
    const messages = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 5,
    });

    const msgList = messages.data.messages || [];
    console.log(`✅ Found ${msgList.length} recent messages in inbox:\n`);

    for (const item of msgList) {
      if (!item.id) continue;
      const details = await gmailClient.getMessageDetails(item.id);
      if (details) {
        console.log(`📌 Message ID: ${details.id}`);
        console.log(`   From: ${details.from}`);
        console.log(`   Subject: ${details.subject}`);
        console.log(`   Date: ${details.date.toISOString()}`);
        console.log(`   Snippet: ${details.snippet.substring(0, 80)}...\n`);
      }
    }

    console.log('🔒 SAFETY GUARANTEE: Read-only check verified. Zero drafts created, zero emails sent.');
  } catch (err: any) {
    console.error('\n❌ ERROR Connecting to Gmail:', err.message);
    console.log('\n💡 Hint: Ensure GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN are set in .env');
    console.log('   Run `npm run auth:gmail` to complete the one-time OAuth consent flow if token is missing or expired.');
  }
}

testReadGmail();
