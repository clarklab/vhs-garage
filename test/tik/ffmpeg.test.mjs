import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ffmpegAacCommand, ffmpegH264Command, shellQuote, NO_DECODE_NOTE,
} from '../../public/scripts/tik/ffmpeg.js';

// ---- The fix, as a command you can paste ----

test('the command re-encodes only the audio and names this film', () => {
  const cmd = ffmpegAacCommand('The Princess Bride.mkv');
  assert.match(cmd, /^ffmpeg -i /);
  assert.match(cmd, /-c:v copy/, 'the video is copied, not re-encoded');
  assert.match(cmd, /-c:a aac/);
  assert.match(cmd, /'The Princess Bride\.mkv'/);
  assert.match(cmd, /'The Princess Bride \(aac\)\.mp4'/, 'and writes beside it, never over it');
});

test('only the first video and audio streams are taken', () => {
  // An MKV's subtitle and attachment streams have no home in an MP4, and
  // ffmpeg aborts the mux rather than skipping them.
  const cmd = ffmpegAacCommand('x.mkv');
  assert.match(cmd, /-map 0:v:0/);
  assert.match(cmd, /-map 0:a:0/);
});

test('the output never overwrites the input', () => {
  const cmd = ffmpegAacCommand('movie.mp4');
  assert.match(cmd, /'movie\.mp4'.*'movie \(aac\)\.mp4'/);
});

test('an apostrophe in the title does not break the quoting', () => {
  // Ocean's Eleven, Schindler's List, Bridget Jones's Diary…
  const cmd = ffmpegAacCommand("Ocean's Eleven.mkv");
  assert.match(cmd, /'Ocean'\\''s Eleven\.mkv'/);
});

test('shell metacharacters in a filename stay literal', () => {
  // Single quotes, so $ and backticks are never expanded by the shell.
  const q = shellQuote('$HOME `whoami` "x".mkv');
  assert.equal(q, `'$HOME \`whoami\` "x".mkv'`);
  assert.equal(q.startsWith("'"), true);
  assert.equal(q.endsWith("'"), true);
});

test('a missing filename still gives a runnable example', () => {
  for (const junk of ['', null, undefined, '   ']) {
    const cmd = ffmpegAacCommand(junk);
    assert.match(cmd, /^ffmpeg -i 'movie\.mkv'/);
  }
});

test('a name with no extension is not mangled', () => {
  assert.match(ffmpegAacCommand('movie'), /'movie' .*'movie \(aac\)\.mp4'/);
  // A dotfile-looking name keeps its whole name as the stem.
  assert.match(ffmpegAacCommand('.hidden'), /'\.hidden \(aac\)\.mp4'/);
});


// ---- A file that will not open at all ----

test('an unplayable file gets a full re-encode, not a copy', () => {
  // An AVI of Xvid has nothing the browser can use: the picture has to be
  // rebuilt too, which is why this one is slow and the audio one is not.
  const cmd = ffmpegH264Command('Predator.1987.DivX.avi');
  assert.match(cmd, /-c:v libx264/);
  assert.doesNotMatch(cmd, /-c:v copy/);
  assert.match(cmd, /-c:a aac/);
  assert.match(cmd, /'Predator\.1987\.DivX \(h264\)\.mp4'/);
});

test('the re-encode produces a file that plays outside this tool too', () => {
  const cmd = ffmpegH264Command('x.avi');
  assert.match(cmd, /-pix_fmt yuv420p/, 'or QuickTime and Chrome show nothing');
  assert.match(cmd, /-movflags \+faststart/, 'metadata up front, so it opens instantly');
});

test('both commands take only the first video and audio streams', () => {
  for (const cmd of [ffmpegAacCommand('a.mkv'), ffmpegH264Command('b.avi')]) {
    assert.match(cmd, /-map 0:v:0 -map 0:a:0/);
  }
});

test('both commands quote a hostile filename the same way', () => {
  const nasty = "Ocean's Eleven $HOME `whoami`.avi";
  for (const cmd of [ffmpegAacCommand(nasty), ffmpegH264Command(nasty)]) {
    assert.match(cmd, /'Ocean'\\''s Eleven \$HOME `whoami`\.avi'/);
  }
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('a missing filename still gives a runnable example', () => {
  assert.match(ffmpegH264Command(''), /^ffmpeg -i 'movie\.avi'/);
  assert.match(ffmpegH264Command(null), /'movie \(h264\)\.mp4'/);
});

test('the note names the codec and does not blame the file', () => {
  assert.match(NO_DECODE_NOTE, /AVI|Xvid|DivX/);
  assert.match(NO_DECODE_NOTE, /VLC/, 'the file is fine; this browser is not');
});
