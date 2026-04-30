const CATALOG_KEY = 'vhsg_catalog';

export function getClips() {
  try {
    return JSON.parse(localStorage.getItem(CATALOG_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveClips(clips) {
  localStorage.setItem(CATALOG_KEY, JSON.stringify(clips));
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

export function createClipEntry(title, filename, duration, fileSize, bitrate) {
  return {
    id: 'clip_' + Date.now(),
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
  };
}

export function captureThumbnail(videoElement) {
  const canvas = document.getElementById('capture-canvas');
  canvas.width = videoElement.videoWidth || 320;
  canvas.height = videoElement.videoHeight || 240;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
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

export function renderLibrary(container, emptyMsg, clips, onDelete, onOpen, onUpload) {
  if (!clips.length) {
    container.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }

  emptyMsg.classList.add('hidden');
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
    const uploadedBadge = isUploaded
      ? `<a href="${clip.youtubeUrl}" target="_blank" rel="noopener" class="library-yt-pill absolute top-1 right-1 inline-flex items-center justify-center w-6 h-6 bg-red-600 hover:bg-red-500 text-white rounded-full transition-colors" title="View on YouTube">
           <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden="true"><path d="m22,7v-2h-2v-1H4v1h-2v2h-1v10h1v2h2v1h16v-1h2v-2h1V7h-1Zm-10,8h-2v-6h2v1h2v1h2v2h-2v1h-2v1Z"/></svg>
         </a>`
      : '';
    const tileClass = `library-card relative flex flex-col border border-white/15 ${onOpen ? 'cursor-pointer hover:border-white/40 hover:bg-white/5' : ''} transition-colors select-none`;
    return `
    <div class="${tileClass}" data-id="${clip.id}" data-filename="${clip.filename || ''}" ${onOpen ? `title="Click to open · right-click for options"` : 'title="Right-click for options"'}>
      <div class="relative aspect-[4/3] bg-[#141214] overflow-hidden flex items-center justify-center">
        ${clip.thumbnail ? `<img src="${clip.thumbnail}" class="w-full h-full object-cover pointer-events-none" alt="">` : '<span class="text-white/10 text-[10px] pointer-events-none">--</span>'}
        ${uploadedBadge}
      </div>
      <div class="px-1.5 py-1.5 min-w-0">
        <p class="text-white text-[11px] leading-tight line-clamp-2" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;">${clip.title || 'Untitled'}</p>
        <p class="text-gray-500 text-[10px] truncate leading-tight mt-0.5">${formatDuration(clip.duration)}</p>
      </div>
    </div>
  `;
  }).join('');

  // Left-click opens the clip (when there's a folder picked); right-click
  // shows the native-style context menu with Open Clip + Delete.
  container.querySelectorAll('.library-card').forEach(el => {
    if (onOpen) {
      el.addEventListener('click', (e) => {
        // Inner buttons / links (e.g. ▶ Uploaded) handle their own click.
        if (e.target.closest('button, a')) return;
        onOpen(el.dataset.id, el.dataset.filename);
      });
    }
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showLibraryContextMenu(e.clientX, e.clientY, el.dataset.id, el.dataset.filename, onOpen, onDelete);
    });
  });
}

// Position the shared context menu at the click point and bind one-shot
// handlers for Open Clip + Delete. Clamps to viewport so right-clicking
// near the edge doesn't push the menu off-screen.
function showLibraryContextMenu(x, y, clipId, filename, onOpen, onDelete) {
  const menu = document.getElementById('library-context-menu');
  if (!menu) return;
  const openBtn = document.getElementById('lib-ctx-open');
  const deleteBtn = document.getElementById('lib-ctx-delete');

  if (openBtn) {
    openBtn.disabled = !onOpen;
    openBtn.classList.toggle('opacity-30', !onOpen);
    openBtn.classList.toggle('cursor-not-allowed', !onOpen);
    openBtn.onclick = onOpen ? () => { hideLibraryContextMenu(); onOpen(clipId, filename); } : null;
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
