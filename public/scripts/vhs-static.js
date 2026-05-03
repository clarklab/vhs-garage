// Reusable VHS static effect — drop on any page with a single tag pair.
//
// Markup:
//   <canvas data-vhs-static class="absolute inset-0 w-full h-full"
//           style="image-rendering: pixelated; opacity: 0.4;"></canvas>
//   <script src="/scripts/vhs-static.js"></script>
//
// Programmatic use (when you're conditionally showing the canvas, e.g. a
// modal that opens/closes):
//   VhsStatic.start(canvasEl);
//   VhsStatic.stop(canvasEl);
//
// Performance: 320x180 buffer, alpha set once at init, RGB-only writes per
// frame via putImageData with a Uint8ClampedArray (the fast path; setting
// fillStyle to rgba() strings tanks fps because of string parsing). Auto-
// pauses when the canvas scrolls out of view via IntersectionObserver,
// so a static panel low on the page doesn't burn cycles before the user
// reaches it.

(function () {
  const W = 320;
  const H = 180;
  const states = new WeakMap(); // canvas → { ctx, imageData, rafId }

  function ensure(canvas) {
    let s = states.get(canvas);
    if (s) return s;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(W, H);
    const data = imageData.data;
    // Opaque alpha set once — the tick loop only has to touch the RGB bytes.
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    s = { ctx, imageData, rafId: 0 };
    states.set(canvas, s);
    return s;
  }

  function tick(canvas) {
    const s = states.get(canvas);
    if (!s) return;
    const data = s.imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
    s.ctx.putImageData(s.imageData, 0, 0);
    s.rafId = requestAnimationFrame(function () { tick(canvas); });
  }

  function start(canvas) {
    if (!canvas) return;
    const s = ensure(canvas);
    if (s.rafId) return; // already running
    tick(canvas);
  }

  function stop(canvas) {
    const s = states.get(canvas);
    if (!s || !s.rafId) return;
    cancelAnimationFrame(s.rafId);
    s.rafId = 0;
  }

  // Auto-init: any canvas with the [data-vhs-static] attribute starts on
  // load. IntersectionObserver pauses each one when scrolled out of view
  // so a static panel halfway down the page doesn't run before the user
  // gets there. threshold:0.01 = restart as soon as 1% is visible.
  function autoInit() {
    const canvases = document.querySelectorAll('canvas[data-vhs-static]');
    if (!canvases.length) return;
    const supportsIO = 'IntersectionObserver' in window;
    canvases.forEach(function (canvas) {
      if (supportsIO) {
        new IntersectionObserver(function (entries) {
          for (const e of entries) {
            if (e.isIntersecting) start(e.target);
            else stop(e.target);
          }
        }, { threshold: 0.01 }).observe(canvas);
      } else {
        // No IO — just always-on.
        start(canvas);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  window.VhsStatic = { start: start, stop: stop };
})();
