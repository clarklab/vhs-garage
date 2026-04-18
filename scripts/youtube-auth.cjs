#!/usr/bin/env node
/**
 * One-time OAuth setup for YouTube uploads.
 *
 * Prerequisites:
 * 1. Go to https://console.cloud.google.com
 * 2. Create a project (or use existing)
 * 3. Enable "YouTube Data API v3"
 * 4. Create OAuth 2.0 credentials (Desktop app type)
 * 5. Download the JSON and note the client_id and client_secret
 *
 * Usage:
 *   node scripts/youtube-auth.cjs <client_id> <client_secret>
 *
 * This will open a browser for Google login, then print the refresh token.
 * Add these to Netlify env vars:
 *   YOUTUBE_OAUTH_CLIENT_ID=<client_id>
 *   YOUTUBE_OAUTH_CLIENT_SECRET=<client_secret>
 *   YOUTUBE_OAUTH_REFRESH_TOKEN=<refresh_token>
 */

const http = require('http');
const { exec } = require('child_process');

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];
const REDIRECT_PORT = 8919;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('Usage: node scripts/youtube-auth.cjs <client_id> <client_secret>');
  process.exit(1);
}

// Build auth URL
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPE)}&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log('\nOpening browser for Google authorization...\n');

// Open browser
const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
exec(`${openCmd} "${authUrl}"`);

// Start local server to catch the redirect
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('No code received');
    return;
  }

  // Exchange code for tokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.refresh_token) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Success! You can close this tab.</h2><p>Check your terminal for the refresh token.</p>');

      console.log('='.repeat(60));
      console.log('SUCCESS! Add these to your Netlify environment variables:\n');
      console.log(`YOUTUBE_OAUTH_CLIENT_ID=${CLIENT_ID}`);
      console.log(`YOUTUBE_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`YOUTUBE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('='.repeat(60));
    } else {
      res.writeHead(500);
      res.end('No refresh token received. Try again with prompt=consent.');
      console.error('Token response:', tokens);
    }
  } catch (e) {
    res.writeHead(500);
    res.end('Error exchanging code');
    console.error(e);
  }

  server.close();
});

server.listen(REDIRECT_PORT, () => {
  console.log(`Waiting for OAuth redirect on port ${REDIRECT_PORT}...`);
});
