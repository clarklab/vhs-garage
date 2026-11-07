// Every slide of every Tape Trivia set, with what the picker needs: caption, the
// writer's hint, the frame's current time, how it was picked, and any wrong mark.
// Run it in a vhsgarage.com/tik tab. The result is big, so it is POSTed to the
// local receiver (`python3 recv.py` in this folder, port 8766) as W/inbox/facts.json;
// without the receiver it is returned as text.
const { listProjects } = await import('/scripts/tik/store.js');
const out = [];
for (const p of await listProjects()) {
  if (p.format && p.format !== 'trivia') continue;
  const slides = (p.slides || []).filter((s) => s.kind !== 'outro');
  if (!slides.length) continue;
  out.push({
    id: p.id, title: p.movie?.title || p.name, year: p.movie?.year, status: p.status, updatedAt: p.updatedAt,
    slides: slides.map((s, i) => {
      const fs = s.frameScan || {};
      return { i, kind: s.kind, caption: s.caption, hint: s.grabHint || '', t: s.timecode, source: fs.source, why: fs.why || '', wrong: fs.wrong || null };
    }),
  });
}
const body = JSON.stringify(out, null, 1);
try {
  const r = await fetch('http://127.0.0.1:8766/facts.json', { method: 'POST', body });
  `${out.length} sets → ${r.status} ${await r.text()}`;
} catch (e) {
  console.warn('[tik-frames] no local receiver, returning the dump inline', e);
  body;
}
