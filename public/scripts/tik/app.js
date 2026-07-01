import { loadVideoFile, grabFrame, awaitSeekSettled, seekAndSettle } from './capture.js';
import { initScrubber } from './scrubber.js';
import { addSlide, removeSlide, reorderSlide, editCaption, canAddSlide, MAX_SLIDES, updateSlideFrame } from './slides.js';
import { startAuth, handleRedirect, signOut, isSignedIn, clearLocalToken } from './auth.js';
import { publishSlideshow } from './publish.js';
import { runAutopilot } from './autopilot.js';
import { composeToCanvas } from './compose.js';

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file-input'), video: $('video'),
  range: $('scrub-range'), timecode: $('timecode'),
  stepBack: $('step-back'), stepFwd: $('step-fwd'), grab: $('grab-btn'),
  titleToggle: $('title-toggle'), movieTitle: $('movie-title'),
  count: $('slide-count'), list: $('slide-list'), post: $('post-btn'), status: $('post-status'),
  authBtn: $('auth-btn'), authStatus: $('auth-status'),
  autopilot: $('autopilot-btn'), cancelEdit: $('cancel-edit'),
};

let slides = [];               // [{ id, bitmap, caption, timecode }]
let nextId = 1;
let dragFrom = null;
let editingId = null;          // slide id whose frame is being re-grabbed, or null
const PREVIEW_SCALE = 0.25;    // quarter-res preview thumbnails; uploads stay full-res

initScrubber({
  video: els.video, range: els.range, timecode: els.timecode,
  stepBack: els.stepBack, stepFwd: els.stepFwd,
});

els.video.addEventListener('loadedmetadata', () => {
  els.autopilot.disabled = false;
  els.autopilot.title = '';
});

// TikTok pulls slide images over the public internet, so posting only works from
// a publicly reachable origin. Grab / caption / compose work anywhere.
function isPublicOrigin() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false; // private ranges
  return true;
}

// ---- Auth ----
function refreshAuthUI() {
  const signed = isSignedIn();
  els.authStatus.textContent = signed ? 'signed in ✓' : 'not signed in';
  els.authBtn.textContent = signed ? 'Sign out' : 'Sign in to TikTok';
  updatePostButton();
}
els.authBtn.addEventListener('click', async () => {
  try {
    if (isSignedIn()) { await signOut(); } else { await startAuth(); return; }
  } catch (e) { alert(e.message); }
  refreshAuthUI();
});

// ---- File load ----
els.file.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    await loadVideoFile(file, els.video);
    els.status.textContent = 'Loaded. Scrub and grab frames.';
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
      // Re-grab: replace the frame of the slide being edited.
      slides = updateSlideFrame(slides, editingId, bitmap, els.video.currentTime);
      exitEdit();
      els.status.textContent = 'Frame updated ✓';
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
  els.grab.textContent = '💾 Save frame';
  els.cancelEdit.classList.remove('hidden');
  render(); // apply the highlight
  els.status.textContent = 'Editing this slide — scrub to a new frame, then Save.';
  if (Number.isFinite(slide.timecode)) await seekAndSettle(els.video, slide.timecode);
}
function resetEditState() {
  editingId = null;
  els.grab.textContent = '＋ Grab frame';
  els.cancelEdit.classList.add('hidden');
}
function exitEdit() { resetEditState(); render(); }
els.cancelEdit.addEventListener('click', () => { exitEdit(); els.status.textContent = 'Edit cancelled.'; });

// ---- Autopilot ----
els.autopilot.addEventListener('click', async () => {
  const file = els.file.files?.[0];
  if (!file || !els.video.duration) { els.status.textContent = 'Load a video first.'; return; }
  els.autopilot.disabled = true;
  try {
    const made = await runAutopilot(els.video, file.name, {
      makeId: () => String(nextId++),
      onProgress: (m) => { els.status.textContent = '🤖 ' + m; },
    });
    let added = 0;
    for (const sl of made) { if (canAddSlide(slides)) { slides = addSlide(slides, sl); added++; } }
    render();
    els.status.textContent = `🤖 Added ${added} AI-suggested slide${added === 1 ? '' : 's'} — verify the trivia, tweak captions & frames, then post.`;
  } catch (err) {
    console.error('[tik] autopilot failed:', err);
    els.status.textContent = '⚠️ ' + err.message;
  } finally {
    els.autopilot.disabled = false;
  }
});

// ---- Slide list rendering ----
function render() {
  els.count.textContent = String(slides.length);
  els.grab.disabled = !editingId && !canAddSlide(slides); // Save stays enabled at the cap
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
  li.className = 'flex gap-2 rounded-lg bg-neutral-900 p-2';
  if (slide.id === editingId) li.className += ' ring-2 ring-red-500'; // being re-grabbed
  li.draggable = true;
  li.dataset.index = String(index);

  // Live preview: the FULL composed slide (frame + caption band), rendered at
  // 1080x1920 by composeToCanvas and shrunk to a thumbnail with CSS.
  // Tap it to load its frame into the scrubber and re-grab.
  const thumb = document.createElement('canvas');
  thumb.dataset.thumb = slide.id;
  thumb.className = 'flex-none cursor-pointer rounded bg-black w-[72px] h-auto';
  thumb.title = 'Click to re-grab this frame';
  composeToCanvas(thumb, slide.bitmap, slide.caption, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE });
  thumb.addEventListener('click', () => enterEdit(slide.id));

  const ta = document.createElement('textarea');
  ta.className = 'flex-1 rounded bg-neutral-950 border border-neutral-800 p-2 text-sm text-neutral-100';
  ta.rows = 3;
  ta.placeholder = 'Trivia for this frame…';
  ta.value = slide.caption;
  ta.addEventListener('input', () => {
    slides = editCaption(slides, slide.id, ta.value);
    composeToCanvas(thumb, slide.bitmap, ta.value, { titleLine: currentTitleLine(), scale: PREVIEW_SCALE }); // live preview
  });

  const del = document.createElement('button');
  del.className = 'flex-none self-start rounded bg-neutral-800 px-2 py-1 text-xs';
  del.textContent = '✕';
  del.addEventListener('click', () => {
    slides = removeSlide(slides, slide.id);
    if (slide.id === editingId) resetEditState(); // don't leave edit mode dangling
    render();
  });

  li.append(thumb, ta, del);

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

// ---- Post ----
function updatePostButton() {
  const publicOrigin = isPublicOrigin();
  els.post.disabled = !(isSignedIn() && slides.length > 0 && publicOrigin);
  els.post.title = publicOrigin ? '' : 'Posting to TikTok needs the deployed site';
}
els.post.addEventListener('click', async () => {
  els.post.disabled = true;
  try {
    // The movie-title line is intentionally reused as the draft's post title —
    // an editable hint the creator can change in the TikTok app.
    const titleLine = currentTitleLine();
    const result = await publishSlideshow(slides, {
      titleLine,
      title: titleLine,
      onProgress: (m) => { els.status.textContent = m; },
    });
    if (result.status === 'FAILED') {
      els.status.textContent = '⚠️ TikTok reported a failure — check the app.';
    } else if (result.status === 'SEND_TO_USER_INBOX' || result.status === 'PUBLISH_COMPLETE') {
      els.status.textContent = '✅ Draft sent to your TikTok inbox. Open the app to publish.';
    } else {
      els.status.textContent = '⏳ Uploaded — still processing. Check your TikTok inbox shortly.';
    }
  } catch (err) {
    console.error('[tik] post failed:', err);
    if (err.reauth) { clearLocalToken(); refreshAuthUI(); } // token dead → back to signed-out
    els.status.textContent = '⚠️ ' + err.message;
  } finally {
    updatePostButton();
  }
});

// ---- Boot ----
(async () => {
  try {
    if (await handleRedirect()) els.status.textContent = 'Signed in to TikTok ✓';
  } catch (e) { console.error('[tik] sign-in failed:', e); els.status.textContent = e.message; }
  if (!isPublicOrigin()) {
    els.status.textContent = 'ℹ️ Grab & caption work here; posting to TikTok needs the deployed site (TikTok can’t fetch images from a local address).';
  }
  refreshAuthUI();
  render();
})();
