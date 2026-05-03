// Shared toolbar drop-down menu — System 7 / Win 3.1 chiseled-bevel
// menus that anchor to a trigger button. Used by the capture page top
// bar and the blog header. Markup pattern:
//
//   <button data-toolbar-trigger ...>Menu Name</button>
//   <div id="toolbar-menu" class="toolbar-menu hidden"></div>
//
// One shared #toolbar-menu host per page; populated on each open with
// the relevant items. Item shape:
//   { label, checked?, disabled?, separator?, header?, href?, onClick? }
// Pass `href` for plain-link items (rendered as <a>); pass `onClick`
// for action items (rendered as <button>). Both can be on the same
// menu and mix freely.
//
// Dismissers: outside-click, Esc, scroll. All wired once at load.

(function () {
  let openForTriggerEl = null;

  function ensureHost() {
    let host = document.getElementById('toolbar-menu');
    if (host) return host;
    // Auto-create the host if a page didn't include it explicitly.
    host = document.createElement('div');
    host.id = 'toolbar-menu';
    host.className = 'toolbar-menu hidden';
    document.body.appendChild(host);
    return host;
  }

  function open(triggerEl, items) {
    const host = ensureHost();
    if (!triggerEl) return;
    if (openForTriggerEl === triggerEl) { close(); return; } // toggle
    close();

    host.innerHTML = '';
    items.forEach((it) => {
      if (it.separator) {
        const sep = document.createElement('div');
        sep.className = 'toolbar-menu-divider';
        host.appendChild(sep);
        return;
      }
      if (it.header) {
        const h = document.createElement('div');
        h.className = 'toolbar-menu-header';
        h.textContent = it.label;
        host.appendChild(h);
        return;
      }
      const isLink = !!it.href;
      const el = document.createElement(isLink ? 'a' : 'button');
      if (isLink) {
        el.href = it.href;
        if (it.target) el.target = it.target;
        if (it.rel) el.rel = it.rel;
      } else {
        el.type = 'button';
      }
      el.className = 'toolbar-menu-item';
      if (it.checked)  el.classList.add('is-checked');
      if (it.disabled) el.classList.add('is-disabled');
      el.textContent = it.label;
      if (!it.disabled) {
        el.addEventListener('click', (e) => {
          // For links: let the navigation happen, just close the menu.
          // For buttons: run the handler after the menu visually closes
          // so any modal/file picker spawned by it doesn't feel abrupt.
          if (isLink) { close(); return; }
          if (e) { e.preventDefault(); e.stopPropagation(); }
          close();
          if (typeof it.onClick === 'function') {
            requestAnimationFrame(() => it.onClick());
          }
        });
      }
      host.appendChild(el);
    });

    host.classList.remove('hidden');
    const t = triggerEl.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const left = Math.min(t.left, W - w - 4);
    const top  = Math.min(t.bottom, H - h - 4);
    host.style.left = Math.max(4, left) + 'px';
    host.style.top  = Math.max(4, top)  + 'px';

    triggerEl.classList.add('is-active');
    openForTriggerEl = triggerEl;
  }

  function close() {
    const host = document.getElementById('toolbar-menu');
    if (host) host.classList.add('hidden');
    if (openForTriggerEl) {
      openForTriggerEl.classList.remove('is-active');
      openForTriggerEl = null;
    }
  }

  // Global dismissers — outside click / Esc / scroll. We do NOT close on a
  // click that originated inside a trigger (the trigger's own click handler
  // decides whether to toggle vs. swap menus).
  document.addEventListener('click', (e) => {
    const host = document.getElementById('toolbar-menu');
    if (!host || host.classList.contains('hidden')) return;
    if (host.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.toolbar-trigger')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  document.addEventListener('scroll', (e) => {
    const host = document.getElementById('toolbar-menu');
    if (!host || host.classList.contains('hidden')) return;
    if (host.contains(e.target)) return;
    close();
  }, true);

  window.ToolbarMenu = { open: open, close: close };
})();
