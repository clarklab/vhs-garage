// Every frame marked wrong (from the phone's "Wrong frame" button, or anywhere
// else), with what it should show. Run it in a vhsgarage.com/tik tab: the
// library lives in that browser's IndexedDB, synced from the phone.
//
// Each row: the draft, the slide index as deliver.py counts it (the outro is
// not counted), the frame's current time, the note, and the slide's text.
const { listProjects } = await import('/scripts/tik/store.js');
const rows = [];
for (const p of await listProjects()) {
  const slides = (p.slides || []).filter((s) => s.kind !== 'outro');
  slides.forEach((s, i) => {
    if (!s.frameScan?.wrong) return;
    rows.push({
      id: p.id, film: p.movie?.title || p.name, year: p.movie?.year, i,
      t: s.timecode, note: s.frameScan.wrong.note || '', caption: String(s.caption || '').slice(0, 160),
    });
  });
}
JSON.stringify(rows, null, 1);
