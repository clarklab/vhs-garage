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
  // File-icon layout: each clip renders as a small tile with the thumbnail
  // on top, title + duration below — like file icons on a desktop. Whole
  // tile is the click target. select-none on the tile prevents a stray
  // double-click from triggering Mac's "Look Up" dictionary popup. The ×
  // delete button and ▶ Uploaded badge are corner overlays on the thumb so
  // they don't crowd the label area.
  container.innerHTML = clips.map(clip => {
    const isUploaded = !!clip.youtubeUrl;
    const uploadedBadge = isUploaded
      ? `<a href="${clip.youtubeUrl}" target="_blank" class="absolute bottom-1 right-1 text-red-400 hover:text-red-300 bg-black/70 px-1 py-0.5 text-[9px] leading-none transition-colors" title="View on YouTube">▶</a>`
      : '';
    const tileClass = `library-card relative flex flex-col border border-white/15 ${onOpen ? 'cursor-pointer hover:border-white/40 hover:bg-white/5' : ''} transition-colors select-none`;
    return `
    <div class="${tileClass}" data-id="${clip.id}" data-filename="${clip.filename || ''}" ${onOpen ? `title="Click to open"` : ''}>
      <div class="relative aspect-[4/3] bg-[#141214] overflow-hidden flex items-center justify-center">
        ${clip.thumbnail ? `<img src="${clip.thumbnail}" class="w-full h-full object-cover pointer-events-none" alt="">` : '<span class="text-white/10 text-[10px] pointer-events-none">--</span>'}
        ${uploadedBadge}
        <button class="delete-clip absolute top-1 right-1 w-5 h-5 flex items-center justify-center bg-black/70 text-red-400/70 hover:text-red-400 hover:bg-black/90 text-sm leading-none transition-colors" data-id="${clip.id}" title="Delete">×</button>
      </div>
      <div class="px-1.5 py-1.5 min-w-0">
        <p class="text-white text-[11px] truncate leading-tight">${clip.title || 'Untitled'}</p>
        <p class="text-gray-500 text-[10px] truncate leading-tight">${formatDuration(clip.duration)}</p>
      </div>
    </div>
  `;
  }).join('');

  if (onOpen) {
    container.querySelectorAll('.library-card').forEach(el => {
      el.addEventListener('click', (e) => {
        // Inner action buttons handle their own click; don't double-fire open.
        if (e.target.closest('button, a')) return;
        onOpen(el.dataset.id, el.dataset.filename);
      });
    });
  }

  container.querySelectorAll('.copy-yt').forEach(btn => {
    btn.addEventListener('click', () => {
      const clip = clips.find(c => c.id === btn.dataset.id);
      if (clip) {
        navigator.clipboard.writeText(clipToYouTubeText(clip)).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'YT ░', 1500);
        });
      }
    });
  });

  container.querySelectorAll('.copy-json').forEach(btn => {
    btn.addEventListener('click', () => {
      const clip = clips.find(c => c.id === btn.dataset.id);
      if (clip) {
        navigator.clipboard.writeText(clipToJSON(clip)).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'JSON ░', 1500);
        });
      }
    });
  });

  container.querySelectorAll('.delete-clip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this clip from the catalog?')) {
        onDelete(btn.dataset.id);
      }
    });
  });

  if (onUpload) {
    container.querySelectorAll('.upload-clip').forEach(btn => {
      btn.addEventListener('click', () => onUpload(btn.dataset.id));
    });
  }
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
