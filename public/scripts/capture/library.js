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

export function renderLibrary(container, emptyMsg, clips, onDelete, onOpen) {
  if (!clips.length) {
    container.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }

  emptyMsg.classList.add('hidden');
  container.innerHTML = clips.map(clip => `
    <div class="border border-white/20 p-3 text-xs" data-id="${clip.id}">
      <div class="aspect-[4/3] bg-[#141214] mb-2 overflow-hidden flex items-center justify-center cursor-pointer open-clip hover:opacity-80 transition-opacity" data-id="${clip.id}" data-filename="${clip.filename || ''}" title="Open file">
        ${clip.thumbnail ? `<img src="${clip.thumbnail}" class="w-full h-full object-contain pointer-events-none" alt="">` : '<span class="text-white/10 pointer-events-none">No thumbnail</span>'}
      </div>
      <p class="text-white truncate mb-1">${clip.title}</p>
      <p class="text-gray-500">${new Date(clip.date).toLocaleDateString()} · ${formatDuration(clip.duration)} · ${formatLibSize(clip.fileSize)}</p>
      <p class="text-gray-600 truncate text-[10px] mt-1">${clip.filename || ''}</p>
      ${clip.sleeveFront ? '<p class="text-gray-500 mt-1">Sleeve: Front' + (clip.sleeveBack ? ' + Back' : '') + '</p>' : ''}
      <button class="delete-clip text-red-400/50 hover:text-red-400 mt-2 transition-colors" data-id="${clip.id}">Delete</button>
    </div>
  `).join('');

  container.querySelectorAll('.open-clip').forEach(el => {
    el.addEventListener('click', () => {
      if (onOpen) onOpen(el.dataset.id, el.dataset.filename);
    });
  });

  container.querySelectorAll('.delete-clip').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Delete this clip from the catalog?')) {
        onDelete(btn.dataset.id);
      }
    });
  });
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
