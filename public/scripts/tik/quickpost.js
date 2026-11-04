// Quick post — the phone page (/tik/post/).
//
// Ready sets first, then drafts, then everything posted. Tapping a set opens
// a swipe-through of its finished slides, the sound picks with a copy button,
// the caption, and one button that sends the set to the TikTok inbox — the
// same publish path the studio uses, drawn with the same compose code.
//
// The library is this device's IndexedDB copy, kept in step with the cloud
// library by sync.js. Frames come down the first time a set is opened.

import { listProjects, getProject, putProject } from './store.js';
import { initSync, captureLinkFromUrl, hydrateRecord, onSyncStatus, isLinked, setSyncKey } from './sync.js';
import { isSignedIn, clearLocalToken } from './auth.js';
import { publishSlideshow } from './publish.js';
import { composeToCanvas, captionFontReady, quoteStampReady, clampStampNudge } from './compose.js';
import { projectDisplayName, relativeTime, toggleReady, statusOf } from './project.js';
import { groupForQuickPost, canPublish, composeOptionsFor, postCopyFor, songsFor, flagsFor, songQuery } from './quickpostlib.js';

const $ = (id) => document.getElementById(id);
const els = {
  back: $('qp-back'), logo: $('qp-logo'), title: $('qp-title'),
  syncDot: $('qp-sync-dot'), syncText: $('qp-sync-text'),
  home: $('qp-home'), link: $('qp-link'), key: $('qp-key'), keySave: $('qp-key-save'), signin: $('qp-signin'),
  ready: $('qp-ready'), readyCount: $('qp-ready-count'), readyEmpty: $('qp-ready-empty'),
  drafts: $('qp-drafts'), draftCount: $('qp-draft-count'), draftsEmpty: $('qp-drafts-empty'),
  posted: $('qp-posted'), postedCount: $('qp-posted-count'), postedMore: $('qp-posted-more'),
  review: $('qp-review'), slides: $('qp-slides'), dots: $('qp-dots'), loading: $('qp-loading'),
  slideCount: $('qp-slide-count'), slideFlag: $('qp-slide-flag'),
  songsWrap: $('qp-songs-wrap'), songs: $('qp-songs'),
  postTitle: $('qp-post-title'), postDesc: $('qp-post-desc'),
  done: $('qp-done'), next: $('qp-next'),
  actions: $('qp-actions'), status: $('qp-status'), toggleReady: $('qp-toggle-ready'),
  publish: $('qp-publish'), publishLabel: $('qp-publish-label'),
};

const PREVIEW_SCALE = 0.5;
const POSTED_PAGE = 30;
let showAllPosted = false;
let thumbUrls = [];
let current = null;   // { rec, bitmaps, flags: [bool] }
let openSeq = 0;
let publishing = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = 'text-[18px]') => `<span class="material-symbols-outlined ${cls} leading-none">${name}</span>`;

// ================= list =================

function thumbHtml(rec, cls) {
  if (rec.thumb instanceof Blob) {
    const url = URL.createObjectURL(rec.thumb);
    thumbUrls.push(url);
    return `<img src="${url}" alt="" class="${cls} object-cover" loading="lazy" />`;
  }
  return `<span class="${cls} flex items-center justify-center bg-neutral-900 text-neutral-700">${icon('movie', 'text-[22px]')}</span>`;
}

function setCard(rec, tone) {
  const li = document.createElement('li');
  const n = (rec.slides || []).length;
  const flags = flagsFor(rec);
  const song = songsFor(rec)[0];
  const pending = rec.batch?.pendingFrames;
  const when = relativeTime(rec.updatedAt || 0, Date.now());
  li.innerHTML = `
    <button class="flex w-full items-center gap-3 rounded-xl border ${tone === 'ready' ? 'border-violet-400/40 bg-violet-400/5' : 'border-neutral-800 bg-neutral-900'} p-2 text-left active:bg-neutral-800">
      ${thumbHtml(rec, 'h-24 w-[3.4rem] flex-none rounded-md')}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[15px] font-bold tracking-tight">${esc(projectDisplayName(rec))}</span>
        <span class="mt-0.5 block text-xs text-neutral-400">${n} slides · ${esc(when)}</span>
        <span class="mt-1 flex flex-wrap gap-1.5">
          ${pending ? '<span class="rounded-md bg-red-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-red-200">frames not shot</span>' : ''}
          ${flags ? `<span class="rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-200">${flags} to check</span>` : ''}
          ${song ? `<span class="truncate text-[11px] text-neutral-500">♪ ${esc(song.title)}</span>` : ''}
        </span>
      </span>
      <span class="flex-none text-neutral-600">${icon('chevron_right', 'text-[22px]')}</span>
    </button>`;
  li.querySelector('button').addEventListener('click', () => openReview(rec.id));
  return li;
}

function postedTile(rec) {
  const li = document.createElement('li');
  const views = rec.imported?.views;
  const link = rec.imported?.link || rec.link || '';
  const inner = `
    ${thumbHtml(rec, 'aspect-[9/16] w-full rounded-md')}
    <span class="mt-1 block truncate text-[11px] font-semibold text-neutral-300">${esc(projectDisplayName(rec))}</span>
    <span class="block text-[10px] text-neutral-500">${esc(relativeTime(rec.postedAt || rec.updatedAt || 0, Date.now()))}${Number.isFinite(views) ? ` · ${views.toLocaleString()} views` : ''}</span>`;
  li.innerHTML = link
    ? `<a href="${esc(link)}" target="_blank" rel="noopener" class="block">${inner}</a>`
    : `<button class="block w-full text-left">${inner}</button>`;
  if (!link) li.querySelector('button').addEventListener('click', () => openReview(rec.id));
  return li;
}

async function renderHome() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  els.link.classList.toggle('hidden', isLinked());
  els.signin.classList.toggle('hidden', isSignedIn());
  let records = [];
  try { records = await listProjects(); } catch (e) { console.error('[quickpost] library read failed:', e); }
  const { ready, drafts, posted } = groupForQuickPost(records);

  els.ready.replaceChildren(...ready.map((r) => setCard(r, 'ready')));
  els.readyCount.textContent = ready.length ? String(ready.length) : '';
  els.readyEmpty.classList.toggle('hidden', ready.length > 0);

  els.drafts.replaceChildren(...drafts.map((r) => setCard(r, 'draft')));
  els.draftCount.textContent = drafts.length ? String(drafts.length) : '';
  els.draftsEmpty.classList.toggle('hidden', drafts.length > 0);

  const shown = showAllPosted ? posted : posted.slice(0, POSTED_PAGE);
  els.posted.replaceChildren(...shown.map(postedTile));
  els.postedCount.textContent = posted.length ? String(posted.length) : '';
  els.postedMore.classList.toggle('hidden', showAllPosted || posted.length <= POSTED_PAGE);
  els.postedMore.textContent = `Show all ${posted.length} posts`;
}

els.postedMore.addEventListener('click', () => { showAllPosted = true; renderHome(); });
els.keySave.addEventListener('click', () => {
  if (!els.key.value.trim()) return;
  setSyncKey(els.key.value);
  els.key.value = '';
  startSync();
});

// ================= review =================

function showView(view) {
  const review = view === 'review';
  els.home.classList.toggle('hidden', review);
  els.review.classList.toggle('hidden', !review);
  els.actions.classList.toggle('hidden', !review);
  els.back.classList.toggle('hidden', !review);
  els.logo.classList.toggle('hidden', review);
  if (!review) els.title.textContent = 'Quick post';
  window.scrollTo(0, 0);
}

function closeReview() {
  openSeq++;
  current?.bitmaps.forEach((b) => b?.close?.());
  current = null;
  els.slides.replaceChildren();
  showView('home');
  renderHome();
}

async function openReview(id, { push = true } = {}) {
  const seq = ++openSeq;
  if (push && location.hash !== `#set-${id}`) history.pushState({ id }, '', `#set-${id}`);
  showView('review');
  els.slides.replaceChildren();
  els.dots.replaceChildren();
  els.done.classList.add('hidden');
  els.loading.classList.remove('hidden');
  els.status.textContent = '';
  let rec;
  try {
    rec = await getProject(id);
    if (!rec) throw new Error('That set is not in the library any more.');
    els.title.textContent = projectDisplayName(rec);
    rec = await hydrateRecord(rec);
    if (seq !== openSeq) return;
    await Promise.all([captionFontReady(), quoteStampReady()]);
    const bitmaps = await Promise.all((rec.slides || []).map(frameBitmap));
    if (seq !== openSeq) { bitmaps.forEach((b) => b?.close?.()); return; }
    current = { rec, bitmaps, flags: (rec.slides || []).map((s) => !!s.frameScan?.review) };
  } catch (e) {
    console.error('[quickpost] open failed:', e);
    els.loading.classList.add('hidden');
    els.status.textContent = e.message;
    return;
  }
  els.loading.classList.add('hidden');
  drawSlides();
  fillDetails();
  syncActions();
}

// The same frame the studio would draw: drafts saved with the short-lived
// designed end cards (Oct 2026) get the logo back, as they do on the desk.
const OUTRO_LOGO_URL = '/images/vhs-garage-logo-square.png';
async function frameBitmap(s) {
  let frame = s.frame;
  if (s.kind === 'outro' && s.outroStyle && s.outroStyle !== 'logo') {
    try {
      const res = await fetch(OUTRO_LOGO_URL);
      if (res.ok) frame = await res.blob();
    } catch (e) { console.warn('[quickpost] outro logo fetch failed; using the saved card', e); }
  }
  if (!(frame instanceof Blob)) return null;
  try { return await createImageBitmap(frame); } catch (e) {
    console.error('[quickpost] could not decode a frame', e);
    return null;
  }
}

function drawSlides() {
  const { rec, bitmaps, flags } = current;
  const opts = composeOptionsFor(rec);
  const frag = document.createDocumentFragment();
  const dots = document.createDocumentFragment();
  (rec.slides || []).forEach((s, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'relative flex-none snap-center overflow-hidden rounded-xl bg-black';
    wrap.style.width = 'min(calc(100vw - 3.5rem), 26rem)';
    const cvs = document.createElement('canvas');
    cvs.className = 'block h-auto w-full';
    if (bitmaps[i]) {
      composeToCanvas(cvs, bitmaps[i], s.caption || '', {
        ...opts, scale: PREVIEW_SCALE, fontScale: s.fontScale || 1, kind: s.kind,
        adjust: s.adjust, stampNudge: clampStampNudge(s.stampNudge), captionStyle: 'pills',
      });
    }
    wrap.appendChild(cvs);
    if (flags[i]) wrap.insertAdjacentHTML('beforeend', '<span class="absolute left-2 top-2 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold text-neutral-950">check frame</span>');
    frag.appendChild(wrap);
    const dot = document.createElement('li');
    dot.className = `h-1.5 w-1.5 rounded-full ${flags[i] ? 'bg-amber-400' : 'bg-neutral-700'}`;
    dots.appendChild(dot);
  });
  els.slides.replaceChildren(frag);
  els.dots.replaceChildren(dots);
  onSlideScroll();
}

function onSlideScroll() {
  if (!current) return;
  const first = els.slides.firstElementChild;
  if (!first) return;
  const step = first.getBoundingClientRect().width + 12;
  const i = Math.min(current.rec.slides.length - 1, Math.max(0, Math.round(els.slides.scrollLeft / step)));
  els.slideCount.textContent = `Slide ${i + 1} of ${current.rec.slides.length}`;
  els.slideFlag.classList.toggle('hidden', !current.flags[i]);
  [...els.dots.children].forEach((d, k) => {
    d.classList.toggle('bg-white', k === i);
    d.classList.toggle('scale-150', k === i);
  });
}
els.slides.addEventListener('scroll', () => requestAnimationFrame(onSlideScroll), { passive: true });

function fillDetails() {
  const { rec } = current;
  const songs = songsFor(rec);
  els.songsWrap.classList.toggle('hidden', !songs.length);
  els.songs.replaceChildren(...songs.map((s) => {
    const li = document.createElement('li');
    li.className = 'flex items-start gap-3';
    li.innerHTML = `
      <span class="min-w-0 flex-1 text-sm leading-snug">
        <span class="font-semibold text-neutral-100">${esc(s.title)}</span>${s.artist ? ` <span class="text-neutral-400">${esc(s.artist)}</span>` : ''}
        ${s.why ? `<span class="mt-0.5 block text-[11px] text-neutral-500">${esc(s.why)}</span>` : ''}
      </span>
      <button class="flex-none rounded-lg border border-neutral-700 px-2.5 py-1.5 text-xs font-semibold text-neutral-200">Copy</button>`;
    const btn = li.querySelector('button');
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(songQuery(s)); btn.textContent = 'Copied'; }
      catch { btn.textContent = 'Copy failed'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
    return li;
  }));
  const copy = postCopyFor(rec);
  els.postTitle.value = copy.title;
  els.postDesc.value = copy.description;
}

let copyTimer = null;
function onCopyEdit() {
  if (!current) return;
  current.rec.postTitle = els.postTitle.value;
  current.rec.postDesc = els.postDesc.value;
  current.rec.postEdited = true;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => saveCurrent().catch((e) => console.error('[quickpost] caption save failed:', e)), 800);
}
els.postTitle.addEventListener('input', onCopyEdit);
els.postDesc.addEventListener('input', onCopyEdit);

async function saveCurrent() {
  if (!current) return;
  current.rec.updatedAt = Date.now();
  await putProject(current.rec);
}

function syncActions() {
  const { rec } = current;
  const status = statusOf(rec);
  const posted = status === 'posted';
  els.toggleReady.classList.toggle('hidden', posted);
  els.toggleReady.textContent = status === 'ready' ? 'Back to drafts' : 'Mark ready';
  const check = canPublish(rec);
  els.publish.disabled = publishing || posted || !check.ok;
  els.publishLabel.textContent = posted ? 'Posted' : isSignedIn() ? 'Post to TikTok' : 'Sign in to post';
  if (!publishing) {
    els.status.textContent = posted
      ? `Posted ${relativeTime(rec.postedAt || rec.updatedAt || 0, Date.now())}.`
      : !check.ok ? check.reason
        : flagsFor(rec) ? `${flagsFor(rec)} frame${flagsFor(rec) === 1 ? '' : 's'} marked to check — swipe through first.`
          : '';
  }
}

els.toggleReady.addEventListener('click', async () => {
  if (!current) return;
  current.rec.status = toggleReady(current.rec.status);
  try {
    await saveCurrent();
    syncActions();
    els.status.textContent = current.rec.status === 'ready' ? 'Marked ready.' : 'Back in drafts.';
  } catch (e) {
    console.error('[quickpost] status change failed:', e);
    els.status.textContent = 'Couldn’t save that — try again.';
  }
});

els.publish.addEventListener('click', async () => {
  if (!current || publishing) return;
  if (!isSignedIn()) { location.href = '/tik/?signin=1'; return; }
  const { rec, bitmaps } = current;
  const check = canPublish(rec);
  if (!check.ok) { els.status.textContent = check.reason; return; }
  publishing = true;
  syncActions();
  try {
    const slides = rec.slides.map((s, i) => ({ ...s, stampNudge: clampStampNudge(s.stampNudge), bitmap: bitmaps[i] }));
    if (slides.some((s) => !s.bitmap)) throw new Error('A frame is missing from this set — open it in the full studio.');
    const result = await publishSlideshow(slides, {
      ...composeOptionsFor(rec),
      ...postCopyFor(rec),
      onProgress: (m) => { els.status.textContent = m; },
    });
    if (result.status === 'FAILED') {
      console.error('[quickpost] TikTok post FAILED', result);
      throw new Error(result.failReason ? `TikTok rejected the post: ${result.failReason}` : 'TikTok reported a failure — check the app.');
    }
    rec.status = 'posted';
    rec.postedAt = Date.now();
    try { await saveCurrent(); } catch (e) {
      console.error('[quickpost] post-success save failed:', e);
    }
    els.done.classList.remove('hidden');
    els.done.scrollIntoView({ behavior: 'smooth', block: 'center' });
    els.status.textContent = result.status === 'SEND_TO_USER_INBOX' || result.status === 'PUBLISH_COMPLETE'
      ? 'Sent. Finish it in TikTok.'
      : 'Uploaded — TikTok is still processing it. Check your inbox shortly.';
  } catch (e) {
    console.error('[quickpost] publish failed:', e);
    if (e.reauth) { clearLocalToken(); els.signin.classList.remove('hidden'); }
    els.status.textContent = e.message;
  } finally {
    publishing = false;
    if (current) {
      const msg = els.status.textContent;
      syncActions();
      els.status.textContent = msg;
    }
  }
});

els.next.addEventListener('click', async () => {
  const { ready } = groupForQuickPost(await listProjects());
  const nextSet = ready.find((r) => r.id !== current?.rec.id);
  if (nextSet) openReview(nextSet.id);
  else history.back();
});

els.back.addEventListener('click', () => history.back());
window.addEventListener('popstate', () => {
  const m = location.hash.match(/^#set-(.+)$/);
  if (m) openReview(m[1], { push: false });
  else closeReview();
});

// ================= sync =================

onSyncStatus((st) => {
  const dot = { idle: 'bg-emerald-500', syncing: 'bg-amber-400 animate-pulse', error: 'bg-red-500', off: 'bg-neutral-600', unlinked: 'bg-red-500' }[st.state] || 'bg-neutral-600';
  els.syncDot.className = `h-1.5 w-1.5 rounded-full ${dot}`;
  els.syncText.textContent = st.state === 'syncing' ? (st.detail || 'Syncing…')
    : st.state === 'error' ? 'Sync failed'
      : st.state === 'unlinked' || st.state === 'off' ? 'Not linked' : '';
  if (st.state === 'error') console.warn('[quickpost] sync:', st.detail);
});

function startSync() {
  initSync({
    onRemoteChange: (ids) => {
      if (!current) renderHome();
      else if (ids.includes(current.rec.id)) els.status.textContent = 'This set was changed on another device.';
    },
  }).then(() => { if (!current) renderHome(); });
}

// ================= boot =================

captureLinkFromUrl();
const startAt = location.hash.match(/^#set-(.+)$/);
renderHome().then(() => { if (startAt) openReview(startAt[1], { push: false }); });
startSync();
