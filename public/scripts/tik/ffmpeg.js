// The two commands that turn a file this browser can't use into one it can.
//
// Pure string building, no DOM: the editor and the Shoot page both hand the
// user a command with their own file's name already in it, because "re-encode
// it" is not help — a line you can paste is.
//
// Film titles are full of apostrophes (Ocean's Eleven) and rip names carry $
// and brackets, so quoting is single quotes with the POSIX '\'' escape rather
// than double quotes, which would leave $ and backticks for the shell to eat.

export function shellQuote(name) {
  return `'${String(name ?? '').replace(/'/g, `'\\''`)}'`;
}

function outputName(fileName, suffix) {
  const name = String(fileName || '').trim() || 'movie.mkv';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem} (${suffix}).mp4`;
}

const MAP_FIRST_STREAMS = '-map 0:v:0 -map 0:a:0';

// The picture is fine, the sound is not: AC-3, E-AC-3 and DTS are what most
// rips carry and Chrome decodes none of them.
//
// Only the audio is re-encoded — the video stream is copied, so a feature takes
// a minute or two rather than an hour.
export function ffmpegAacCommand(fileName) {
  const name = String(fileName || '').trim() || 'movie.mkv';
  return `ffmpeg -i ${shellQuote(name)} ${MAP_FIRST_STREAMS} -c:v copy -c:a aac -b:a 192k ${shellQuote(outputName(name, 'aac'))}`;
}

// Nothing about the file is usable: an AVI of Xvid or DivX, an old MPEG-4 ASP
// rip, anything where the browser can't even read the picture.
//
// This one re-encodes both streams, so it is slow — roughly as long as watching
// it, on a laptop. yuv420p and faststart are what make the result play
// everywhere rather than only in the tool that wrote it.
export function ffmpegH264Command(fileName) {
  const name = String(fileName || '').trim() || 'movie.avi';
  return `ffmpeg -i ${shellQuote(name)} ${MAP_FIRST_STREAMS} `
    + '-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart '
    + `-c:a aac -b:a 192k ${shellQuote(outputName(name, 'h264'))}`;
}

// Why a file won't open at all, said without blaming the file.
export const NO_DECODE_NOTE =
  'This browser can’t decode that video file — usually an AVI of Xvid or DivX, which Chrome has no '
  + 'decoder for even though it plays fine in VLC. Re-encoding it to H.264 in an MP4 fixes it, and '
  + 'the copy works everywhere else too.';
