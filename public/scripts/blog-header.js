// Blog header behavior: dropdown wiring (Open / Categories), mobile
// drawer toggle, and live search powered by Fuse.js. Search loads its
// index lazily on first focus to keep the initial page weight low —
// no fetch happens until the user actually engages with search.

import Fuse from '/vendor/fuse/fuse.basic.min.mjs';

// ---------- Dropdown menu wiring ----------

function wireDropdowns() {
  const openTrigger = document.getElementById('bh-open-trigger');
  const catTrigger  = document.getElementById('bh-cat-trigger');
  if (!window.ToolbarMenu) return; // toolbar-menu.js not loaded — nothing to wire

  if (openTrigger) {
    openTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      window.ToolbarMenu.open(openTrigger, [
        { label: 'All Posts',         href: '/blog' },
        { label: 'VHS Garage Gear',   href: '/gear' },
        { label: 'Places',            href: '/places' },
        { label: 'Videos',            href: '/blog/videos' },
      ]);
    });
  }

  if (catTrigger) {
    catTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      window.ToolbarMenu.open(catTrigger, [
        { label: 'Tapes',       href: '/blog/category/tapes' },
        { label: 'Hardware',    href: '/blog/category/hardware' },
        { label: 'Guides',      href: '/blog/category/guides' },
        { label: 'Collections', href: '/blog/category/collections' },
      ]);
    });
  }
}

// ---------- Mobile drawer ----------

function wireMobileDrawer() {
  const toggle = document.getElementById('bh-mobile-toggle');
  const drawer = document.getElementById('bh-mobile-drawer');
  if (!toggle || !drawer) return;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden', open);
    toggle.setAttribute('aria-expanded', String(!open));
  });

  // Close drawer on outside click / Esc.
  document.addEventListener('click', (e) => {
    if (drawer.classList.contains('hidden')) return;
    if (drawer.contains(e.target) || toggle.contains(e.target)) return;
    drawer.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      drawer.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

// ---------- Live search ----------

let fuseIndex = null;
let fuseLoading = null;

async function loadFuseIndex() {
  if (fuseIndex) return fuseIndex;
  if (fuseLoading) return fuseLoading;
  fuseLoading = (async () => {
    try {
      const res = await fetch('/blog-search-index.json');
      const data = await res.json();
      fuseIndex = new Fuse(data, {
        keys: [
          { name: 'title',       weight: 3 },
          { name: 'description', weight: 2 },
          { name: 'categories',  weight: 1.5 },
          { name: 'body',        weight: 1 },
        ],
        threshold: 0.4,        // 0=perfect, 1=anything; 0.4 is forgiving
        ignoreLocation: true,  // match anywhere in the field, not just near start
        minMatchCharLength: 2,
      });
      return fuseIndex;
    } catch (e) {
      console.warn('[blog-search] failed to load index:', e);
      return null;
    } finally {
      fuseLoading = null;
    }
  })();
  return fuseLoading;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Pull a short snippet from the body around the matched term so results
// have visual context. If the term isn't found in the body (matched
// against title/description), fall back to the description.
function snippetFor(post, query) {
  const body = post.body || '';
  if (!query) return post.description || '';
  const lower = body.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return post.description || (body.slice(0, 140) + (body.length > 140 ? '…' : ''));
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + query.length + 80);
  const before = start > 0 ? '…' : '';
  const after  = end < body.length ? '…' : '';
  return before + body.slice(start, end) + after;
}

function positionResultsPanel(panel, anchor) {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  panel.style.top = (r.bottom + 4) + 'px';
  panel.style.right = (window.innerWidth - r.right) + 'px';
  panel.style.minWidth = Math.max(320, r.width + 40) + 'px';
}

function renderResults(panel, query, results) {
  if (!query) {
    panel.innerHTML = `<p class="px-4 py-3 text-white/40 text-[11px]">Type to search…</p>`;
    panel.classList.remove('hidden');
    return;
  }
  if (!results.length) {
    panel.innerHTML = `<p class="px-4 py-3 text-white/40 text-[11px]">No matches for "${escapeHtml(query)}"</p>`;
    panel.classList.remove('hidden');
    return;
  }

  const top = results.slice(0, 8);
  const more = results.length - top.length;
  const rows = top.map(({ item }, i) => {
    const slug = item.slug;
    const img = item.image
      ? `<img src="${escapeHtml(item.image)}" alt="" class="w-12 h-12 object-cover bg-black border border-white/10 shrink-0" loading="lazy" />`
      : `<div class="w-12 h-12 flex items-center justify-center bg-black border border-white/10 text-white/15 text-[10px] shrink-0">░ ▓ ░</div>`;
    const cats = (item.categories || []).map(c =>
      `<span class="text-[8px] uppercase tracking-widest text-white/35">${escapeHtml(c)}</span>`
    ).join(' · ');
    return `
      <a href="/blog/${slug}" data-result-row data-row-index="${i}"
         class="bh-result flex gap-3 px-3 py-2.5 hover:bg-red-600 hover:text-white border-b border-white/8 last:border-b-0">
        ${img}
        <div class="min-w-0 flex-1">
          <p class="text-white text-[12px] mb-0.5 truncate">${escapeHtml(item.title)}</p>
          <p class="text-white/50 text-[10px] line-clamp-2 leading-snug">${escapeHtml(snippetFor(item, query))}</p>
          ${cats ? `<p class="mt-1">${cats}</p>` : ''}
        </div>
      </a>`;
  }).join('');

  const seeMore = more > 0
    ? `<div class="px-3 py-2 text-[10px] text-white/40 uppercase tracking-widest border-t border-white/10">Showing top 8 of ${results.length} matches</div>`
    : '';

  panel.innerHTML = rows + seeMore;
  panel.classList.remove('hidden');
}

function clearActive(panel) {
  panel.querySelectorAll('.bh-result.is-active')
    .forEach((el) => el.classList.remove('is-active', 'bg-red-600', 'text-white'));
}
function setActive(panel, idx) {
  clearActive(panel);
  const rows = panel.querySelectorAll('.bh-result');
  if (!rows.length) return;
  const safe = ((idx % rows.length) + rows.length) % rows.length;
  const row = rows[safe];
  row.classList.add('is-active', 'bg-red-600', 'text-white');
  // Make sure it's visible inside the scrollable panel.
  row.scrollIntoView({ block: 'nearest' });
  return safe;
}

function wireSearchInput(input, panel) {
  if (!input || !panel) return;
  let activeIdx = -1;

  const runSearch = async () => {
    const q = input.value.trim();
    if (!q) { panel.classList.add('hidden'); activeIdx = -1; return; }
    const fuse = await loadFuseIndex();
    if (!fuse) { panel.classList.add('hidden'); return; }
    const results = fuse.search(q);
    positionResultsPanel(panel, input);
    renderResults(panel, q, results);
    activeIdx = -1;
  };

  input.addEventListener('focus', () => {
    loadFuseIndex(); // warm the index even before they type
    if (input.value.trim()) runSearch();
  });
  input.addEventListener('input', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = setActive(panel, activeIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = setActive(panel, activeIdx - 1);
    } else if (e.key === 'Enter') {
      const rows = panel.querySelectorAll('.bh-result');
      const target = activeIdx >= 0 ? rows[activeIdx] : rows[0];
      if (target) { e.preventDefault(); window.location.assign(target.href); }
    } else if (e.key === 'Escape') {
      panel.classList.add('hidden');
      input.blur();
    }
  });

  // Keep the panel positioned correctly on resize / scroll.
  window.addEventListener('resize', () => {
    if (!panel.classList.contains('hidden')) positionResultsPanel(panel, input);
  });
  window.addEventListener('scroll', () => {
    if (!panel.classList.contains('hidden')) positionResultsPanel(panel, input);
  }, true);

  // Close on outside click.
  document.addEventListener('click', (e) => {
    if (panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || input.contains(e.target)) return;
    panel.classList.add('hidden');
  });
}

// ---------- Cmd+K / Ctrl+K to focus the search input ----------

function wireSearchShortcut(desktopInput, mobileInput) {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      // Prefer the visible one. Desktop is hidden on mobile via `hidden md:flex`
      // — we check offsetParent to detect "actually visible".
      const target = (desktopInput && desktopInput.offsetParent) ? desktopInput : mobileInput;
      if (target) { target.focus(); target.select(); }
    }
  });
}

// ---------- Boot ----------

function init() {
  wireDropdowns();
  wireMobileDrawer();
  const desktopInput = document.getElementById('bh-search-input');
  const mobileInput  = document.getElementById('bh-search-input-mobile');
  const panel        = document.getElementById('bh-search-results');
  wireSearchInput(desktopInput, panel);
  wireSearchInput(mobileInput,  panel);
  wireSearchShortcut(desktopInput, mobileInput);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
