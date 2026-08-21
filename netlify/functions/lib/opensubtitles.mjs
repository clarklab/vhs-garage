// OpenSubtitles REST v1: pick an English human SRT for an IMDb title.
// Zip payloads are treated as a miss — we do not unzip.

export const OS_USER_AGENT = 'vhs-garage v1.0';
const SEARCH = 'https://api.opensubtitles.com/api/v1/subtitles';
const DOWNLOAD = 'https://api.opensubtitles.com/api/v1/download';

export function numericImdbId(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^tt(\d{5,10})$/i) || s.match(/^(\d{5,10})$/);
  return m ? String(Number(m[1])) : null;
}

function filesOf(row) {
  return Array.isArray(row?.attributes?.files) ? row.attributes.files : [];
}

function isEnglish(row) {
  const lang = String(row?.attributes?.language || '').toLowerCase();
  return lang === 'en' || lang.startsWith('en-');
}

function isHuman(row) {
  const a = row?.attributes || {};
  return a.ai_translated !== true && a.machine_translated !== true && a.auto_translated !== true;
}

function srtFile(file) {
  return /\.srt$/i.test(String(file?.file_name || '')) || !file?.file_name;
}

export function pickBestSubtitle(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(isEnglish)
    .filter(isHuman)
    .map((row) => {
      const file = filesOf(row).find(srtFile) || filesOf(row)[0];
      if (!file?.file_id) return null;
      if (file.file_name && !srtFile(file)) return null;
      return {
        file_id: file.file_id,
        file_name: file.file_name || '',
        trusted: row.attributes?.from_trusted === true ? 1 : 0,
        downloads: Number(row.attributes?.download_count) || 0,
      };
    })
    .filter(Boolean);
  list.sort((a, b) => b.trusted - a.trusted || b.downloads - a.downloads);
  return list[0] || null;
}

export async function searchSubtitles(imdbId, { apiKey, signal } = {}) {
  const numeric = numericImdbId(imdbId);
  if (!numeric) throw new Error('Invalid IMDb id');
  if (!apiKey) throw new Error('OpenSubtitles key missing');
  const url = new URL(SEARCH);
  url.searchParams.set('imdb_id', numeric);
  url.searchParams.set('languages', 'en');
  const res = await fetch(url, {
    headers: { 'Api-Key': apiKey, 'User-Agent': OS_USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`OpenSubtitles search ${res.status}`);
  const body = await res.json();
  return pickBestSubtitle(body?.data || []);
}

export async function downloadSubtitle(fileId, { apiKey, signal } = {}) {
  if (!fileId) throw new Error('Missing subtitle file');
  if (!apiKey) throw new Error('OpenSubtitles key missing');
  const res = await fetch(DOWNLOAD, {
    method: 'POST',
    headers: {
      'Api-Key': apiKey,
      'User-Agent': OS_USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file_id: fileId }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenSubtitles download ${res.status}`);
  const body = await res.json();
  const link = body?.link;
  if (!link) throw new Error('OpenSubtitles returned no link');
  const file = await fetch(link, { signal, headers: { 'User-Agent': OS_USER_AGENT } });
  if (!file.ok) throw new Error(`Subtitle file ${file.status}`);
  const buf = Buffer.from(await file.arrayBuffer());
  const head = buf.slice(0, 4).toString('utf8');
  if (head.startsWith('PK')) throw new Error('Subtitle was a zip');
  return buf.toString('utf8');
}
