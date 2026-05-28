// audio-processor — wraps ffmpeg.wasm (single-threaded v0.11) for the
// heavy upload pass. Lazy-loads ffmpeg on first call so a user who
// never checks the "Clean audio" box never pays the ~28MB download.
//
// What it does: takes a recorded video file (webm or mp4), runs the
// audio track through ffmpeg's afftdn (FFT denoiser) + loudnorm
// (EBU R128 loudness normalization to YouTube's -14 LUFS target),
// re-muxes with the ORIGINAL video stream copied as-is (no re-encode,
// fast), and returns a new Blob ready for upload.
//
// Why this exists: even after the live capture chain boosts loudness,
// VHS clips often end up either (a) loud-but-hissy because the +10dB
// boost amplifies tape noise, or (b) quieter than other YouTube
// content because they weren't mastered to the platform's -14 LUFS
// target. Loudnorm matches the platform standard; afftdn knocks down
// the hiss that the live boost made more audible.
//
// Tradeoff: this is slow (single-threaded wasm + serial processing).
// Hence opt-in per batch, not default-on. UI gates this and surfaces
// progress via the toast's new 'processing' state.

// Lazy global — initialized on first processClipAudio call. Kept
// alive across calls so we don't re-download the ~28MB wasm for every
// clip in a batch.
let ffmpegInstance = null;
let loadPromise = null;

/**
 * Load the ffmpeg.wasm module. Idempotent — repeated calls share the
 * same in-flight promise / cached instance.
 *
 * @returns {Promise<FFmpeg>}
 * @throws if the script tag or wasm fetch fails.
 */
export async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    // Inject the UMD bundle via a <script> tag — that's the only
    // reliable way to load @ffmpeg/ffmpeg's 0.11 dist in the browser
    // without bundler involvement. The bundle assigns window.FFmpeg
    // on load. We host the file in public/ffmpeg/ so it's served
    // same-origin (no CORS preflight) and not from a third-party CDN.
    if (!window.FFmpeg) {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-ffmpeg-loader]');
        if (existing) {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', () => reject(new Error('ffmpeg script load failed')), { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = '/ffmpeg/ffmpeg.min.js';
        script.dataset.ffmpegLoader = '1';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('ffmpeg script load failed'));
        document.head.appendChild(script);
      });
    }

    const createFFmpeg = window.FFmpeg && window.FFmpeg.createFFmpeg;
    if (!createFFmpeg) {
      throw new Error('audio-processor: window.FFmpeg.createFFmpeg not available after script load');
    }

    const inst = createFFmpeg({
      // Point at our same-origin core files (see Task 1) instead of
      // the default unpkg CDN URL.
      corePath: '/ffmpeg/ffmpeg-core.js',
      log: false,
    });
    await inst.load();
    ffmpegInstance = inst;
    return inst;
  })().catch((e) => {
    // Reset on failure so a retry can try again.
    loadPromise = null;
    throw e;
  });

  return loadPromise;
}

/**
 * Process the audio of a video file. Video stream is copied through
 * unchanged; audio is filtered with afftdn (denoise) + loudnorm
 * (loudness match).
 *
 * @param {File|Blob} file - input video, MUST be webm or mp4.
 * @param {object} options
 * @param {(percent: number) => void} [options.onProgress] - called with
 *   integer 0-100 as ffmpeg reports its progress. Best-effort — not
 *   every ffmpeg progress line maps cleanly to a percent.
 * @returns {Promise<Blob>} processed file, same container as input.
 * @throws if loading ffmpeg fails or processing fails for any reason.
 */
export async function processClipAudio(file, { onProgress } = {}) {
  const ffmpeg = await loadFFmpeg();

  // Pick container + audio codec based on input. webm → opus, mp4 → aac.
  const isWebm = (file.type && file.type.includes('webm')) ||
                 (file.name && file.name.toLowerCase().endsWith('.webm'));
  const ext = isWebm ? 'webm' : 'mp4';
  const audioCodec = isWebm ? 'libopus' : 'aac';
  const audioBitrate = '192k';

  const inputName = `in.${ext}`;
  const outputName = `out.${ext}`;

  // Progress reporting — ffmpeg.wasm 0.11 exposes setProgress(({ratio}))
  // which fires as the filter pipeline advances. ratio is 0..1.
  if (typeof onProgress === 'function') {
    ffmpeg.setProgress(({ ratio }) => {
      if (typeof ratio === 'number' && ratio >= 0) {
        onProgress(Math.min(100, Math.max(0, Math.round(ratio * 100))));
      }
    });
  }

  try {
    // Write input file into ffmpeg's virtual FS.
    const buf = new Uint8Array(await file.arrayBuffer());
    ffmpeg.FS('writeFile', inputName, buf);

    // The filter chain. Comma-separated, applied left-to-right:
    //   afftdn=nr=12:nf=-25  — FFT noise reduction, moderate strength.
    //                          nr=12 dB reduction, nf=-25 dB noise floor.
    //                          Aggressive enough to hear, gentle enough
    //                          not to make vocals sound underwater.
    //   loudnorm=I=-14:LRA=11:TP=-1.5
    //                        — EBU R128 normalization. I=-14 LUFS is
    //                          YouTube's integrated target; LRA=11 is
    //                          a reasonable loudness range; TP=-1.5
    //                          true peak ceiling keeps a bit of
    //                          headroom below clipping.
    const filterChain = 'afftdn=nr=12:nf=-25,loudnorm=I=-14:LRA=11:TP=-1.5';

    await ffmpeg.run(
      '-i', inputName,
      '-c:v', 'copy',           // copy video stream unchanged
      '-c:a', audioCodec,       // re-encode audio (filters output PCM)
      '-b:a', audioBitrate,
      '-af', filterChain,
      outputName,
    );

    const outData = ffmpeg.FS('readFile', outputName);
    const outBlob = new Blob([outData.buffer], {
      type: isWebm ? 'video/webm' : 'video/mp4',
    });

    return outBlob;
  } finally {
    // Always clean up the virtual FS, even on error. Per-clip FS
    // entries are tiny relative to the wasm runtime, but they
    // accumulate if a batch runs many uploads.
    try { ffmpeg.FS('unlink', inputName); } catch {}
    try { ffmpeg.FS('unlink', outputName); } catch {}
    if (typeof onProgress === 'function') {
      // Clear our handler so the next call's setProgress override
      // doesn't see stale state from this one.
      try { ffmpeg.setProgress(() => {}); } catch {}
    }
  }
}
