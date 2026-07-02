import { loadVideoFile, grabFrame, awaitSeekSettled, seekAndSettle } from './capture.js';
import { initScrubber } from './scrubber.js';
import { addSlide, removeSlide, reorderSlide, editCaption, canAddSlide, MAX_SLIDES, updateSlideFrame } from './slides.js';
import { startAuth, handleRedirect, signOut, isSignedIn, clearLocalToken } from './auth.js';
import { publishSlideshow } from './publish.js';
import { fetchScenes } from './autopilot.js';
import { parseMovieName } from './filename.js';
import { formatTimecode } from './timecode.js';
import { composeToCanvas, composeSlide } from './compose.js';

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file-input'), video: $('video'),
  range: $('scrub-range'), timecode: $('timecode'),
  grab: $('grab-btn'), grabIcon: $('grab-icon'), grabLabel: $('grab-label'),
  titleToggle: $('title-toggle'), movieTitle: $('movie-title'),
  count: $('slide-count'), list: $('slide-list'), post: $('post-btn'), status: $('post-status'),
  authBtn: $('auth-btn'), authStatus: $('auth-status'),
  autopilot: $('autopilot-btn'), cancelEdit: $('cancel-edit'), addScene: $('add-scene'),
  download: $('download-btn'),
};

let slides = [];               // [{ id, bitmap, caption, timecode }]
let nextId = 1;
let dragFrom = null;
let editingId = null;          // slide id whose frame is being re-grabbed, or null
let videoReady = false;        // metadata loaded → grabbing is possible
let aiBusy = false;            // an AI action (autopilot/add/redo) is in flight
let movie = { title: '', year: null, query: '' }; // parsed from the filename
const PREVIEW_SCALE = 0.25;    // quarter-res preview thumbnails; uploads stay full-res

// A Material Symbols icon element (for JS-created buttons).
function iconSpan(name, sizeClass = 'text-[18px]') {
  const s = document.createElement('span');
  s.className = `material-symbols-outlined ${sizeClass} leading-none`;
  s.textContent = name;
  return s;
}

initScrubber({
  video: els.video, range: els.range, timecode: els.timecode,
  steps: [...document.querySelectorAll('#scrubber [data-frames], #scrubber [data-seconds]')],
});

els.video.addEventListener('loadedmetadata', () => {
  videoReady = true;
  els.autopilot.disabled = aiBusy; // stay disabled if a job is mid-flight
  els.autopilot.title = '';
  render(); // updates the Add-scene button state
});

// One AI action at a time. Background jobs can run for minutes now, so ALL the
// AI entry points must visibly disable together — not just the button clicked.
function setAiBusy(v) {
  aiBusy = v;
  els.autopilot.disabled = v || !videoReady;
  els.addScene.disabled = v || !videoReady || !canAddSlide(slides);
}

// TikTok pulls slide images over the public internet, so posting only works from
// a publicly reachable origin. Grab / caption / compose work anywhere.
function isPublicOrigin() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false; // private ranges
  return true;
}

// Seek to a timecode and grab the settled frame.
async function grabAt(timecode) {
  await seekAndSettle(els.video, timecode);
  return grabFrame(els.video);
}

// ---- Auth ----
function refreshAuthUI() {
  const signed = isSignedIn();
  els.authStatus.textContent = signed ? 'signed in' : 'not signed in';
  els.authBtn.textContent = signed ? 'Sign out' : 'Sign in to TikTok';
  updatePostButton();
}
els.authBtn.addEventListener('click', async () => {
  try {
    if (isSignedIn()) { await signOut(); } else { await startAuth(); return; }
  } catch (e) { console.error('[tik] auth failed:', e); alert(e.message); }
  refreshAuthUI();
});

// ---- File load ----
els.file.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  movie = parseMovieName(file.name);
  try {
    await loadVideoFile(file, els.video);
    els.status.textContent = `Loaded ${movie.query}. Scrub and grab frames, or run Autopilot.`;
  } catch (err) {
    console.error('[tik] failed to load video file:', err);
    els.status.textContent = err.message;
  }
});

// ---- Title prefix toggle ----
els.titleToggle.addEventListener('change', () => {
  els.movieTitle.disabled = !els.titleToggle.checked;
  redrawAllThumbs(); // title line appears/disappears on every slide preview
});
els.movieTitle.addEventListener('input', redrawAllThumbs);
function currentTitleLine() {
  return els.titleToggle.checked ? els.movieTitle.value.trim() : '';
}

// ---- Grab / Save frame ----
els.grab.addEventListener('click', async () => {
  try {
    await awaitSeekSettled(els.video); // don't grab a stale frame mid-seek
    const bitmap = await grabFrame(els.video);
    if (editingId) {
      slides = updateSlideFrame(slides, editingId, bitmap, els.video.currentTime);
      exitEdit();
      els.status.textContent = 'Frame updated.';
    } else {
      if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides.`; return; }
      slides = addSlide(slides, { id: String(nextId++), bitmap, caption: '', timecode: els.video.currentTime });
      render();
    }
  } catch (err) { console.error('[tik] grab failed:', err); els.status.textContent = err.message; }
});

// ---- Edit a slide's frame: tap thumb → seek there → Save replaces it ----
async function enterEdit(id) {
  const slide = slides.find((s) => s.id === id);
  if (!slide) return;
  editingId = id;
  els.grabIcon.textContent = 'save';
  els.grabLabel.textContent = 'Save frame';
  els.cancelEdit.classList.remove('hidden');
  render(); // apply the highlight
  els.status.textContent = slide.grabHint
    ? `Editing this slide — GRAB: ${slide.grabHint}`
    : 'Editing this slide — scrub to a new frame, then Save.';
  if (Number.isFinite(slide.timecode)) await seekAndSettle(els.video, slide.timecode);
}
function resetEditState() {
  editingId = null;
  els.grabIcon.textContent = 'photo_camera';
  els.grabLabel.textContent = 'Grab frame';
  els.cancelEdit.classList.add('hidden');
}
function exitEdit() { resetEditState(); render(); }
els.cancelEdit.addEventListener('click', () => { exitEdit(); els.status.textContent = 'Edit cancelled.'; });

// ---- Autopilot: preload a full slideshow ----
els.autopilot.addEventListener('click', async () => {
  if (!videoReady) { els.status.textContent = 'Load a video first.'; return; }
  if (!canAddSlide(slides)) { els.status.textContent = `Slide cap reached (${MAX_SLIDES}) — delete some first.`; return; }
  if (aiBusy) return;
  setAiBusy(true);
  try {
    els.status.textContent = `Researching ${movie.query || 'the film'}…`;
    // Title slide first (grabbed at the film's title-card shot), then 5 trivia scenes.
    const scenes = await fetchScenes({
      title: movie.title, year: movie.year, durationSeconds: els.video.duration,
      count: 5, includeTitleSlide: true,
      onProgress: (m) => { els.status.textContent = `Researching ${movie.query || 'the film'} — ${m}`; },
    });
    let added = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (!canAddSlide(slides)) break;
      els.status.textContent = `Grabbing frame ${i + 1}/${scenes.length}…`;
      const bitmap = await grabAt(scenes[i].timecode);
      slides = addSlide(slides, {
        id: String(nextId++), bitmap,
        caption: scenes[i].caption, timecode: scenes[i].timecode, grabHint: scenes[i].grab || '',
      });
      added++;
    }
    render();
    if (added === 0) {
      els.status.textContent = `Slide cap reached (${MAX_SLIDES}) — nothing added.`;
    } else {
      const trivia = added - 1; // first added slide is the title slide
      els.status.textContent = `Added a title slide + ${trivia} AI scene${trivia === 1 ? '' : 's'} — verify the trivia, tweak captions & frames, then post.`;
    }
  } catch (err) {
    console.error('[tik] autopilot failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
  }
});

// ---- Add one more AI scene (with context so it doesn't repeat) ----
els.addScene.addEventListener('click', async () => {
  if (!videoReady) { els.status.textContent = 'Load a video first.'; return; }
  if (!canAddSlide(slides)) { els.status.textContent = `Max ${MAX_SLIDES} slides.`; return; }
  if (aiBusy) return;
  setAiBusy(true);
  try {
    els.status.textContent = 'Finding another scene…';
    const [scene] = await fetchScenes({
      title: movie.title, year: movie.year, durationSeconds: els.video.duration,
      count: 1, exclude: slides.map((s) => s.caption),
      onProgress: (m) => { els.status.textContent = `Finding another scene — ${m}`; },
    });
    const bitmap = await grabAt(scene.timecode);
    slides = addSlide(slides, {
      id: String(nextId++), bitmap,
      caption: scene.caption, timecode: scene.timecode, grabHint: scene.grab || '',
    });
    render();
    els.status.textContent = 'Added a new AI scene — tweak it or add more.';
  } catch (err) {
    console.error('[tik] add scene failed:', err);
    els.status.textContent = err.message;
  } finally {
    setAiBusy(false);
    render(); // restores the Add-scene disabled state for the current cap
  }
});

// ---- Slide list rendering ----
function render() {
  els.count.textContent = String(slides.length);
  els.grab.disabled = !editingId && !canAddSlide(slides); // Save stays enabled at the cap
  els.addScene.disabled = aiBusy || !videoReady || !canAddSlide(slides);
  els.download.disabled = slides.length === 0;
  els.list.innerHTML = '';
  slides.forEach((slide, index) => els.list.appendChild(renderSlide(slide, index)));
  updatePostButton();
}

// Redraw the preview thumbnails in place (no full re-render) so editing a caption
// or the title updates the live preview without rebuilding the list / losing focus.
function redrawAllThumbs() {
  slides.forEach((slide) => {
    const thumb = els.list.querySelector(`canvas[data-thumb="${slide.id}"]`);
    if (thumb) composeToCanvas(thumb, slide.bitmap, slide.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE });
  });
}

function renderSlide(slide, index) {
  const li = document.createElement('li');
  li.className = 'flex flex-col gap-2 rounded-lg bg-neutral-900 p-2';
  if (slide.id === editingId) li.className += ' ring-2 ring-red-500'; // being re-grabbed
  li.draggable = true;
  li.dataset.index = String(index);

  const row = document.createElement('div');
  row.className = 'flex gap-2';

  // Live preview: the FULL composed slide (frame + caption pills), rendered at
  // 1080x1920 by composeToCanvas and shrunk to a thumbnail with CSS.
  // Tap it to load its frame into the scrubber and re-grab.
  const thumb = document.createElement('canvas');
  thumb.dataset.thumb = slide.id;
  thumb.className = 'flex-none cursor-pointer rounded bg-black w-[72px] h-auto';
  thumb.title = 'Click to re-grab this frame';
  composeToCanvas(thumb, slide.bitmap, slide.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE });
  thumb.addEventListener('click', () => enterEdit(slide.id));

  // Text fields inside a draggable <li> lose mouse text-selection to the drag
  // handler — suspend dragging while a field is being used.
  const suspendDragWhileEditing = (field) => {
    field.addEventListener('pointerdown', () => { li.draggable = false; });
    field.addEventListener('blur', () => { li.draggable = true; });
  };

  const mid = document.createElement('div');
  mid.className = 'flex flex-1 flex-col gap-1 min-w-0';

  const ta = document.createElement('textarea');
  ta.className = 'w-full rounded bg-neutral-950 border border-neutral-800 p-2 text-sm text-neutral-100';
  ta.rows = 3;
  ta.maxLength = 300; // AI caps at 180; give manual edits headroom but keep slides renderable
  ta.placeholder = 'Trivia for this frame…';
  ta.value = slide.caption;
  ta.addEventListener('input', () => {
    slides = editCaption(slides, slide.id, ta.value);
    composeToCanvas(thumb, slide.bitmap, ta.value, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE }); // live preview
  });
  suspendDragWhileEditing(ta);
  mid.append(ta);

  // Editor-only hint from the AI: what shot to look for when (re)grabbing.
  // Never baked into the slide or sent to TikTok.
  if (slide.grabHint) {
    const hint = document.createElement('p');
    hint.className = 'text-[11px] uppercase tracking-wide text-neutral-500 truncate';
    hint.title = slide.grabHint;
    hint.textContent = `GRAB: ${slide.grabHint}`;
    mid.append(hint);
  }

  // Twinkle: opens a steerable AI panel — rewrite this fact (keep frame) or
  // swap in a totally different scene (new frame + caption), with optional
  // free-text guidance either way.
  const redo = document.createElement('button');
  redo.className = 'rounded bg-neutral-800 px-2 py-1 text-fuchsia-300 disabled:opacity-40';
  redo.title = 'Redo with AI…';
  redo.append(iconSpan('auto_awesome'));

  const del = document.createElement('button');
  del.className = 'rounded bg-neutral-800 px-2 py-1 text-neutral-400';
  del.title = 'Delete slide';
  del.append(iconSpan('delete'));
  del.addEventListener('click', () => {
    slides = removeSlide(slides, slide.id);
    if (slide.id === editingId) resetEditState(); // don't leave edit mode dangling
    render();
  });

  const controls = document.createElement('div');
  controls.className = 'flex flex-none flex-col gap-1';
  controls.append(redo, del);

  row.append(thumb, mid, controls);

  // --- AI panel (hidden until the twinkle is clicked). Runs on Opus 4.8 —
  // the strongest model — since it's a single-suggestion request. ---
  const panel = document.createElement('div');
  panel.className = 'hidden gap-1.5 flex-col';

  // Say exactly what each action sends, so nothing feels like a mystery box.
  const hint = document.createElement('p');
  hint.className = 'text-[11px] leading-snug text-neutral-500';
  const tcLabel = Number.isFinite(slide.timecode) ? formatTimecode(slide.timecode) : 'this moment';
  hint.innerHTML =
    `<b class="text-neutral-400">Rewrite fact</b> asks Claude Opus for different trivia about this same scene (at ${tcLabel}) — the frame stays. ` +
    `<b class="text-neutral-400">New scene</b> asks for a different moment entirely — replaces the frame and the caption. ` +
    `Both are told to avoid the trivia already on your slides, and anything you type below is sent along as guidance.`;

  const guide = document.createElement('input');
  guide.type = 'text';
  guide.placeholder = 'Optional guidance sent with either button — e.g. “something about the practical effects”';
  guide.className = 'flex-1 rounded bg-neutral-950 border border-neutral-800 px-2 py-1.5 text-sm text-neutral-100';
  suspendDragWhileEditing(guide);

  const mkPanelBtn = (icon, label, tip) => {
    const b = document.createElement('button');
    b.className = 'flex items-center justify-center gap-1 rounded bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 disabled:opacity-40';
    b.title = tip;
    b.append(iconSpan(icon), document.createTextNode(label));
    return b;
  };
  const rewriteBtn = mkPanelBtn('edit_note', 'Rewrite fact', 'New trivia for this same scene — keeps the frame');
  const newSceneBtn = mkPanelBtn('movie', 'New scene', 'Different moment — replaces frame + caption');

  const panelRow = document.createElement('div');
  panelRow.className = 'flex flex-col gap-2 sm:flex-row sm:items-center';
  panelRow.append(guide, rewriteBtn, newSceneBtn);
  panel.append(hint, panelRow);

  redo.addEventListener('click', () => {
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      panel.classList.add('flex');
      guide.focus();
    } else {
      panel.classList.add('hidden');
      panel.classList.remove('flex');
    }
  });

  // Shared runner for the two panel actions.
  const runPanelAction = async (mode) => {
    if (!videoReady) { els.status.textContent = 'Load a video first.'; return; }
    if (aiBusy) return;
    setAiBusy(true);
    rewriteBtn.disabled = true;
    newSceneBtn.disabled = true;
    try {
      const guidance = guide.value.trim();
      if (mode === 'rewrite') {
        // New fact about the SAME moment; the frame stays. Opus = best recall.
        els.status.textContent = 'Asking Claude Opus for a better fact…';
        const exclude = slides.filter((s) => s.id !== slide.id).map((s) => s.caption);
        const [scene] = await fetchScenes({
          title: movie.title, year: movie.year, durationSeconds: els.video.duration,
          count: 1, exclude, focusTimecode: slide.timecode, guidance, model: 'claude-opus-4-8',
          onProgress: (m) => { els.status.textContent = `Rewriting this fact — ${m}`; },
        });
        slides = editCaption(slides, slide.id, scene.caption);
        ta.value = scene.caption;
        composeToCanvas(thumb, slide.bitmap, scene.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE });
        els.status.textContent = 'Trivia rewritten.';
      } else {
        // A different scene entirely: new caption AND a new frame at its timecode.
        els.status.textContent = 'Asking Claude Opus for a different scene…';
        const exclude = slides.map((s) => s.caption); // exclude this one too
        const [scene] = await fetchScenes({
          title: movie.title, year: movie.year, durationSeconds: els.video.duration,
          count: 1, exclude, guidance, model: 'claude-opus-4-8',
          onProgress: (m) => { els.status.textContent = `Finding a different scene — ${m}`; },
        });
        const bitmap = await grabAt(scene.timecode);
        slides = updateSlideFrame(slides, slide.id, bitmap, scene.timecode);
        slides = editCaption(slides, slide.id, scene.caption);
        slides = slides.map((s) => (s.id === slide.id ? { ...s, grabHint: scene.grab || '' } : s));
        render();
        els.status.textContent = 'Swapped in a different scene — tweak the frame if needed.';
      }
    } catch (err) {
      console.error('[tik] AI panel action failed:', err);
      els.status.textContent = err.message;
    } finally {
      setAiBusy(false);
      rewriteBtn.disabled = false;
      newSceneBtn.disabled = false;
    }
  };
  rewriteBtn.addEventListener('click', () => runPanelAction('rewrite'));
  newSceneBtn.addEventListener('click', () => runPanelAction('newScene'));

  li.append(row, panel);

  // Drag to reorder.
  li.addEventListener('dragstart', () => { dragFrom = index; });
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const to = Number(li.dataset.index);
    if (dragFrom !== null && dragFrom !== to) { slides = reorderSlide(slides, dragFrom, to); render(); }
    dragFrom = null;
  });

  return li;
}

// ---- Download slides (no-API path: post them manually in the TikTok app) ----
els.download.addEventListener('click', async () => {
  if (!slides.length) return;
  els.download.disabled = true;
  try {
    const slug = (movie.title || 'trivia').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trivia';
    const titleLine = currentTitleLine();
    for (let i = 0; i < slides.length; i++) {
      els.status.textContent = `Rendering slide ${i + 1}/${slides.length}…`;
      const blob = await composeSlide(slides[i].bitmap, slides[i].caption, { titleLine });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slug}-${String(i + 1).padStart(2, '0')}.jpg`;
      a.click();
      URL.revokeObjectURL(a.href);
      // Small gap so the browser doesn't coalesce/drop rapid downloads.
      await new Promise((r) => setTimeout(r, 250));
    }
    els.status.textContent = `Downloaded ${slides.length} slide${slides.length === 1 ? '' : 's'} — post them from the TikTok app (photo post), in order.`;
  } catch (err) {
    console.error('[tik] download failed:', err);
    els.status.textContent = err.message;
  } finally {
    els.download.disabled = slides.length === 0;
  }
});

// ---- Post ----
function updatePostButton() {
  const publicOrigin = isPublicOrigin();
  els.post.disabled = !(isSignedIn() && slides.length > 0 && publicOrigin);
  els.post.title = publicOrigin ? '' : 'Posting to TikTok needs the deployed site';
}
els.post.addEventListener('click', async () => {
  els.post.disabled = true;
  try {
    // Always send a real post title + description (they prefill the draft in
    // the TikTok app — previously we sent the toggle's title line, which is
    // empty when the toggle is off, so drafts arrived blank).
    const titleLine = currentTitleLine();
    const slugTag = (movie.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const postTitle = movie.query ? `${movie.query} — deep-cut trivia` : (titleLine || 'Deep-cut movie trivia');
    const postDesc = `${movie.query ? `Deep-cut trivia from ${movie.query}. ` : ''}Which one surprised you? #movietrivia #film${slugTag ? ` #${slugTag}` : ''}`;
    const result = await publishSlideshow(slides, {
      titleLine,
      title: postTitle,
      description: postDesc,
      onProgress: (m) => { els.status.textContent = m; },
    });
    if (result.status === 'FAILED') {
      console.error('[tik] TikTok post FAILED', result);
      els.status.textContent = result.failReason
        ? `TikTok rejected the post: ${result.failReason}`
        : 'TikTok reported a failure — check the app.';
    } else if (result.status === 'SEND_TO_USER_INBOX' || result.status === 'PUBLISH_COMPLETE') {
      els.status.textContent = 'Draft sent to your TikTok inbox. Open the app to publish.';
    } else {
      els.status.textContent = 'Uploaded — still processing. Check your TikTok inbox shortly.';
    }
  } catch (err) {
    console.error('[tik] post failed:', err);
    if (err.reauth) { clearLocalToken(); refreshAuthUI(); } // token dead → back to signed-out
    els.status.textContent = err.message;
  } finally {
    updatePostButton();
  }
});

// ---- Boot ----
(async () => {
  try {
    if (await handleRedirect()) els.status.textContent = 'Signed in to TikTok.';
  } catch (e) { console.error('[tik] sign-in failed:', e); els.status.textContent = e.message; }
  if (!isPublicOrigin()) {
    els.status.textContent = 'Grab & caption work here; posting to TikTok needs the deployed site (TikTok can’t fetch images from a local address).';
  }
  refreshAuthUI();
  render();
})();
