// Run once in a vhsgarage.com/tik tab (via serve.py: `(0, eval)(await (await fetch('http://127.0.0.1:8765/drafts/_draft.js')).text())`).
// Defines window.__makeDraft(payload): saves a locally written Tape Trivia set as a new draft, in the
// same record shape batch.js saveDraft writes (placeholder frames, outro, batch.pendingFrames = true),
// so Shoot or the local frames flow can fill it in. payload is W/drafts/<slug>.json from make-draft.py.
// A payload with `outro` and `post` carries hand-written copy (COPY.md): the sign-off is used as
// written, and the post title and description are saved as the set's own with postEdited set, because
// the studio regenerates both from its templates on open for any set that is not marked edited.
window.__makeDraft = async (w) => {
  const { makeProject, defaultPostFields, pickOutro } = await import('/scripts/tik/project.js');
  const { fontScaleForTrivia } = await import('/scripts/tik/caption.js');
  const { makeCardBitmap } = await import('/scripts/tik/placeholder.js');
  const { houseSetAt } = await import('/scripts/tik/hashtags.js');
  const { putProject, getProject } = await import('/scripts/tik/store.js');
  const toBlob = (bitmap, maxEdge = 0) => new Promise((resolve, reject) => {
    const scale = maxEdge ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * scale)); c.height = Math.max(1, Math.round(bitmap.height * scale));
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.92);
  });
  const now = Date.now();
  const id = crypto.randomUUID();
  const label = `${w.title} (${w.year})`;
  const card = await makeCardBitmap({ heading: w.title, sub: `${w.year} · frame pending`, hint: 'Written by Claude; frames being picked locally', accent: '#10b981' });
  const frame = await toBlob(card); const thumb = await toBlob(card, 240); card.close?.();
  let outro = null;
  try { const r = await fetch('/images/vhs-garage-logo-square.png'); if (r.ok) outro = await r.blob(); else console.error('[tik-frames] outro logo', r.status); } catch (e) { console.error('[tik-frames] outro logo failed', e); }
  const project = makeProject({ id, format: 'trivia', now });
  const houseSetKey = houseSetAt(w.house).key;
  const written = !!(w.post?.title && w.post?.description);
  const post = written
    ? { title: w.post.title, description: w.post.description, hashtagSet: houseSetKey }
    : defaultPostFields('trivia', label, { meta: w.meta, projectId: id, houseSetKey });
  Object.assign(project, {
    name: label,
    movie: { title: w.title, year: w.year, query: w.title },
    postTitle: post.title, postDesc: post.description, postEdited: written, hashtagSet: post.hashtagSet, postMeta: w.meta,
    batch: { imdbId: w.imdbId, runtimeSeconds: w.runtimeSeconds, pendingFrames: true, sourceCount: w.slides.length },
    slides: [
      ...w.slides.map((s, i) => ({ id: String(i + 1), caption: s.caption, timecode: s.timecode, grabHint: s.grab, fontScale: i === 0 ? 1 : fontScaleForTrivia(s.caption), role: null, kind: i === 0 ? 'title' : null, entry: null, section: null, cue: null, frame, batchShot: i === 0 ? 'title' : 'trivia' })),
      ...(outro ? [{ id: String(w.slides.length + 1), caption: String(w.outro || '').trim() || pickOutro('trivia'), timecode: null, grabHint: '', fontScale: 1, role: null, kind: 'outro', entry: null, section: null, frame: outro, batchShot: 'skip' }] : []),
    ],
    thumb,
  });
  await putProject(project);
  const back = await getProject(id);
  return { id, name: back.name, slides: back.slides.length, status: back.status, hashtagSet: back.hashtagSet, pending: back.batch.pendingFrames, outro: !!outro, postEdited: back.postEdited, postTitle: back.postTitle };
};
