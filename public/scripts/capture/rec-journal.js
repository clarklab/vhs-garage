// Flight recorder for capture sessions.
//
// Long recordings were dying around the 1.5–2 hour mark with no trace of
// why — the tab was gone and so was the console. This journal lives in
// localStorage (synchronous, so it survives a renderer crash up to the last
// heartbeat) and records what the recorder was doing: parts written, bytes,
// JS heap, write errors, MediaRecorder errors, stalls, tab visibility.
//
// On the next page load app.js reads it back: a journal whose state never
// reached 'done' means the session was interrupted, and its part list is
// what the recovery prompt joins.

const JOURNAL_KEY = 'vhsg_rec_journal';
const HISTORY_KEY = 'vhsg_rec_history';
// Unresolved sessions pushed aside when a new recording starts, so a new
// take never overwrites the record of parts still waiting to be joined.
const PENDING_KEY = 'vhsg_rec_pending';
const RESOLVED = new Set(['done', 'failed', 'dismissed']);
const MAX_EVENTS = 80;
const MAX_HISTORY = 15;

let journal = null;

function heapMB() {
  const m = performance.memory;
  return m ? Math.round(m.usedJSHeapSize / (1024 * 1024)) : null;
}

function persist() {
  if (!journal) return;
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  } catch (e) {
    // Quota pressure from the clip catalog — trim events and retry once.
    journal.events = journal.events.slice(-10);
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal)); }
    catch (e2) { console.error('[rec-journal] could not persist journal:', e2); }
  }
}

export function beginJournal(fields) {
  const prev = readJournal();
  if (prev && !RESOLVED.has(prev.state)) {
    const pending = readPending().filter(p => p.id !== prev.id);
    pending.push(prev);
    writePending(pending);
  }
  journal = {
    id: Date.now().toString(36),
    startedAt: new Date().toISOString(),
    state: 'recording',
    parts: [],
    bytes: 0,
    elapsed: 0,
    initBytes: 0,
    lastBeatAt: new Date().toISOString(),
    heapStartMB: heapMB(),
    heapMB: heapMB(),
    heapPeakMB: heapMB(),
    userAgent: navigator.userAgent,
    events: [],
    ...fields,
  };
  persist();
  return journal;
}

export function updateJournal(fields) {
  if (!journal) return;
  Object.assign(journal, fields);
  persist();
}

export function heartbeat({ bytes, elapsed, backlogBytes }) {
  if (!journal) return;
  const heap = heapMB();
  journal.bytes = bytes;
  journal.elapsed = elapsed;
  journal.backlogBytes = backlogBytes;
  journal.heapMB = heap;
  if (heap != null && heap > (journal.heapPeakMB || 0)) journal.heapPeakMB = heap;
  journal.lastBeatAt = new Date().toISOString();
  persist();
}

// level: 'info' | 'warn' | 'error'. Mirrors to the console so the same
// trail shows up in DevTools while the tab is alive.
export function logEvent(level, msg, data) {
  const line = data ? `${msg} ${JSON.stringify(data)}` : msg;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  fn(`[recorder] ${line}`);
  if (!journal) return;
  journal.events.push({ t: new Date().toISOString(), elapsed: journal.elapsed, level, msg: line });
  if (journal.events.length > MAX_EVENTS) journal.events.splice(0, journal.events.length - MAX_EVENTS);
  persist();
}

export function setPart(index, fields) {
  if (!journal) return;
  journal.parts[index] = { ...(journal.parts[index] || {}), ...fields };
  persist();
}

// Close out the session: state is 'done' (joined cleanly), 'needs-join'
// (parts on disk, join failed or never ran) or 'failed' (nothing usable).
export function endJournal(state, fields = {}) {
  if (!journal) return;
  Object.assign(journal, fields, { state, endedAt: new Date().toISOString() });
  persist();
  pushHistory(journal);
  journal = null;
}

function pushHistory(j) {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    history.unshift({
      id: j.id, startedAt: j.startedAt, endedAt: j.endedAt, state: j.state,
      filename: j.filename, elapsed: j.elapsed, bytes: j.bytes,
      parts: j.parts.length, heapStartMB: j.heapStartMB, heapPeakMB: j.heapPeakMB,
      errors: j.events.filter(e => e.level !== 'info').slice(-5),
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch (e) {
    console.warn('[rec-journal] could not update history:', e);
  }
}

// --- Read side (page load / recovery) ---

export function readJournal() {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
  } catch {
    return null;
  }
}

export function readHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function readPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch {
    return [];
  }
}

function writePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }
  catch (e) { console.error('[rec-journal] could not save pending sessions:', e); }
}

// Sessions that never reached 'done': the tab crashed or was closed
// mid-recording, or the join on stop failed. Oldest first.
export function pendingRecoveries() {
  const list = readPending();
  const cur = readJournal();
  // Only the in-memory journal is live; a stored unresolved one with no
  // live session is by definition interrupted.
  const live = journal && cur && journal.id === cur.id;
  if (cur && !RESOLVED.has(cur.state) && !live && !list.some(p => p.id === cur.id)) list.push(cur);
  return list;
}

export function resolveRecovery(id, state, fields = {}) {
  const target = pendingRecoveries().find(j => j.id === id);
  if (!target) return;
  if (target.state === 'recording' || target.state === 'finalizing') {
    target.events.push({ t: new Date().toISOString(), level: 'error', msg: 'session was interrupted (tab crashed, closed or reloaded mid-recording)' });
  }
  Object.assign(target, fields, { state, resolvedAt: new Date().toISOString() });
  writePending(readPending().filter(p => p.id !== id));
  const cur = readJournal();
  if (cur && cur.id === id) {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(target)); } catch {}
  }
  pushHistory(target);
}

// Part files for a recording still awaiting a join — the library's orphan
// scan skips these so they don't get imported as separate clips.
export function isPendingPartFile(name) {
  return pendingRecoveries().some(j => (j.parts || []).some(p => p && p.name === name));
}

export function diagnosticsText() {
  return JSON.stringify({ current: readJournal(), pending: readPending(), history: readHistory() }, null, 2);
}
