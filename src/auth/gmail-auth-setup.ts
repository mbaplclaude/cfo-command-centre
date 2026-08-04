import { google } from 'googleapis';
import http from 'http';
import url from 'url';
import dotenv from 'dotenv';

dotenv.config();

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌ ERROR: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env file!');
  console.log('Please create a Google Cloud OAuth2 Desktop/Web Client ID in Google Cloud Console.');
  console.log('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env and run this script again.\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

async function main() {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n======================================================');
  console.log('🔑 GMAIL OAUTH2 REFRESH TOKEN GENERATOR SETUP');
  console.log('======================================================');
  console.log('1. Open the following URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Log in as mbaplclaudereply@gmail.com and approve access.');
  console.log('3. Waiting for authorization callback on port 3000...\n');

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url && req.url.startsWith('/oauth2callback')) {
        const qs = new url.URL(req.url, REDIRECT_URI).searchParams;
        const code = qs.get('code');

        if (code) {
          res.end('<h1>Authorization Successful!</h1><p>You can close this browser tab and return to your terminal.</p>');
          server.close();

          console.log('\n⏳ Exchanging authorization code for tokens...');
          const { tokens } = await oauth2Client.getToken(code);

          console.log('\n✅ AUTHENTICATION SUCCESSFUL!');
          console.log('------------------------------------------------------');
          console.log('Generated GMAIL_REFRESH_TOKEN:\n');
          console.log(tokens.refresh_token);
          console.log('\n------------------------------------------------------');
          console.log('Save this GMAIL_REFRESH_TOKEN in your .env file:');
          console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
          process.exit(0);
        }
      }
    } catch (err: any) {
      console.error('Error getting tokens:', err);
      res.end('<h1>Authentication Failed</h1>');
      server.close();
      process.exit(1);
    }
  });

  server.listen(3000, () => {
    console.log('Callback server running at http://localhost:3000/oauth2callback');
  });
}

main().catch(console.error);
