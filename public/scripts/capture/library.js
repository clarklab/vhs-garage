const CATALOG_KEY = 'vhsg_catalog';

// Library-tile thumbnails live in localStorage alongside the catalog, so they
// have to stay tiny. 320px / JPEG-0.6 keeps a typical frame under ~15KB even
// from a 1080p source. Heavier image data (full-res YT thumbnails, sleeves)
// must never be persisted into the catalog itself — see saveClips' quota
// recovery and the `HEAVY_FIELDS` list below.
const MAX_THUMB_DIM = 320;
const THUMB_QUALITY = 0.6;

// Fields that can be evicted from the catalog under quota pressure. Sleeves
// are recoverable from disk (`{basename}_front.jpg` / `_back.jpg`) and the
// full-res YT thumbnail can be re-picked from the player; the small
// `thumbnail` is the last to go because dropping it leaves an empty tile.
const HEAVY_FIELDS = ['sleeveFront', 'sleeveBack', 'ytThumbnailDataUrl', 'thumbnail'];

export function getClips() {
  try {
    return JSON.parse(localStorage.getItem(CATALOG_KEY) || '[]');
  } catch {
    return [];
  }
}

function isQuotaError(e) {
  return e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
}

// Persist clips, recovering from QuotaExceededError by stripping heavy image
// fields from the oldest clips first. Mutates `clips` in place when a trim
// happens so the caller's array reflects what actually got saved.
function saveClips(clips) {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(clips));
    return true;
  } catch (e) {
    if (!isQuotaError(e)) throw e;
  }

  const trimmed = clips.map(c => ({ ...c }));
  for (const field of HEAVY_FIELDS) {
    // Strip oldest-first (clips are stored newest-first via unshift).
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i][field] == null) continue;
      delete trimmed[i][field];
      try {
        localStorage.setItem(CATALOG_KEY, JSON.stringify(trimmed));
        clips.splice(0, clips.length, ...trimmed);
        return true;
      } catch (e) {
        if (!isQuotaError(e)) throw e;
      }
    }
  }
  console.error('[catalog] save failed: quota exhausted even after trim');
  return false;
}

export function addClip(entry) {
  const clips = getClips();
  clips.unshift(entry);
  saveClips(clips);
}

export function updateClip(id, fields) {
  const clips = getClips();
  const idx = clips.findIndex(c => c.id === id);
  if (idx !== -1) {
    clips[idx] = { ...clips[idx], ...fields };
    saveClips(clips);
  }
}

export function deleteClip(id) {
  const clips = getClips().filter(c => c.id !== id);
  saveClips(clips);
}

// 6-char random suffix on top of Date.now() ensures two clips created
// inside the same millisecond (common with bulk-duplicate, "make 3
// trailers in a row") get distinct IDs. Collision odds at this scale
// are effectively zero. Time prefix is preserved so IDs remain
// roughly sortable by creation time when debugging.
function generateClipId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return 'clip_' + Date.now() + '_' + rand;
}

export function createClipEntry(title, filename, duration, fileSize, bitrate) {
  return {
    id: generateClipId(),
    title: title || 'Untitled',
    filename,
    date: new Date().toISOString(),
    duration,
    fileSize,
    bitrate,
    thumbnail: null,
    sleeveFront: null,
    sleeveBack: null,
    metadata: { description: '', tags: [], notes: '' },
    status: 'captured',
    youtubeUrl: null,
    // True when this clip was produced via Shorts mode (vertical 9:16
    // crop). Drives the library tile badge and downstream UI hints.
    // Always false on fresh recording / duplicate; set true only by
    // the Shorts encoder's persist step.
    isShort: false,
  };
}

export function captureThumbnail(videoElement) {
  const canvas = document.getElementById('capture-canvas');
  const sw = videoElement.videoWidth || 320;
  const sh = videoElement.videoHeight || 240;
  const scale = Math.min(1, MAX_THUMB_DIM / sw, MAX_THUMB_DIM / sh);
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', THUMB_QUALITY);
}

// Downscale a JPEG data URL into a library-tile-sized thumbnail. Used when
// the user picks a YouTube thumbnail from the player (full-res frame) and
// we need a small companion image to show in the library grid. Returns the
// original on failure so callers don't have to handle errors.
export async function shrinkDataUrlForCatalog(dataUrl) {
  if (!dataUrl) return dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image decode failed'));
      i.src = dataUrl;
    });
    const sw = img.naturalWidth || MAX_THUMB_DIM;
    const sh = img.naturalHeight || MAX_THUMB_DIM;
    const scale = Math.min(1, MAX_THUMB_DIM / sw, MAX_THUMB_DIM / sh);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', THUMB_QUALITY);
  } catch {
    return dataUrl;
  }
}

export async function exportCatalog(directoryHandle) {
  const clips = getClips();
  const json = JSON.stringify(clips, null, 2);
  const fileHandle = await directoryHandle.getFileHandle('catalog.json', { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(json);
  await writable.close();
}

function clipToYouTubeText(clip) {
  const lines = [];
  if (clip.description) lines.push(clip.description);
  lines.push('');
  lines.push('Home video captured from VHS tape.');
  lines.push('');
  if (clip.year) lines.push('Year: ' + clip.year);
  if (clip.tape) lines.push('Tape: ' + clip.tape);
  if (clip.distributor) lines.push('Distributor: ' + clip.distributor);
  if (clip.tapeLength) lines.push('Tape Length: ' + clip.tapeLength);
  if (clip.recordingSpeed) lines.push('Recording Speed: ' + clip.recordingSpeed);
  if (clip.condition) lines.push('Condition: ' + clip.condition);
  if (clip.tags) lines.push('\nTags: ' + clip.tags);
  if (clip.cassetteNotes) lines.push('\n' + clip.cassetteNotes);
  lines.push('');
  lines.push('Captured with VHS Garage');
  lines.push('https://vhsgarage.com');
  return 'TITLE: ' + (clip.title || 'Untitled') + '\n\n---\n\n' + lines.join('\n');
}

function clipToJSON(clip) {
  const obj = { ...clip };
  delete obj.thumbnail;
  delete obj.sleeveFront;
  delete obj.sleeveBack;
  return JSON.stringify(obj, null, 2);
}

// renderLibrary now optionally takes a selection-mode bundle. When
// `selection.mode` is true, every un-uploaded tile gets a checkbox
// indicator at the top-left and the click handler toggles selection
// instead of opening the clip. Uploaded tiles dim out and ignore clicks.
// Selection cap is enforced by the caller's onToggleSelect — if it
// returns false (cap hit on a new selection), we don't visually toggle.
export function renderLibrary(container, emptyMsg, clips, onDelete, onOpen, onUpload, onMarkUnuploaded, onDuplicate, selection) {
  if (!clips.length) {
    container.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }

  emptyMsg.classList.add('hidden');
  const selectionMode = !!(selection && selection.mode);
  const selectedIds = (selection && selection.selectedIds) || new Set();
  const onToggleSelect = (selection && selection.onToggleSelect) || null;

  // File-icon layout: thumbnail on top, two-line title + duration beneath.
  // Whole tile is the click target. No inline delete button — destructive
  // actions live in the native-style right-click context menu (Open Clip /
  // Delete). select-none on the tile prevents a stray double-click from
  // triggering Mac's "Look Up" dictionary popup.
  //
  // Uploaded clips get a red pill badge in the top-right with the YouTube
  // icon from @hackernoon/pixel-icon-library (brands/youtube.svg). Clicking
  // the pill opens the saved clip.youtubeUrl in a new tab.
  container.innerHTML = clips.map(clip => {
    const isUploaded = !!clip.youtubeUrl;
    const isSelected = selectedIds.has(clip.id);
    const uploadedBadge = isUploaded
      ? `<a href="${clip.youtubeUrl}" target="_blank" rel="noopener" class="library-yt-pill absolute top-1 right-1 inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold uppercase tracking-wider rounded-full transition-colors" title="View on YouTube">
           <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="m22,7v-2h-2v-1H4v1h-2v2h-1v10h1v2h2v1h16v-1h2v-2h1V7h-1Zm-10,8h-2v-6h2v1h2v1h2v2h-2v1h-2v1Z"/></svg>
           <span>Uploaded</span>
         </a>`
      : '';
    // Shorts badge — small pixel-style 9:16 frame in the top-left
    // corner. Marks clips that came out of Shorts mode (vertical
    // crop, ≤60s). Sits opposite the YouTube pill (right side) so
    // both can show at once on uploaded shorts. Pure presentation —
    // doesn't hijack clicks (pointer-events ignored at the parent).
    const shortsBadge = clip.isShort
      ? `<span class="library-shorts-pill absolute top-1 left-1 inline-flex items-center gap-1 px-1.5 py-0.5 bg-black/80 border border-white/30 text-white text-[9px] font-bold uppercase tracking-wider" title="Vertical Short">
           <svg class="w-2.5 h-3 fill-current" viewBox="0 0 9 16" aria-hidden="true">
             <path d="M0 0h9v1H0zM0 15h9v1H0zM0 1h1v14H0zM8 1h1v14H8z"/>
             <polygon points="3 6 3 10 4 10 4 11 5 11 5 10 6 10 6 9 7 9 7 7 6 7 6 6 5 6 5 5 4 5 4 6"/>
           </svg>
           <span>Short</span>
         </span>`
      : '';
    // Selection-mode checkbox indicator. Only on un-uploaded tiles —
    // uploaded ones can't be re-uploaded (and the YouTube pill already
    // tells you what's up).
    const checkboxIndicator = (selectionMode && !isUploaded)
      ? `<span class="library-checkbox ${isSelected ? 'is-checked' : ''}">${isSelected ? '✓' : ''}</span>`
      : '';
    const cursorClass = selectionMode
      ? (isUploaded ? 'cursor-default' : 'cursor-pointer')
      : (onOpen ? 'cursor-pointer hover:border-white/40 hover:bg-white/5' : '');
    const tileExtra = [
      selectionMode && isUploaded ? 'is-uploaded-in-selection' : '',
      isSelected ? 'is-selected' : '',
    ].filter(Boolean).join(' ');
    const tileClass = `library-card relative flex flex-col border border-white/15 ${cursorClass} ${tileExtra} transition-colors select-none`.trim();
    const titleAttr = selectionMode
      ? (isUploaded ? 'Already uploaded — exit selection mode to open' : 'Click to toggle selection')
      : (onOpen ? 'Click to open · right-click for options' : 'Right-click for options');
    return `
    <div class="${tileClass}" data-id="${clip.id}" data-filename="${clip.filename || ''}" data-uploaded="${isUploaded ? '1' : '0'}" title="${titleAttr}">
      <div class="relative aspect-[4/3] bg-[#141214] overflow-hidden flex items-center justify-center">
        ${clip.thumbnail ? `<img src="${clip.thumbnail}" class="w-full h-full object-cover pointer-events-none" alt="">` : '<span class="text-white/10 text-[10px] pointer-events-none">--</span>'}
        ${checkboxIndicator}
        ${shortsBadge}
        ${uploadedBadge}
      </div>
      <div class="px-1.5 py-1.5 min-w-0">
        <p class="text-white text-[11px] leading-tight line-clamp-2" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;">${clip.title || 'Untitled'}</p>
        <p class="text-gray-500 text-[10px] truncate leading-tight mt-0.5">${formatDuration(clip.duration)}</p>
      </div>
    </div>
  `;
  }).join('');

  // Click + right-click handlers. In selection mode, click toggles the
  // checkbox for un-uploaded tiles; right-click context menu (Open Clip /
  // Delete) is suppressed since those actions don't make sense mid-batch.
  container.querySelectorAll('.library-card').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return; // inner controls handle themselves
      if (selectionMode) {
        const isUploaded = el.dataset.uploaded === '1';
        if (isUploaded) return; // can't select uploaded clips
        if (onToggleSelect) onToggleSelect(el.dataset.id);
        return;
      }
      if (onOpen) onOpen(el.dataset.id, el.dataset.filename);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (selectionMode) return; // suppress in selection mode
      const isUploaded = el.dataset.uploaded === '1';
      showLibraryContextMenu(e.clientX, e.clientY, el.dataset.id, el.dataset.filename, onOpen, onDelete, isUploaded ? onMarkUnuploaded : null, onDuplicate);
    });
  });
}

// Position the shared context menu at the click point and bind one-shot
// handlers for Open Clip + Delete. Clamps to viewport so right-clicking
// near the edge doesn't push the menu off-screen.
function showLibraryContextMenu(x, y, clipId, filename, onOpen, onDelete, onMarkUnuploaded, onDuplicate) {
  const menu = document.getElementById('library-context-menu');
  if (!menu) return;
  const openBtn = document.getElementById('lib-ctx-open');
  const deleteBtn = document.getElementById('lib-ctx-delete');
  const markUnuploadedBtn = document.getElementById('lib-ctx-mark-unuploaded');
  const duplicateBtn = document.getElementById('lib-ctx-duplicate');

  if (openBtn) {
    openBtn.disabled = !onOpen;
    openBtn.classList.toggle('opacity-30', !onOpen);
    openBtn.classList.toggle('cursor-not-allowed', !onOpen);
    openBtn.onclick = onOpen ? () => { hideLibraryContextMenu(); onOpen(clipId, filename); } : null;
  }
  // Duplicate — always available when a duplicator is wired (which it
  // is whenever a save folder is mounted). Greys out otherwise.
  if (duplicateBtn) {
    const enabled = !!onDuplicate;
    duplicateBtn.disabled = !enabled;
    duplicateBtn.classList.toggle('opacity-30', !enabled);
    duplicateBtn.classList.toggle('cursor-not-allowed', !enabled);
    duplicateBtn.title = enabled
      ? 'Copy this clip to a new entry with the same metadata, ready to trim or edit independently'
      : 'Pick a save folder to enable Duplicate';
    duplicateBtn.onclick = enabled ? () => {
      hideLibraryContextMenu();
      onDuplicate(clipId);
    } : null;
  }
  // Mark not uploaded — only meaningful when the clip currently HAS a
  // youtubeUrl. Caller passes null when the clip isn't uploaded so we
  // dim the option (with an explanatory tooltip) rather than hide it
  // entirely; that way the menu shape is stable across right-clicks.
  if (markUnuploadedBtn) {
    const enabled = !!onMarkUnuploaded;
    markUnuploadedBtn.disabled = !enabled;
    markUnuploadedBtn.classList.toggle('opacity-30', !enabled);
    markUnuploadedBtn.classList.toggle('cursor-not-allowed', !enabled);
    markUnuploadedBtn.title = enabled
      ? 'Clear the YouTube link so this clip can be re-queued for upload'
      : 'This clip has no YouTube link to clear';
    markUnuploadedBtn.onclick = enabled ? () => {
      hideLibraryContextMenu();
      onMarkUnuploaded(clipId);
    } : null;
  }
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      hideLibraryContextMenu();
      if (onDelete) onDelete(clipId);
    };
  }

  // Clamp into viewport before showing
  menu.classList.remove('hidden');
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(x, W - w - 4);
  const top = Math.min(y, H - h - 4);
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';
}

function hideLibraryContextMenu() {
  const menu = document.getElementById('library-context-menu');
  if (menu) menu.classList.add('hidden');
}

// Wire the global context-menu dismissers (outside-click, scroll, Escape)
// once at module load so we don't stack listeners across renderLibrary calls.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('library-context-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (!menu.contains(e.target)) hideLibraryContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideLibraryContextMenu();
  });
  document.addEventListener('scroll', hideLibraryContextMenu, true);
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatLibSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}
