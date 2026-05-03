// Admin page wiring: reads the user's existing OAuth state from
// localStorage, hits /api/youtube-bridge for status, and lets approved
// admins persist their refresh token as the bridge token.

const YT_REFRESH_KEY  = 'yt_refresh_token';
const YT_CHANNEL_KEY  = 'yt_channel';

const statusEl   = document.getElementById('bridge-status');
const savePanel  = document.getElementById('bridge-save-panel');
const saveBtn    = document.getElementById('bridge-save-btn');
const saveChan   = document.getElementById('bridge-save-channel');
const signinEl   = document.getElementById('bridge-signin-prompt');
const clearPanel = document.getElementById('bridge-clear-panel');
const clearBtn   = document.getElementById('bridge-clear-btn');

// Ask the existing /api/youtube-publish endpoint for a fresh access
// token using the current user's refresh token (the same path the
// recorder uses on every sign-in).
async function fetchAccessToken(refreshToken) {
  const res = await fetch('/api/youtube-publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'token', refreshToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.accessToken || null;
}

async function callBridge(action, body, accessToken) {
  const res = await fetch('/api/youtube-bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, accessToken, ...body }),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

function fmtAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `${mins}m ago`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function showStatus(msg, kind = 'neutral') {
  const tone = kind === 'good' ? 'text-green-400'
             : kind === 'warn' ? 'text-yellow-400'
             : kind === 'bad'  ? 'text-red-400'
             : 'text-white/70';
  statusEl.innerHTML = `<p class="${tone} text-sm leading-7">${msg}</p>`;
}

async function refresh() {
  // Step 1: do we have a refresh token in this browser?
  const refreshToken = localStorage.getItem(YT_REFRESH_KEY);
  let channelLabel = '';
  try {
    const channelRaw = localStorage.getItem(YT_CHANNEL_KEY);
    if (channelRaw) {
      const channel = JSON.parse(channelRaw);
      if (channel?.handle) channelLabel = channel.handle;
      else if (channel?.title) channelLabel = channel.title;
    }
  } catch {}

  if (!refreshToken) {
    statusEl.classList.add('hidden');
    signinEl.classList.remove('hidden');
    return;
  }

  // Step 2: exchange refresh token for an access token (so we can call the bridge)
  const accessToken = await fetchAccessToken(refreshToken);
  if (!accessToken) {
    showStatus('Could not exchange refresh token for an access token. The token may be expired — sign in again on /capture and come back.', 'bad');
    return;
  }

  // Step 3: ask the bridge for status (this also tells us if we're an admin)
  const { status, data } = await callBridge('admin-status', {}, accessToken);

  if (status === 403) {
    showStatus(`Signed in as <strong>${escapeHtml(data?.email || '?')}</strong>, but that email isn't on the bridge admin allowlist (YOUTUBE_BRIDGE_ADMIN_EMAILS env var). Add it in the Netlify dashboard, redeploy, and reload this page.`, 'warn');
    return;
  }
  if (!data?.adminEmail) {
    showStatus('Could not verify admin status. Check that the bridge function is deployed and the env vars are set.', 'bad');
    return;
  }

  // Status panel
  const allowedList = (data.allowedEmails || []).length
    ? `<ul class="mt-2 ml-4 list-disc text-white/70">${data.allowedEmails.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
    : '<p class="mt-2 text-yellow-400/80 italic">⚠ No allowed emails configured. Set YOUTUBE_BRIDGE_ALLOWED_EMAILS to enable bridged uploads.</p>';

  if (data.hasToken) {
    showStatus(
      `<div class="space-y-2">
        <p>✓ Bridge token is set.</p>
        <p class="text-white/50 text-xs">Stored ${escapeHtml(fmtAge(data.storedAt))} by <strong>${escapeHtml(data.storedBy)}</strong></p>
        <p class="text-white/50 text-xs">Signed in as <strong>${escapeHtml(data.adminEmail)}</strong></p>
        <p class="text-white/50 text-xs mt-3"><strong>Allowed bridge uploaders:</strong></p>
        ${allowedList}
       </div>`,
      'good'
    );
    clearPanel.classList.remove('hidden');
  } else {
    showStatus(
      `<div class="space-y-2">
        <p>No bridge token set yet. Save your current sign-in below.</p>
        <p class="text-white/50 text-xs">Signed in as <strong>${escapeHtml(data.adminEmail)}</strong></p>
        <p class="text-white/50 text-xs mt-3"><strong>Allowed bridge uploaders:</strong></p>
        ${allowedList}
       </div>`,
      'warn'
    );
  }

  // Step 4: show the save panel — your current localStorage refresh token
  // is what gets saved. Surface which channel it represents so you don't
  // accidentally save the wrong account's token.
  savePanel.classList.remove('hidden');
  saveChan.textContent = channelLabel
    ? `Will save the token for: ${channelLabel}`
    : `Will save the refresh token currently in this browser.`;

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const result = await callBridge('admin-store-token', { refreshToken }, accessToken);
    if (result.ok) {
      saveBtn.textContent = '✓ Saved';
      setTimeout(() => { saveBtn.textContent = 'Save as bridge token'; saveBtn.disabled = false; }, 1500);
      refresh();
    } else {
      saveBtn.textContent = 'Save failed';
      showStatus(`Save failed: ${escapeHtml(result.data?.error || 'unknown error')}`, 'bad');
      setTimeout(() => { saveBtn.textContent = 'Save as bridge token'; saveBtn.disabled = false; }, 2000);
    }
  };

  if (clearBtn) {
    clearBtn.onclick = async () => {
      if (!confirm('Clear the bridge token? Whitelisted users will fall back to their own channels until you reconnect.')) return;
      clearBtn.disabled = true;
      clearBtn.textContent = 'Clearing…';
      const result = await callBridge('admin-clear-token', {}, accessToken);
      if (result.ok) {
        clearBtn.textContent = '✓ Cleared';
        setTimeout(() => refresh(), 800);
      } else {
        clearBtn.textContent = 'Clear failed';
        setTimeout(() => { clearBtn.textContent = 'Clear bridge token'; clearBtn.disabled = false; }, 2000);
      }
    };
  }
}

refresh();
