// audio-chain — Web Audio graph that boosts and cleans VHS line-in audio
// before MediaRecorder writes it to disk.
//
// Why this exists: VHS audio is captured at low reference levels and
// usually carries 60Hz hum and tape hiss. Sent straight through, Matt's
// recordings land noticeably quieter than other YouTube content and
// YouTube's auto-leveler doesn't turn them up (it only turns loud
// uploads down). This chain fixes the loudness side at capture time so
// the on-disk file is already usable.
//
// Graph:
//   sourceTrack → MediaStreamSource
//               → BiquadFilter(highpass, 80Hz, Q=0.7)
//               → DynamicsCompressor(thresh=-30, ratio=6, attack=3ms, release=200ms)
//               → GainNode(+10dB)
//               → MediaStreamDestination → newAudioTrack
//
// The returned stream contains the ORIGINAL video track (passed through
// unchanged) and the PROCESSED audio track. MediaRecorder doesn't know
// the difference.

const HIGHPASS_HZ = 80;
const HIGHPASS_Q = 0.7;
const COMPRESSOR_THRESHOLD = -30;
const COMPRESSOR_KNEE = 12;
const COMPRESSOR_RATIO = 6;
const COMPRESSOR_ATTACK = 0.003;
const COMPRESSOR_RELEASE = 0.2;
const MAKEUP_GAIN_DB = 10;

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Build a processed MediaStream from a raw capture stream.
 *
 * @param {MediaStream} inputStream - Stream from getUserMedia. Must
 *   contain at least one audio track. May contain a video track,
 *   which is forwarded unchanged.
 * @returns {{ stream: MediaStream, dispose: () => void }}
 *   - stream: the new MediaStream to hand to MediaRecorder
 *   - dispose: call when the recording is done — closes the
 *     AudioContext and stops the processed audio track. Idempotent.
 *
 * Throws if inputStream has no audio track.
 */
export function buildProcessedStream(inputStream) {
  const audioTracks = inputStream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error('buildProcessedStream: input stream has no audio track');
  }

  const ctx = new AudioContext();

  // Source — wrap just the audio side of the input stream.
  const audioOnly = new MediaStream(audioTracks);
  const source = ctx.createMediaStreamSource(audioOnly);

  // Highpass — defensive cut so the +10dB boost doesn't amplify hum.
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = HIGHPASS_HZ;
  highpass.Q.value = HIGHPASS_Q;

  // Compressor — lifts quiet dialog toward the ceiling so the makeup
  // gain doesn't just amplify silence-and-shouts.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR_THRESHOLD;
  compressor.knee.value = COMPRESSOR_KNEE;
  compressor.ratio.value = COMPRESSOR_RATIO;
  compressor.attack.value = COMPRESSOR_ATTACK;
  compressor.release.value = COMPRESSOR_RELEASE;

  // Makeup gain — the headline +10dB.
  const makeup = ctx.createGain();
  makeup.gain.value = dbToGain(MAKEUP_GAIN_DB);

  // Destination — produces a MediaStream we can use as the processed
  // audio track.
  const destination = ctx.createMediaStreamDestination();

  source.connect(highpass);
  highpass.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(destination);

  // Combine: original video tracks (untouched) + processed audio track.
  const processedTrack = destination.stream.getAudioTracks()[0];
  const out = new MediaStream([
    ...inputStream.getVideoTracks(),
    processedTrack,
  ]);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { processedTrack.stop(); } catch {}
    try { ctx.close(); } catch {}
  };

  return { stream: out, dispose };
}
