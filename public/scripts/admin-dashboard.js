// Admin dashboard wiring — fetches bridge status + stats and renders
// them. Same auth flow as /admin/connect-youtube (tokeninfo against
// the user's localStorage refresh token).

const YT_REFRESH_KEY = 'yt_refresh_token';

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

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function fmtAge(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return `${mins}m ago`;
}

function fmtRuntime(seconds) {
  if (!seconds) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function setStatusError(html) {
  document.getElementById('admin-token-status').innerHTML = `<p class="text-red-400 text-sm">${html}</p>`;
}

async function init() {
  const refreshToken = localStorage.getItem(YT_REFRESH_KEY);
  if (!refreshToken) {
    setStatusError('Sign into <a href="/capture" class="underline">/capture</a> first, then come back.');
    return;
  }

  const accessToken = await fetchAccessToken(refreshToken);
  if (!accessToken) {
    setStatusError('Could not refresh access token — try signing out + back in on <a href="/capture" class="underline">/capture</a>.');
    return;
  }

  const res = await fetch('/api/youtube-bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'admin-status', accessToken }),
  });
  const data = await res.json().catch(() => ({}));

  if (res.status === 403) {
    setStatusError(`Signed in as <strong>${escapeHtml(data?.email || '?')}</strong> — not on the admin allowlist.`);
    return;
  }
  if (!res.ok) {
    setStatusError(`Bridge status request failed (${res.status}). Bridge function may not be deployed yet.`);
    return;
  }

  // Token status panel
  const tokenStatusEl = document.getElementById('admin-token-status');
  if (data.hasToken) {
    tokenStatusEl.innerHTML = `
      <p class="text-green-400 mb-2">✓ Connected</p>
      <p class="text-white/50 text-xs">Stored ${escapeHtml(fmtAge(data.storedAt))} by <strong class="text-white/70">${escapeHtml(data.storedBy)}</strong></p>
    `;
  } else {
    tokenStatusEl.innerHTML = `
      <p class="text-yellow-400 mb-2">⚠ Not connected</p>
      <p class="text-white/50 text-xs">No bridge token stored. Whitelisted users will fall back to uploading to their own channels until you connect one.</p>
    `;
  }

  // Stats panel
  const stats = data.stats || { uploads: 0, totalSeconds: 0, totalBytes: 0, byUploader: {}, lastUploadAt: null };
  document.getElementById('stat-total-uploads').textContent = stats.uploads || 0;
  document.getElementById('stat-total-runtime').textContent = fmtRuntime(stats.totalSeconds || 0);
  document.getElementById('stat-total-bytes').textContent = fmtBytes(stats.totalBytes || 0);
  const lastEl = document.getElementById('stat-last-upload');
  if (stats.lastUploadAt) {
    lastEl.innerHTML = `Last upload: ${escapeHtml(fmtAge(stats.lastUploadAt))}`;
  } else {
    lastEl.textContent = 'No bridge uploads yet.';
  }

  // By-uploader breakdown
  const byEl = document.getElementById('admin-by-uploader');
  const entries = Object.entries(stats.byUploader || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    byEl.innerHTML = '<p class="text-white/40 italic">No uploads to attribute yet.</p>';
  } else {
    byEl.innerHTML = entries.map(([email, count]) => `
      <div class="flex justify-between gap-3 py-1.5 border-b border-white/10 last:border-b-0">
        <span class="truncate text-white/70">${escapeHtml(email)}</span>
        <span class="text-white tabular-nums shrink-0">${count} ${count === 1 ? 'upload' : 'uploads'}</span>
      </div>
    `).join('');
  }

  // Allowed-uploaders list
  const allowedEl = document.getElementById('admin-allowed-list');
  if ((data.allowedEmails || []).length === 0) {
    allowedEl.innerHTML = '<li class="text-yellow-400/80 italic">⚠ None configured yet.</li>';
  } else {
    allowedEl.innerHTML = data.allowedEmails.map(e => `<li>${escapeHtml(e)}</li>`).join('');
  }
}

init();
