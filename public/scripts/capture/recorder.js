// Crash-safe recording pipeline.
//
// One MediaRecorder runs for the whole take, but its output is written as a
// series of part files (`name.part001.mp4`, `name.part002.mp4`, …), each
// closed — and therefore committed to disk — every PART_SECONDS. Chrome's
// FileSystemWritableFileStream keeps everything in a hidden .crswap file
// until close(), so the old single-writable approach lost the WHOLE take
// when the tab crashed 1.5 hours in. Now a crash costs at most the part in
// progress, and the journal (rec-journal.js) tells the next page load which
// parts to join.
//
// On a clean stop the parts are joined back into `name.mp4` (byte-identical
// to a single continuous file — see segmenter.js for why that holds) and the
// part files are removed. If the join fails (disk full, 4 GB limit on a
// FAT32 drive…) the parts stay put and the session is left as 'needs-join'.

import { createSplitter } from './segmenter.js';
import {
  beginJournal, updateJournal, heartbeat, logEvent, setPart, endJournal,
} from './rec-journal.js';

const config = {
  partSeconds: 10 * 60,
  partMaxBytes: 1024 * 1024 * 1024,
  // Regular keyframes keep Chrome's MP4 muxer emitting a fragment every
  // couple of seconds instead of holding video in memory between sparse
  // keyframes — and give the splitter frequent places to cut.
  keyframeIntervalMs: 2000,
  stallWarnMs: 15000,
  backlogWarnBytes: 64 * 1024 * 1024,
  heartbeatMs: 5000,
};

// Tests and the console can shorten parts to exercise rotation quickly.
export function configureRecorder(overrides) {
  Object.assign(config, overrides);
  return { ...config };
}

let session = null;
let finalizing = false;
let lastFileHandle = null;

export function getLastFileHandle() {
  return lastFileHandle;
}

export function isRecording() {
  return !!session && session.recorder.state === 'recording';
}

// True from Stop until the parts are joined and onStop has fired. A new
// recording must not start in this window.
export function isFinalizing() {
  return finalizing;
}

export function getElapsed() {
  if (!session || !session.startTime) return 0;
  return Math.floor((Date.now() - session.startTime) / 1000);
}

export function getTotalBytes() {
  return session ? session.writtenBytes : 0;
}

export function getRecordingStatus() {
  if (!session) return null;
  return {
    part: session.partIndex + 1,
    parts: session.parts.length,
    writtenBytes: session.writtenBytes,
    backlogBytes: session.receivedBytes - session.processedBytes,
    errors: session.errorCount,
    splitting: !session.splitter.failed,
  };
}

function selectMimeType(format) {
  if (format !== 'webm') {
    if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')) return 'video/mp4;codecs=avc1';
    if (MediaRecorder.isTypeSupported('video/mp4')) return 'video/mp4';
  }
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) return 'video/webm;codecs=vp9';
  return 'video/webm';
}

export function partFilename(filename, index) {
  const m = filename.match(/^(.*?)(\.[^.]+)?$/);
  return `${m[1]}.part${String(index + 1).padStart(3, '0')}${m[2] || ''}`;
}

function describeError(err) {
  return `${err?.name || 'Error'}: ${err?.message || err}`;
}

// --- Part management ---

async function openPart(s) {
  const index = s.parts.length;
  const name = partFilename(s.filename, index);
  const handle = await s.dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  s.parts.push({ name, handle, bytes: 0, state: 'open' });
  s.partIndex = index;
  s.writable = writable;
  s.partStartedAt = Date.now();
  setPart(index, { name, bytes: 0, state: 'open' });
  if (s.initChunks.length) {
    for (const chunk of s.initChunks) {
      await writable.write(chunk);
      s.parts[index].bytes += chunk.length;
    }
  }
  if (index > 0) logEvent('info', `opened part ${index + 1}`, { name });
}

async function closePart(s) {
  const part = s.parts[s.partIndex];
  const writable = s.writable;
  s.writable = null;
  if (!part || !writable || part.state !== 'open') return;
  try {
    await writable.close();
    part.state = 'closed';
    setPart(s.partIndex, { bytes: part.bytes, state: 'closed' });
    logEvent('info', `part ${s.partIndex + 1} saved`, { name: part.name, mb: Math.round(part.bytes / 1048576) });
  } catch (err) {
    part.state = 'failed';
    s.errorCount++;
    setPart(s.partIndex, { bytes: part.bytes, state: 'failed', error: describeError(err) });
    logEvent('error', `part ${s.partIndex + 1} failed to save on close`, { error: describeError(err), mb: Math.round(part.bytes / 1048576) });
    s.onWarning?.(`Part ${s.partIndex + 1} failed to save: ${describeError(err)}`);
  }
}

function shouldRotate(s) {
  const part = s.parts[s.partIndex];
  if (!part || part.bytes <= s.initBytes) return false;
  return Date.now() - s.partStartedAt >= config.partSeconds * 1000 || part.bytes >= config.partMaxBytes;
}

// A write into the current part failed. That part's uncommitted data is
// gone, but the recording itself is fine — start a fresh part at the next
// cut point rather than ending the whole take.
async function recoverFromWriteError(s, err) {
  s.errorCount++;
  const part = s.parts[s.partIndex];
  if (part) {
    part.state = 'failed';
    setPart(s.partIndex, { bytes: part.bytes, state: 'failed', error: describeError(err) });
  }
  try { await s.writable?.abort(); } catch {}
  s.writable = null;
  logEvent('error', `write failed in part ${s.partIndex + 1}`, { error: describeError(err), totalMB: Math.round(s.writtenBytes / 1048576) });
  s.writeFailures++;
  if (s.splitter.failed || s.writeFailures > 3) {
    throw err;
  }
  s.onWarning?.(`Disk write failed (${describeError(err)}). Starting a new part file and continuing.`);
  await openPart(s);
  s.skipUntilCut = true;
}

async function writeUnit(s, unit) {
  if (unit.init) {
    s.initChunks.push(unit.bytes);
    s.initBytes += unit.bytes.length;
    updateJournal({ initBytes: s.initBytes });
  }
  if (s.skipUntilCut) {
    if (!unit.cut) { s.droppedBytes += unit.bytes.length; return; }
    s.skipUntilCut = false;
    if (s.droppedBytes) logEvent('warn', 'dropped bytes after a write failure', { bytes: s.droppedBytes });
  } else if (unit.cut && shouldRotate(s)) {
    await closePart(s);
    await openPart(s);
  }
  try {
    await s.writable.write(unit.bytes);
    s.parts[s.partIndex].bytes += unit.bytes.length;
    s.writtenBytes += unit.bytes.length;
  } catch (err) {
    await recoverFromWriteError(s, err);
  }
}

async function processChunk(s, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const wasSplitting = !s.splitter.failed;
  const units = s.splitter.push(bytes);
  if (wasSplitting && s.splitter.failed) {
    logEvent('warn', 'stream splitter gave up; continuing in a single part', { reason: s.splitter.failReason });
  }
  for (const unit of units) await writeUnit(s, unit);
  s.processedBytes += blob.size;
}

// --- Joining ---

const JOIN_SLICE_BYTES = 64 * 1024 * 1024;

// Join part files into one. `parts` is [{ name }] in order; every part
// begins with `initBytes` of header, which is written once. Exported for
// the recovery flow in app.js. Leaves the parts on disk — the caller
// removes them once it's happy.
export async function joinParts(dir, parts, finalName, initBytes, onProgress) {
  const files = [];
  for (const p of parts) {
    const handle = await dir.getFileHandle(p.name);
    files.push(await handle.getFile());
  }
  // Only the parts that carry media past the header are worth joining.
  const usable = files.filter(f => f.size > initBytes);
  if (!usable.length) throw new Error('no saved parts contain video');

  const slices = usable.map((f, i) => (i === 0 || !initBytes ? f : f.slice(initBytes)));
  const total = slices.reduce((n, b) => n + b.size, 0);

  const finalHandle = await dir.getFileHandle(finalName, { create: true });
  const writable = await finalHandle.createWritable();
  let done = 0;
  try {
    for (const blob of slices) {
      for (let off = 0; off < blob.size; off += JOIN_SLICE_BYTES) {
        const piece = blob.slice(off, Math.min(blob.size, off + JOIN_SLICE_BYTES));
        await writable.write(piece);
        done += piece.size;
        onProgress?.(done / total);
      }
    }
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch {}
    throw err;
  }
  const written = (await finalHandle.getFile()).size;
  if (written !== total) {
    throw new Error(`joined file is ${written} bytes, expected ${total}`);
  }
  return { handle: finalHandle, bytes: total };
}

export async function removeParts(dir, parts) {
  for (const p of parts) {
    try { await dir.removeEntry(p.name); }
    catch (e) { console.warn('[recorder] could not remove part', p.name, e); }
  }
}

async function finalize(s) {
  finalizing = true;
  clearInterval(s.timer);
  const duration = getElapsed();
  try {
    for (const unit of s.splitter.flush()) await writeUnit(s, unit);
  } catch (err) {
    logEvent('error', 'final flush failed', { error: describeError(err) });
  }
  await closePart(s);
  updateJournal({ state: 'finalizing', elapsed: duration, bytes: s.writtenBytes });

  const saved = s.parts.filter(p => p.state === 'closed');
  const lost = s.parts.filter(p => p.state === 'failed');
  if (lost.length) {
    logEvent('warn', `${lost.length} part(s) were lost`, { parts: lost.map(p => p.name) });
  }

  let result;
  if (!saved.length) {
    endJournal('failed', { elapsed: duration });
    result = { error: new Error('No part of the recording could be saved to disk. Check the save folder and free space.') };
  } else if (saved.length === 1 && s.parts.length === 1) {
    // Short take: a single part — just rename it.
    try {
      await saved[0].handle.move(s.filename);
      lastFileHandle = saved[0].handle;
      endJournal('done', { elapsed: duration });
      result = { filename: s.filename, fileSize: saved[0].bytes, merged: true };
    } catch (err) {
      result = await joinOrKeep(s, saved, duration, err);
    }
  } else {
    result = await joinOrKeep(s, saved, duration);
  }
  result.duration = duration;
  result.partsLost = lost.length;
  return result;
}

async function joinOrKeep(s, saved, duration, priorErr) {
  if (priorErr) logEvent('warn', 'rename of single part failed, joining instead', { error: describeError(priorErr) });
  const total = saved.reduce((n, p) => n + p.bytes, 0);
  logEvent('info', `joining ${saved.length} parts`, { mb: Math.round(total / 1048576) });
  const t0 = Date.now();
  try {
    const { handle, bytes } = await joinParts(s.dir, saved, s.filename, s.initBytes, s.onFinalizeProgress);
    lastFileHandle = handle;
    await removeParts(s.dir, s.parts.filter(p => p.state !== 'open'));
    logEvent('info', 'join complete', { mb: Math.round(bytes / 1048576), seconds: Math.round((Date.now() - t0) / 1000) });
    endJournal('done', { elapsed: duration });
    return { filename: s.filename, fileSize: bytes, merged: true, parts: saved.length };
  } catch (err) {
    const over4GB = total >= 4 * 1024 ** 3;
    logEvent('error', 'join failed — parts kept on disk', { error: describeError(err), mb: Math.round(total / 1048576) });
    endJournal('needs-join', { elapsed: duration, joinError: describeError(err) });
    lastFileHandle = saved[0].handle;
    const hint = over4GB
      ? ' The joined file would be over 4 GB — if the save drive is formatted FAT32 it cannot hold files that large (reformat as exFAT or APFS).'
      : '';
    return {
      filename: s.filename,
      fileSize: total,
      merged: false,
      parts: saved.length,
      partNames: saved.map(p => p.name),
      error: new Error(`${describeError(err)}.${hint}`),
    };
  }
}

// --- Public API ---

export async function startRecording(stream, directoryHandle, filename, bitrate, format, {
  onTick, onStop, onError, onWarning, onFinalizeProgress,
}) {
  if (session || finalizing) throw new Error('The previous recording is still saving. Try again in a moment.');

  const mimeType = selectMimeType(format);
  const container = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const s = {
    dir: directoryHandle,
    filename,
    container,
    splitter: createSplitter(container),
    parts: [],
    partIndex: 0,
    writable: null,
    partStartedAt: 0,
    initChunks: [],
    initBytes: 0,
    receivedBytes: 0,
    processedBytes: 0,
    writtenBytes: 0,
    droppedBytes: 0,
    errorCount: 0,
    writeFailures: 0,
    skipUntilCut: false,
    queue: Promise.resolve(),
    startTime: 0,
    lastDataAt: 0,
    stallWarned: false,
    backlogWarned: false,
    fatal: null,
    onWarning,
    onFinalizeProgress,
    recorder: null,
    timer: null,
  };

  beginJournal({
    filename, container, mimeType, bitrate,
    dirName: directoryHandle.name,
    partSeconds: config.partSeconds,
  });

  try {
    await openPart(s);
  } catch (err) {
    endJournal('failed', { error: describeError(err) });
    throw err;
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrate,
    videoKeyFrameIntervalDuration: config.keyframeIntervalMs,
  });
  s.recorder = recorder;
  session = s;
  lastFileHandle = null;

  const fail = (err) => {
    if (s.fatal) return;
    s.fatal = err;
    logEvent('error', 'recording stopped by an unrecoverable error', { error: describeError(err) });
    if (recorder.state !== 'inactive') recorder.stop();
  };

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    s.lastDataAt = Date.now();
    s.receivedBytes += event.data.size;
    const blob = event.data;
    // Serialize: each chunk's arrayBuffer() + writes finish before the next.
    s.queue = s.queue.then(() => (s.fatal ? null : processChunk(s, blob))).catch(fail);
  };

  recorder.onerror = (event) => {
    const err = event.error || new Error('MediaRecorder error');
    s.errorCount++;
    logEvent('error', 'MediaRecorder error', { error: describeError(err) });
    fail(err);
  };

  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      logEvent('warn', `${track.kind} track ended`, { label: track.label });
    });
  }

  const onVisibility = () => logEvent('info', `tab ${document.visibilityState}`);
  document.addEventListener('visibilitychange', onVisibility);

  recorder.onstop = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    s.queue.catch(() => {}).then(() => finalize(s)).then((result) => {
      session = null;
      finalizing = false;
      // Something was saved: hand it to onStop so the clip (and the
      // metadata typed during the take) lands in the library. `stopError`
      // says the take ended early; `error` says the join failed.
      if (result.filename) {
        if (s.fatal) result.stopError = s.fatal;
        onStop?.(result);
      } else {
        onError?.(s.fatal || result.error, result);
      }
    }).catch((err) => {
      session = null;
      finalizing = false;
      logEvent('error', 'finalize crashed', { error: describeError(err) });
      onError?.(err, {});
    });
  };

  s.startTime = Date.now();
  s.lastDataAt = Date.now();
  recorder.start(1000);
  logEvent('info', 'recording started', { filename, mimeType: recorder.mimeType, bitrate, partSeconds: config.partSeconds });

  let lastBeat = 0;
  s.timer = setInterval(() => {
    const elapsed = getElapsed();
    const backlog = s.receivedBytes - s.processedBytes;
    onTick?.({ elapsed, bytes: s.writtenBytes, part: s.partIndex + 1, backlog, errors: s.errorCount });

    const silentFor = Date.now() - s.lastDataAt;
    if (silentFor > config.stallWarnMs && !s.stallWarned) {
      s.stallWarned = true;
      logEvent('warn', 'no data from the encoder', { seconds: Math.round(silentFor / 1000) });
      onWarning?.(`The recorder hasn't produced any video for ${Math.round(silentFor / 1000)}s. Check the capture card.`);
    } else if (silentFor < config.stallWarnMs && s.stallWarned) {
      s.stallWarned = false;
      logEvent('info', 'encoder data resumed');
    }
    if (backlog > config.backlogWarnBytes && !s.backlogWarned) {
      s.backlogWarned = true;
      logEvent('warn', 'disk is falling behind the encoder', { backlogMB: Math.round(backlog / 1048576) });
      onWarning?.(`The save drive is falling behind (${Math.round(backlog / 1048576)} MB waiting to be written).`);
    } else if (backlog < config.backlogWarnBytes / 4) {
      s.backlogWarned = false;
    }

    if (Date.now() - lastBeat >= config.heartbeatMs) {
      lastBeat = Date.now();
      heartbeat({ bytes: s.writtenBytes, elapsed, backlogBytes: backlog });
    }
  }, 500);
}

export function stopRecording() {
  if (session && session.recorder.state !== 'inactive') {
    logEvent('info', 'stop requested', { elapsed: getElapsed() });
    finalizing = true;
    session.recorder.stop();
  }
}

export function formatTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// 4-char hex random suffix injected into every filename. Matt copy-pastes
// the same title across many recordings ("1997, B&B local Austin" x20),
// and pickUniqueFilename DID add _2/_3/etc. on filename collisions, but
// the timestamp portion alone (HHMM precision) made same-minute recordings
// look almost-identical at a glance — and on disk inspection it was hard
// to tell which sidecar belonged to which clip. The hex makes uniqueness
// VISUALLY obvious so the user can always tell two same-titled recordings
// apart in their save folder.
function randHex4() {
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
}

export function generateFilename(title, nameFormat, format) {
  const ext = format === 'webm' ? 'webm' : 'mp4';
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  const hex = randHex4();

  if (nameFormat === 'timestamp' || !title.trim()) {
    return `VHS_Capture_${date}_${time}_${hex}.${ext}`;
  }

  const sanitized = title.trim().replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_');
  return `${sanitized}_${date}_${time}_${hex}.${ext}`;
}
