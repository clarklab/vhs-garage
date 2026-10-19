// Crash-safe recording pipeline.
//
// Two failure modes shaped this file:
//
// 1. Chrome's FileSystemWritableFileStream keeps everything in a hidden
//    .crswap file until close(), so one long writable lost the WHOLE take
//    when the tab crashed. The output is therefore written as part files
//    (`name.part001.mp4`, …), each closed — committed to disk — every
//    partSeconds. A crash costs at most the part in progress, and the
//    journal (rec-journal.js) tells the next page load which parts to join.
//
// 2. A single MediaRecorder crashes the tab ("Aw, Snap! Error code: 5")
//    after emitting ~4 GB — Matt hit it at exactly 4.00 GB, 1:51 into a
//    take. So the recorder hands off to a fresh MediaRecorder on the same
//    stream every recorderMaxBytes. The new recorder's header is dropped
//    and its timestamps shifted to continue the timeline (retime.js), so
//    the take stays ONE continuous file. If the new recorder's codec setup
//    ever differs (capture card switched resolution…), it starts a second
//    output file instead of corrupting the first.
//
// On a clean stop each output's parts are joined back into one file (plain
// byte concatenation — see segmenter.js) and the part files are removed.
// If the join fails (disk full, 4 GB limit on a FAT32 drive…) the parts
// stay put and the session is left as 'needs-join'.

import { createSplitter } from './segmenter.js';
import { createRetimer, parseInit } from './retime.js';
import {
  beginJournal, updateJournal, heartbeat, logEvent, setPart, endJournal,
} from './rec-journal.js';

const config = {
  partSeconds: 10 * 60,
  partMaxBytes: 1024 * 1024 * 1024,
  // Hand off to a new MediaRecorder well before Chrome's ~4 GB crash.
  recorderMaxBytes: 3 * 1024 * 1024 * 1024,
  // Regular keyframes keep Chrome's MP4 muxer emitting a fragment every
  // couple of seconds instead of holding video in memory between sparse
  // keyframes — and give the splitter frequent places to cut.
  keyframeIntervalMs: 2000,
  stallWarnMs: 15000,
  backlogWarnBytes: 64 * 1024 * 1024,
  heartbeatMs: 5000,
};

// Tests and the console can shrink parts / recorder spans to exercise
// rotation quickly.
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
  return !!session && !session.stopping && session.seg.rec.state === 'recording';
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

// Second, third… output of one take (only when the codec setup changed
// mid-recording): `name_cont2.mp4`.
function continuationFilename(filename, n) {
  const m = filename.match(/^(.*?)(\.[^.]+)?$/);
  return `${m[1]}_cont${n}${m[2] || ''}`;
}

function describeError(err) {
  return `${err?.name || 'Error'}: ${err?.message || err}`;
}

const currentOutput = (s) => s.outputs[s.outputs.length - 1];

// --- Part management ---

async function openPart(s) {
  const out = currentOutput(s);
  const index = s.parts.length;
  const name = partFilename(out.filename, out.partCount++);
  const handle = await s.dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  const outputIndex = s.outputs.length - 1;
  s.parts.push({ name, handle, bytes: 0, state: 'open', output: outputIndex, initBytes: out.initBytes });
  s.partIndex = index;
  s.writable = writable;
  s.partStartedAt = Date.now();
  setPart(index, { name, bytes: 0, state: 'open', output: outputIndex, initBytes: out.initBytes });
  for (const chunk of out.initChunks) {
    await writable.write(chunk);
    s.parts[index].bytes += chunk.length;
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
  if (!part || part.bytes <= part.initBytes) return false;
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
  if (s.seg.splitter.failed || s.writeFailures > 3) {
    throw err;
  }
  s.onWarning?.(`Disk write failed (${describeError(err)}). Starting a new part file and continuing.`);
  await openPart(s);
  s.skipUntilCut = true;
}

async function writeUnit(s, unit) {
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

// --- Recorder segments (one MediaRecorder each) ---

// A segment's header has fully arrived (its first media unit is next).
// Decide whether it continues the current output or starts a new one.
async function resolveSegment(s, seg) {
  const initBytes = seg.initChunks.reduce((n, c) => n + c.length, 0);
  const init = new Uint8Array(initBytes);
  let o = 0;
  for (const c of seg.initChunks) { init.set(c, o); o += c.length; }
  let info = null;
  try {
    info = parseInit(s.container, init);
  } catch (err) {
    logEvent('warn', 'could not parse recorder header; timeline stitching disabled', { error: describeError(err) });
  }

  const out = currentOutput(s);
  if (seg.index === 0) {
    Object.assign(out, { initChunks: seg.initChunks, initBytes, info });
    // Part 1 was opened before any data arrived; give it the header now.
    for (const chunk of seg.initChunks) await writeUnit(s, { bytes: chunk, init: true, cut: false });
    s.parts[s.partIndex].initBytes = initBytes;
    setPart(s.partIndex, { initBytes });
    updateJournal({ initBytes });
  } else if (info && out.info && info.signature === out.info.signature) {
    seg.offsetSec = s.timelineEnd;
    logEvent('info', `recorder ${seg.index + 1} continues the same file`, { atSeconds: Math.round(seg.offsetSec * 100) / 100 });
  } else {
    // Codec setup changed — this recorder's media can't share the file.
    await closePart(s);
    const filename = continuationFilename(s.outputs[0].filename, s.outputs.length + 1);
    s.outputs.push({ filename, initChunks: seg.initChunks, initBytes, info, partCount: 0 });
    updateJournal({ outputs: s.outputs.map(x => ({ filename: x.filename })) });
    seg.offsetSec = 0;
    s.sequence = 0;
    logEvent('warn', `recorder ${seg.index + 1} has a different codec setup — continuing in a new file`, { filename });
    s.onWarning?.(`The video format changed mid-recording, so the rest of this take is being saved as a second clip (${filename}).`);
    await openPart(s);
  }
  const outInfo = currentOutput(s).info;
  seg.retimer = outInfo ? createRetimer(s.container, outInfo, seg.offsetSec, s.sequence) : null;
  seg.resolved = true;
}

async function processSegmentChunk(s, seg, blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const wasSplitting = !seg.splitter.failed;
  const units = seg.splitter.push(bytes);
  if (wasSplitting && seg.splitter.failed) {
    logEvent('warn', 'stream splitter gave up; continuing in a single part', { reason: seg.splitter.failReason });
  }
  for (let unit of units) {
    if (unit.init && !seg.resolved) {
      seg.initChunks.push(unit.bytes);
      continue;
    }
    if (!seg.resolved) await resolveSegment(s, seg);
    if (seg.retimer) {
      try {
        unit = seg.retimer.process(unit);
      } catch (err) {
        logEvent('error', 'could not retime a fragment; writing it unchanged', { error: describeError(err) });
        seg.retimer = null;
      }
    }
    await writeUnit(s, unit);
  }
  s.processedBytes += blob.size;
}

async function flushSegment(s, seg) {
  if (!seg.resolved && seg.initChunks.length) await resolveSegment(s, seg);
  for (const unit of seg.splitter.flush()) await writeUnit(s, unit);
  if (seg.retimer) {
    s.timelineEnd = seg.retimer.endSec();
    s.sequence = seg.retimer.sequence();
  }
}

// Frame size the video track is delivering right now (0×0 if unknown).
function videoSize(stream) {
  const st = stream.getVideoTracks()[0]?.getSettings?.() || {};
  return `${st.width || 0}x${st.height || 0}`;
}

function startSegment(s, prevDone) {
  const index = s.segments.length;
  s.segSize = videoSize(s.stream);
  const rec = new MediaRecorder(s.stream, {
    mimeType: s.mimeType,
    videoBitsPerSecond: s.bitrate,
    videoKeyFrameIntervalDuration: config.keyframeIntervalMs,
  });
  const seg = {
    index, rec,
    splitter: createSplitter(s.container),
    initChunks: [],
    resolved: false,
    retimer: null,
    offsetSec: 0,
    bytes: 0,
    final: false,
    // Each segment's chunks are processed strictly after the previous
    // segment has been fully written and flushed.
    queue: prevDone,
  };
  let resolveDone;
  seg.done = new Promise((r) => { resolveDone = r; });
  s.segments.push(seg);

  rec.ondataavailable = (event) => {
    if (!event.data.size) return;
    s.lastDataAt = Date.now();
    s.receivedBytes += event.data.size;
    seg.bytes += event.data.size;
    const blob = event.data;
    seg.queue = seg.queue.then(() => (s.fatal ? null : processSegmentChunk(s, seg, blob))).catch(s.fail);
  };
  rec.onerror = (event) => {
    const err = event.error || new Error('MediaRecorder error');
    s.errorCount++;
    logEvent('error', `MediaRecorder error (recorder ${index + 1})`, { error: describeError(err) });
    s.fail(err);
  };
  rec.onstop = () => {
    seg.queue = seg.queue.then(() => (s.fatal ? null : flushSegment(s, seg))).catch(s.fail);
    seg.queue.catch(() => {}).then(resolveDone);
    if (seg.final) s.onFinalSegmentStopped(seg);
  };
  rec.start(1000);
  return seg;
}

function rotateRecorder(s) {
  const old = s.seg;
  logEvent('info', `handing off to recorder ${old.index + 2}`, { recorderMB: Math.round(old.bytes / 1048576) });
  // Start the new recorder before stopping the old one so no frame falls
  // between them; both calls run in the same task.
  s.seg = startSegment(s, old.done);
  old.rec.stop();
  updateJournal({ recorders: s.segments.length });
}

// --- Joining ---

const JOIN_SLICE_BYTES = 64 * 1024 * 1024;

// Join part files into one. `parts` is [{ name, initBytes? }] in order;
// every part begins with its header (`initBytes`, falling back to the
// argument), which is written once. Exported for the recovery flow in
// app.js. Leaves the parts on disk — the caller removes them once it's happy.
export async function joinParts(dir, parts, finalName, initBytes, onProgress) {
  const files = [];
  for (const p of parts) {
    const handle = await dir.getFileHandle(p.name);
    files.push({ file: await handle.getFile(), init: p.initBytes ?? initBytes ?? 0 });
  }
  // Only the parts that carry media past the header are worth joining.
  const usable = files.filter(f => f.file.size > f.init);
  if (!usable.length) throw new Error('no saved parts contain video');

  const slices = usable.map((f, i) => (i === 0 || !f.init ? f.file : f.file.slice(f.init)));
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
  await closePart(s);
  updateJournal({ state: 'finalizing', elapsed: duration, bytes: s.writtenBytes });

  const lost = s.parts.filter(p => p.state === 'failed');
  if (lost.length) {
    logEvent('warn', `${lost.length} part(s) were lost`, { parts: lost.map(p => p.name) });
  }

  const results = [];
  for (let i = 0; i < s.outputs.length; i++) {
    const saved = s.parts.filter(p => p.output === i && p.state === 'closed');
    if (saved.length) results.push(await finalizeOutput(s, s.outputs[i].filename, saved, i));
  }

  let result;
  if (!results.length) {
    endJournal('failed', { elapsed: duration });
    result = { error: new Error('No part of the recording could be saved to disk. Check the save folder and free space.') };
  } else {
    const failed = results.find(r => !r.merged);
    endJournal(failed ? 'needs-join' : 'done', { elapsed: duration, joinError: failed?.error ? describeError(failed.error) : undefined });
    result = { ...results[0], extraFiles: results.slice(1), merged: !failed, error: failed?.error };
    if (results.length > 1) result.parts = results.reduce((n, r) => n + (r.parts || 1), 0);
  }
  result.duration = duration;
  result.partsLost = lost.length;
  return result;
}

async function finalizeOutput(s, filename, saved, outputIndex) {
  const all = s.parts.filter(p => p.output === outputIndex && p.state !== 'open');
  if (saved.length === 1 && all.length === 1) {
    // Short take: a single part — just rename it.
    try {
      await saved[0].handle.move(filename);
      if (outputIndex === 0) lastFileHandle = saved[0].handle;
      return { filename, fileSize: saved[0].bytes, merged: true, parts: 1 };
    } catch (err) {
      logEvent('warn', 'rename of single part failed, joining instead', { error: describeError(err) });
    }
  }
  const total = saved.reduce((n, p) => n + p.bytes, 0);
  logEvent('info', `joining ${saved.length} parts`, { filename, mb: Math.round(total / 1048576) });
  const t0 = Date.now();
  try {
    const { handle, bytes } = await joinParts(s.dir, saved, filename, 0, s.onFinalizeProgress);
    if (outputIndex === 0) lastFileHandle = handle;
    await removeParts(s.dir, all);
    logEvent('info', 'join complete', { filename, mb: Math.round(bytes / 1048576), seconds: Math.round((Date.now() - t0) / 1000) });
    return { filename, fileSize: bytes, merged: true, parts: saved.length };
  } catch (err) {
    const over4GB = total >= 4 * 1024 ** 3;
    logEvent('error', 'join failed — parts kept on disk', { filename, error: describeError(err), mb: Math.round(total / 1048576) });
    if (outputIndex === 0) lastFileHandle = saved[0].handle;
    const hint = over4GB
      ? ' The joined file would be over 4 GB — if the save drive is formatted FAT32 it cannot hold files that large (reformat as exFAT or APFS).'
      : '';
    return {
      filename,
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
    stream, mimeType, bitrate, container,
    outputs: [{ filename, initChunks: [], initBytes: 0, info: null, partCount: 0 }],
    segments: [],
    seg: null,
    timelineEnd: 0,
    sequence: 0,
    parts: [],
    partIndex: 0,
    writable: null,
    partStartedAt: 0,
    receivedBytes: 0,
    processedBytes: 0,
    writtenBytes: 0,
    droppedBytes: 0,
    errorCount: 0,
    writeFailures: 0,
    skipUntilCut: false,
    startTime: 0,
    lastDataAt: 0,
    stallWarned: false,
    backlogWarned: false,
    stopping: false,
    fatal: null,
    onWarning,
    onFinalizeProgress,
    timer: null,
  };

  beginJournal({
    filename, container, mimeType, bitrate,
    dirName: directoryHandle.name,
    partSeconds: config.partSeconds,
    outputs: [{ filename }],
  });

  try {
    await openPart(s);
  } catch (err) {
    endJournal('failed', { error: describeError(err) });
    throw err;
  }

  session = s;
  lastFileHandle = null;

  s.fail = (err) => {
    if (s.fatal) return;
    s.fatal = err;
    logEvent('error', 'recording stopped by an unrecoverable error', { error: describeError(err) });
    stopCurrent(s);
  };

  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      logEvent('warn', `${track.kind} track ended`, { label: track.label });
    });
  }

  const onVisibility = () => logEvent('info', `tab ${document.visibilityState}`);
  document.addEventListener('visibilitychange', onVisibility);

  // Can be reached twice when a recorder errors (its state flips to
  // inactive before its stop event fires) — finalize exactly once.
  let finalizeStarted = false;
  s.onFinalSegmentStopped = (seg) => {
    if (finalizeStarted) return;
    finalizeStarted = true;
    document.removeEventListener('visibilitychange', onVisibility);
    seg.done.then(() => finalize(s)).then((result) => {
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
  s.seg = startSegment(s, Promise.resolve());
  logEvent('info', 'recording started', {
    filename, mimeType: s.seg.rec.mimeType, bitrate,
    partSeconds: config.partSeconds, recorderMaxMB: Math.round(config.recorderMaxBytes / 1048576),
  });

  let lastBeat = 0;
  s.timer = setInterval(() => {
    const elapsed = getElapsed();
    const backlog = s.receivedBytes - s.processedBytes;
    onTick?.({ elapsed, bytes: s.writtenBytes, part: s.partIndex + 1, backlog, errors: s.errorCount });

    if (!s.stopping && !s.fatal && s.seg.rec.state === 'recording') {
      // A recorder keeps tagging frames with the size it started at, so a
      // mid-take format change (capture card renegotiating) gets a fresh
      // recorder right away — it lands in its own file via resolveSegment.
      const size = videoSize(s.stream);
      if (size !== s.segSize && s.seg.bytes > 0) {
        logEvent('warn', 'video frame size changed', { from: s.segSize, to: size });
        rotateRecorder(s);
      } else if (s.seg.bytes >= config.recorderMaxBytes) {
        rotateRecorder(s);
      }
    }

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

function stopCurrent(s) {
  if (s.stopping) return;
  s.stopping = true;
  finalizing = true;
  s.seg.final = true;
  if (s.seg.rec.state !== 'inactive') s.seg.rec.stop();
  else s.onFinalSegmentStopped(s.seg);
}

export function stopRecording() {
  if (session && !session.stopping) {
    logEvent('info', 'stop requested', { elapsed: getElapsed() });
    stopCurrent(session);
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
