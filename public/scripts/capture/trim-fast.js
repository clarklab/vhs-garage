// Fast, frame-exact Trim.
//
// The original Trim re-records the kept range by playing it in real time, so
// keeping 40 minutes of an hour-long tape takes 40+ minutes — Matt saw 45 on
// an older MacBook — and the copy loses a generation of quality. This copies
// the recording's compressed packets instead (through Mediabunny, vendored
// under /vendor/mediabunny, MPL-2.0), so a trim takes about as long as reading
// the file from disk, and nothing is re-encoded.
//
// The one hard part is the START. Video is stored as a full picture (a key
// frame) every couple of seconds — the recorder asks for one every 2s — with
// only changes in between, so a copied clip has to begin on a key frame.
// Trims still land on the exact frame the user picked:
//
//   MP4  — copy from the key frame before IN and give those lead-in frames
//          negative timestamps. The muxer writes an MP4 edit list, which
//          tells players to start presenting at IN. Nothing is re-encoded.
//   WebM — Matroska has no edit lists, so re-encode just the frames from IN
//          up to the next key frame (at most ~2s) and copy everything after
//          it. A VP8/VP9 key frame carries everything a decoder needs, so the
//          two halves join cleanly.
//
// The END needs no special handling: frames before OUT only depend on earlier
// frames, so copying stops at OUT exactly.
//
// Any failure (codec this doesn't know, odd file) throws; the caller falls
// back to the real-time path, which handles anything the browser can play.
import {
  Input, BlobSource, ALL_FORMATS, EncodedPacketSink, VideoSampleSink, EncodedPacket,
  Output, Mp4OutputFormat, WebMOutputFormat, StreamTarget,
  EncodedVideoPacketSource, EncodedAudioPacketSource,
} from '/vendor/mediabunny/mediabunny.min.mjs';

// Half a frame at 60fps: timestamps closer than this are the same instant.
const EPS = 0.008;
// Check key frames against the bitstream, not just the container's flags.
const KEYS = { verifyKeyPackets: true };

// file: the source File. writable: a FileSystemWritableFileStream for the
// output. It is committed (closed) only after a complete trim; on any failure
// it is aborted, which leaves the file on disk exactly as it was. That matters
// for "replace", where the writable points at the source itself: Mediabunny
// closes its stream even when canceled, and closing a FileSystemWritableFile
// Stream is what saves it, so Mediabunny writes through a wrapper whose close
// does nothing and this function makes the call. Returns { ext, duration }.
export async function fastTrim({ file, inSec, outSec, writable, onProgress, signal }) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const writer = writable.getWriter();
  const guarded = new WritableStream({ write: (chunk) => writer.write(chunk) });
  let output = null;
  try {
    const mime = await input.getMimeType();
    const isMp4 = mime.includes('mp4');
    if (!isMp4 && !mime.includes('webm')) throw new Error(`Fast trim does not handle ${mime}`);

    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('No video track');
    const videoSink = new EncodedPacketSink(video);
    const startKey = (await videoSink.getKeyPacket(inSec, KEYS)) || (await videoSink.getFirstPacket(KEYS));
    if (!startKey) throw new Error('No video packets');
    inSec = await frameStartAt(videoSink, startKey, inSec);
    const audio = await input.getPrimaryAudioTrack();
    const videoConfig = await video.getDecoderConfig();
    const audioConfig = audio ? await audio.getDecoderConfig() : null;
    if (!videoConfig || (audio && !audioConfig)) throw new Error('Unknown codec setup');

    output = new Output({
      format: isMp4 ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(guarded, { chunked: true }),
    });
    const videoOut = new EncodedVideoPacketSource(video.codec);
    output.addVideoTrack(videoOut, { rotation: video.rotation });
    const audioOut = audio ? new EncodedAudioPacketSource(audio.codec) : null;
    if (audioOut) output.addAudioTrack(audioOut);
    await output.start();

    const duration = outSec - inSec;
    const videoPackets = videoStream(video, videoSink, startKey, videoConfig, inSec, outSec, isMp4, file, signal);
    const audioPackets = audio ? audioStream(audio, inSec, outSec, isMp4) : null;

    // Interleave by time. Adding all of one track first would make the muxer
    // hold the whole other track in memory — gigabytes on a long tape.
    let v = await videoPackets.next();
    let a = audioPackets ? await audioPackets.next() : { done: true };
    let first = { video: true, audio: true };
    let lastReport = 0;
    while (!v.done || !a.done) {
      if (signal?.aborted) throw new DOMException('Trim canceled', 'AbortError');
      const takeVideo = !v.done && (a.done || v.value.timestamp <= a.value.timestamp);
      if (takeVideo) {
        await videoOut.add(v.value, first.video ? { decoderConfig: videoConfig } : undefined);
        first.video = false;
        const done = Math.min(duration, Math.max(0, v.value.timestamp));
        if (done - lastReport >= 0.5) { lastReport = done; onProgress?.(done, duration); }
        v = await videoPackets.next();
      } else {
        await audioOut.add(a.value, first.audio ? { decoderConfig: audioConfig } : undefined);
        first.audio = false;
        a = await audioPackets.next();
      }
    }
    if (first.video) throw new Error('Trim range holds no video');

    await output.finalize();
    await writer.close();
    onProgress?.(duration, duration);
    return { ext: isMp4 ? '.mp4' : '.webm', duration };
  } catch (err) {
    if (output) await output.cancel().catch(() => {});
    await writer.abort(err).catch(() => {});
    throw err;
  } finally {
    try { input.dispose(); } catch {}
  }
}

// Shift a packet so IN is 0. MP4 keeps lead-in packets at negative times for
// the edit list to hide; WebM can't store negative times, and anything there
// is at most a few milliseconds early, so it is pinned to 0.
const shifted = (p, inSec, isMp4) => p.clone({
  timestamp: isMp4 ? p.timestamp - inSec : Math.max(0, p.timestamp - inSec),
});

// Where the frame on screen at IN starts. The clip starts there: that is the
// frame the user was looking at when they set the handle, and players skip a
// frame that begins even a few milliseconds before the clip does, so starting
// at IN itself would open the clip one frame late.
//
// Found by scanning forward from the key frame (at most a couple of seconds of
// packet headers) rather than with sink.getPacket(): after a getPacket() call,
// Mediabunny's WebM reader stops finding key frames on that track.
async function frameStartAt(sink, startKey, inSec) {
  let start = startKey.timestamp;
  for await (const p of sink.packets(startKey, undefined, { metadataOnly: true })) {
    // Exactly as a player decides: the frame starting at or before IN, even
    // if the next one starts a millisecond after it.
    if (p.timestamp <= inSec + 1e-6) start = Math.max(start, p.timestamp);
    else if (p.timestamp > inSec + 0.5) break; // past any reordering
  }
  return start;
}

// Video packets for [inSec, outSec), timestamps shifted so IN is 0.
async function* videoStream(track, sink, startKey, config, inSec, outSec, isMp4, file, signal) {
  let copyFrom = startKey;
  if (!isMp4 && startKey.timestamp < inSec - EPS) {
    // WebM lead-in: re-encode IN up to the next key frame.
    const nextKey = await sink.getNextKeyPacket(startKey, KEYS);
    const until = Math.min(nextKey ? nextKey.timestamp : Infinity, outSec);
    const bitrate = Math.round((file.size * 8) / Math.max(1, await track.computeDuration()));
    for (const p of await encodeLeadIn(track, config, startKey.timestamp, inSec, until, bitrate, signal)) {
      yield shifted(p, inSec, isMp4);
    }
    if (!nextKey || nextKey.timestamp >= outSec - EPS) return;
    copyFrom = nextKey;
  }

  for await (const p of sink.packets(copyFrom)) {
    if (p.timestamp >= outSec - EPS) {
      // MediaRecorder never reorders frames, but if a file does, a delta
      // frame after OUT can still precede one before it. Stop at the next
      // key frame, which nothing earlier depends on.
      if (p.type === 'key') return;
      continue;
    }
    yield shifted(p, inSec, isMp4);
  }
}

// Audio packets for [inSec, outSec), timestamps shifted so IN is 0. Every
// audio packet stands alone. MP4 keeps the packet that straddles IN (the edit
// list trims it); WebM starts at the first packet at or after IN, which is at
// most one packet (~20ms) late and saves a negative timestamp Matroska can't
// hold.
async function* audioStream(track, inSec, outSec, isMp4) {
  const sink = new EncodedPacketSink(track);
  let start = (await sink.getPacket(inSec)) || (await sink.getFirstPacket());
  if (start && !isMp4 && start.timestamp < inSec - EPS) start = await sink.getNextPacket(start);
  if (!start) return;
  for await (const p of sink.packets(start)) {
    if (p.timestamp >= outSec - EPS) return;
    yield shifted(p, inSec, isMp4);
  }
}

// Decode from the key frame before IN and re-encode the frames from IN up to
// `until` with the source's own codec. Returns packets with source-timeline
// timestamps. At most a couple of seconds of video.
//
// The first frame is the one ON SCREEN at IN — usually one that started a few
// milliseconds earlier — moved to start exactly at IN and encoded as a key
// frame. That is the frame the user was looking at when they set the handle,
// and it keeps the clip from starting at a negative time, which WebM can't
// store.
async function encodeLeadIn(track, config, keyTime, inSec, until, bitrate, signal) {
  const packets = [];
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk) => packets.push(EncodedPacket.fromEncodedChunk(chunk)),
    error: (e) => { failure = e; },
  });
  let started = false;
  const encode = (sample, timestamp) => {
    if (!started) {
      encoder.configure({
        codec: config.codec,
        width: sample.codedWidth,
        height: sample.codedHeight,
        bitrate: Math.max(500_000, bitrate),
      });
    }
    const decoded = sample.toVideoFrame();
    const frame = timestamp == null ? decoded : new VideoFrame(decoded, { timestamp: Math.round(timestamp * 1e6) });
    encoder.encode(frame, { keyFrame: !started });
    if (frame !== decoded) frame.close();
    decoded.close();
    started = true;
  };

  const sink = new VideoSampleSink(track);
  let onScreen = null; // latest frame starting at or before IN
  try {
    for await (const sample of sink.samples(keyTime, until)) {
      if (signal?.aborted) { sample.close(); throw new DOMException('Trim canceled', 'AbortError'); }
      if (sample.timestamp <= inSec + EPS) {
        onScreen?.close();
        onScreen = sample;
        continue;
      }
      if (onScreen) { encode(onScreen, inSec); onScreen.close(); onScreen = null; }
      if (sample.timestamp < until - EPS) encode(sample);
      sample.close();
    }
    if (onScreen) { encode(onScreen, inSec); onScreen.close(); onScreen = null; }
    if (started) await encoder.flush();
  } finally {
    onScreen?.close();
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  return packets;
}
