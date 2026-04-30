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
  // Compact row layout: small thumbnail | title + date/duration/size | status +
  // small action buttons. Whole row is the click target. select-none on the
  // row prevents a stray double-click from highlighting text and triggering
  // Mac's "Look Up" dictionary popup.
  container.innerHTML = clips.map(clip => {
    const hasFile = !!clip.filename;
    const canUpload = onUpload && hasFile && !clip.youtubeUrl;
    const uploadedMarker = clip.youtubeUrl
      ? `<a href="${clip.youtubeUrl}" target="_blank" class="text-red-400/70 hover:text-red-400 transition-colors text-[10px]" title="View on YouTube">▶ Uploaded</a>`
      : '';
    const rowClass = `library-card flex items-center gap-3 p-2 border border-white/10 ${onOpen ? 'cursor-pointer hover:border-white/30 hover:bg-white/5' : ''} transition-colors select-none text-xs`;
    return `
    <div class="${rowClass}" data-id="${clip.id}" data-filename="${clip.filename || ''}" ${onOpen ? `title="Click to open in editor"` : ''}>
      <div class="w-16 h-12 bg-[#141214] flex-shrink-0 overflow-hidden flex items-center justify-center">
        ${clip.thumbnail ? `<img src="${clip.thumbnail}" class="w-full h-full object-cover pointer-events-none" alt="">` : '<span class="text-white/10 text-[9px] pointer-events-none">--</span>'}
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-white truncate">${clip.title || 'Untitled'}</p>
        <p class="text-gray-500 text-[10px] truncate">${new Date(clip.date).toLocaleDateString()} · ${formatDuration(clip.duration)} · ${formatLibSize(clip.fileSize)}</p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        ${uploadedMarker}
        ${canUpload ? `<button class="upload-clip text-red-400/60 hover:text-red-400 transition-colors text-[10px]" data-id="${clip.id}" title="Upload to YouTube">▶ Upload</button>` : ''}
        <button class="copy-yt text-white/30 hover:text-white/70 transition-colors text-[10px]" data-id="${clip.id}" title="Copy YouTube text">YT</button>
        <button class="copy-json text-white/30 hover:text-white/70 transition-colors text-[10px]" data-id="${clip.id}" title="Copy JSON">JSON</button>
        <button class="delete-clip text-red-400/50 hover:text-red-400 transition-colors text-base leading-none" data-id="${clip.id}" title="Delete">×</button>
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
