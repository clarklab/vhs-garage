# Astro Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the VHS Garage static site from 3 standalone HTML files to an Astro project with shared layouts, proper Tailwind, and Netlify build — producing identical output.

**Architecture:** Astro static site generator with a shared Base.astro layout for meta/head, a Flicker.astro component for the bg image effect, and global.css for fonts/keyframes/Tailwind. Each page becomes a `.astro` file importing the layout. Assets move to `public/`.

**Tech Stack:** Astro 5.x, Tailwind CSS 4.x (via @astrojs/tailwind), Node 20, Netlify

---

### Task 1: Initialize Astro Project

**Files:**
- Create: `package.json`
- Create: `astro.config.mjs`
- Create: `tsconfig.json` (Astro default)

- [ ] **Step 1: Initialize Astro in the existing repo**

Run from repo root. Use the `--template minimal` flag and answer prompts:

```bash
npm create astro@latest . -- --template minimal --install --no-git
```

If the CLI complains about existing files, it will ask to proceed — say yes. This creates `package.json`, `astro.config.mjs`, `tsconfig.json`, and `src/` directory.

- [ ] **Step 2: Install Tailwind integration**

```bash
npx astro add tailwind --yes
```

This installs `@astrojs/tailwind` and `tailwindcss`, updates `astro.config.mjs` to include the integration.

- [ ] **Step 3: Verify astro.config.mjs**

Read `astro.config.mjs` and ensure it has the tailwind integration. It should look like:

```js
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  integrations: [tailwind()],
});
```

- [ ] **Step 4: Remove the template placeholder page**

Delete `src/pages/index.astro` if Astro created one — we'll write our own.

```bash
rm -f src/pages/index.astro
```

- [ ] **Step 5: Verify dev server starts**

```bash
npm run dev
```

Expected: Astro dev server starts on localhost:4321. It may show a 404 since there are no pages yet. Kill the server (Ctrl+C).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json astro.config.mjs tsconfig.json src/
git commit -m "chore: initialize Astro project with Tailwind"
```

---

### Task 2: Create Global Styles

**Files:**
- Create: `src/styles/global.css`

- [ ] **Step 1: Create global.css with font, keyframes, and Tailwind directives**

```css
@import "tailwindcss";

@font-face {
  font-family: 'VCR';
  src: url('/fonts/VCR.ttf') format('truetype');
}

body {
  font-family: 'VCR', monospace;
}

html {
  scroll-behavior: smooth;
}

@keyframes vhs-dots {
  0%, 100% { content: '░░░'; }
  14% { content: '▒░░'; }
  28% { content: '▓▒░'; }
  42% { content: '▓▓▒'; }
  57% { content: '▓▓▓'; }
  71% { content: '▓▓▒'; }
  85% { content: '▓▒░'; }
}
```

Note: Tailwind v4 uses `@import "tailwindcss"` instead of the older `@tailwind` directives. The `@astrojs/tailwind` integration handles wiring this into the build.

- [ ] **Step 2: Commit**

```bash
git add src/styles/global.css
git commit -m "feat: add global styles with VCR font and VHS keyframes"
```

---

### Task 3: Create Base Layout

**Files:**
- Create: `src/layouts/Base.astro`

- [ ] **Step 1: Create Base.astro layout**

```astro
---
import '../styles/global.css';

interface Props {
  title: string;
  description: string;
}

const { title, description } = Astro.props;
const fullTitle = title === 'VHS Garage'
  ? 'VHS Garage — A Lo-Fi Love Letter to the Golden Age of Video'
  : `${title} — VHS Garage`;
---

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{fullTitle}</title>
  <meta name="description" content={description}>
  <meta name="theme-color" content="#000000">

  <meta property="og:type" content="website">
  <meta property="og:title" content={fullTitle}>
  <meta property="og:description" content={description}>
  <meta property="og:image" content="https://vhsgarage.com/unfurl.png">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content={fullTitle}>
  <meta name="twitter:description" content={description}>
  <meta name="twitter:image" content="https://vhsgarage.com/unfurl.png">

  <link rel="icon" type="image/png" href="https://vhsgarage.com/favicon.png">
  <link rel="apple-touch-icon" href="https://vhsgarage.com/favicon.png">
  <link rel="manifest" href="https://vhsgarage.com/site.webmanifest">

  <slot name="head" />
</head>
<body class="bg-black text-white">
  <slot />
</body>
</html>
```

Note: OG image and favicon keep absolute URLs to `vhsgarage.com` matching the existing site behavior. The `<slot name="head" />` allows pages to inject page-specific styles or scripts into the head.

- [ ] **Step 2: Commit**

```bash
git add src/layouts/Base.astro
git commit -m "feat: add Base.astro shared layout"
```

---

### Task 4: Create Flicker Component

**Files:**
- Create: `src/components/Flicker.astro`

- [ ] **Step 1: Create Flicker.astro component**

This encapsulates the background images and sine-wave flicker effect used by both the homepage and watch page.

```astro
<div class="relative w-full">
  <img id="bg-dark" src="/images/bg-vertical-dark.webp" alt="" class="w-full block relative z-10" />
  <img id="bg-light" src="/images/bg-vertical.webp" alt="" class="absolute inset-0 w-full block z-10 transition-opacity duration-150" />
  <slot />
</div>

<script>
  const light = document.getElementById('bg-light');
  const dark = document.getElementById('bg-dark');
  let ready = 0;

  function startFlicker() {
    let t = 0;
    function tick() {
      t += 0.002 + Math.random() * 0.003;
      const v = 0.5
        + 0.35 * Math.sin(t * 1.0)
        + 0.25 * Math.sin(t * 2.7 + 1.3)
        + 0.15 * Math.sin(t * 5.1 + 0.7);
      light.style.opacity = String(Math.max(0, Math.min(1, v)));
      requestAnimationFrame(tick);
    }
    tick();
  }

  [light, dark].forEach(img => {
    if (img.complete) { ready++; }
    else { img.addEventListener('load', () => { ready++; if (ready === 2) startFlicker(); }, { once: true }); }
  });
  if (ready === 2) startFlicker();
</script>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Flicker.astro
git commit -m "feat: add Flicker.astro background component"
```

---

### Task 5: Move Static Assets to public/

**Files:**
- Move: assets from root to `public/` subdirectories
- Update: `site.webmanifest` icon path

- [ ] **Step 1: Create public directories and move assets**

```bash
mkdir -p public/fonts public/images public/video
cp VCR.ttf public/fonts/
cp bg-vertical.webp bg-vertical-dark.webp favicon.png unfurl.png public/images/
cp vhs-garage-loop.mp4 public/video/
cp site.webmanifest public/
```

Using `cp` not `mv` — the old files stay in place so the existing site keeps working until we switch over.

- [ ] **Step 2: Update site.webmanifest icon path**

Read `public/site.webmanifest` and update the icon src. The existing manifest uses an absolute URL which is fine to keep:

```json
{
  "name": "VHS Garage",
  "short_name": "VHS Garage",
  "description": "A lo-fi love letter to the golden age of video.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    {
      "src": "https://vhsgarage.com/favicon.png",
      "sizes": "any",
      "type": "image/png"
    }
  ]
}
```

No change needed — the absolute URL works as-is.

- [ ] **Step 3: Commit**

```bash
git add public/
git commit -m "feat: copy static assets to public/ directory"
```

---

### Task 6: Migrate Homepage (index.astro)

**Files:**
- Create: `src/pages/index.astro`

- [ ] **Step 1: Create index.astro**

Import the layout and Flicker component, then paste the body content from index.html. Remove all head/meta/font/style content (handled by Base.astro and global.css). The page-specific CSS for `#video-loader::after` goes in a `<style>` block. All 4 script blocks become inline `<script>` tags.

```astro
---
import Base from '../layouts/Base.astro';
import Flicker from '../components/Flicker.astro';
---

<Base title="VHS Garage" description="Two dudes on a mission to rewind the clock and bring analog vibes back to a digital world. VHS swap meets, found footage, and IRL events.">

  <style>
    #video-loader::after {
      content: '░░░';
      animation: vhs-dots 0.9s steps(1) infinite;
    }
  </style>

  <!-- Hero -->
  <section class="relative md:h-screen md:overflow-hidden md:flex md:items-center cursor-pointer">
    <Flicker>
      <div id="video-loader" class="absolute top-[44.5%] left-[20.5%] w-[24%] z-0 rotate-[2.5deg] flex items-center justify-center text-white/40 text-sm"></div>
      <video
        id="hero-video"
        src="/video/vhs-garage-loop.mp4"
        autoplay
        loop
        muted
        playsinline
        class="absolute top-[40.5%] left-[20.5%] w-[24%] z-0 rotate-[2.5deg] opacity-0 transition-opacity duration-500"
      ></video>
    </Flicker>

    <p id="sound-hint" class="absolute top-4 right-4 text-white text-xs z-20 opacity-60">Sound On</p>

    <div class="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce z-20">
      <svg class="w-8 h-8 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
      </svg>
    </div>
  </section>

  <!-- Content -->
  <section class="max-w-5xl mx-auto px-6 py-24 text-left">
    <h2 class="text-7xl mb-6 tracking-tight">Welcome to the Garage</h2>
    <p class="text-lg text-gray-300 mb-4 leading-relaxed">
      VHS Garage is a lo-fi love letter to the golden age of video. Two dudes on a mission to rewind the clock and bring analog vibes back to a digital world.
    </p>
    <p class="text-lg text-gray-300 mb-12 leading-relaxed">
      Hosted by <a href="https://x.com/oracrest" target="_blank" class="text-white underline hover:text-gray-300">Matt Manchester</a>. Co-hosted by <a href="https://x.com/clarklab" target="_blank" class="text-white underline hover:text-gray-300">Clark Wimberly</a>.
    </p>

    <!-- What We're Into -->
    <div class="mb-12">
      <h3 class="text-2xl mb-6">#What We're Into</h3>
      <div class="grid md:grid-cols-3 gap-6 text-sm text-gray-300">
        <fieldset class="border border-white/20 px-5 pb-5 pt-3">
          <legend class="text-white/50 text-xs px-2">░ VHS Swap Meets ░</legend>
          <p class="mb-4">We buy, sell, and trade tapes in person. Bring your doubles.</p>
          <a href="#upcoming-events" class="text-[#39ff14] text-xs hover:underline">Find us IRL →</a>
        </fieldset>
        <fieldset class="border border-white/20 px-5 pb-5 pt-3">
          <legend class="text-white/50 text-xs px-2">░ Found Footage ░</legend>
          <p class="mb-4">Random clips from old tapes. Stuff nobody was supposed to keep.</p>
          <a href="/watch" class="text-[#39ff14] text-xs hover:underline block mb-1">Watch in the Garage →</a>
          <a href="https://www.youtube.com/user/oracrest" target="_blank" class="text-[#39ff14] text-xs hover:underline block">Watch on YouTube →</a>
        </fieldset>
        <fieldset class="border border-white/20 px-5 pb-5 pt-3">
          <legend class="text-white/50 text-xs px-2">░ Limited Drops ░</legend>
          <p class="mb-4">Small-batch merch and curated tape packs. When they're gone, they're gone.</p>
          <a href="#signup" class="text-[#39ff14] text-xs hover:underline">Coming soon →</a>
        </fieldset>
      </div>
    </div>

    <!-- Upcoming Events -->
    <div id="upcoming-events" class="mb-12">
      <h3 class="text-2xl mb-6">#Upcoming Events</h3>
      <div class="border border-white/20 p-5 mb-6">
        <p class="text-white text-lg mb-1">ABW Sunday Funday</p>
        <p class="text-gray-400 text-sm mb-3">Sunday, April 19 — 4:30pm · Sprinkle Valley at Austin Beerworks · Austin, TX</p>
        <p class="text-gray-300 text-sm mb-3">Vintage and retro vendors, VHS swap, video screenings, and good hangs.</p>
        <a href="https://www.instagram.com/p/DWeZWoICXg8/" target="_blank" class="text-[#39ff14] text-xs hover:underline">See the post on Instagram →</a>
      </div>
      <p class="text-gray-400">Follow <a href="https://x.com/oracrest" target="_blank" class="text-white underline hover:text-gray-300">Matt on Twitter</a> for more event announcements, or send us an invite to your event. We'll probably show up!</p>
    </div>

    <!-- Signup -->
    <div id="signup">
      <h3 class="text-2xl mb-2">#Join us in the Garage</h3>
      <p class="text-gray-400 mb-6">Drop your email and we'll give you a <strong class="text-white">free mystery VHS</strong> at an upcoming event. No spam. Just tapes.</p>
      <form id="garage-form" name="garage-signup" method="POST" data-netlify="true" class="flex gap-3">
        <input type="hidden" name="form-name" value="garage-signup" />
        <input
          id="garage-email"
          type="email"
          name="email"
          placeholder="your@email.com"
          required
          class="flex-1 px-4 py-3 rounded-lg bg-black border border-white/30 text-white placeholder-gray-500 focus:outline-none focus:border-white"
        />
        <button id="garage-submit-btn" type="submit" class="px-6 py-3 bg-white text-black rounded-lg hover:bg-gray-200 transition-colors shrink-0 min-w-[100px]">
          Sign Up
        </button>
      </form>
      <p id="garage-confirm" class="hidden text-lg mt-4"></p>
    </div>
  </section>

  <footer class="text-left text-gray-600 text-sm pb-8 max-w-5xl mx-auto px-6">&copy; 2026 VHS Garage</footer>

  <!-- Video loader -->
  <script>
    (() => {
      const vid = document.getElementById('hero-video');
      const loader = document.getElementById('video-loader');
      vid.addEventListener('canplaythrough', () => {
        vid.classList.remove('opacity-0');
        loader.classList.add('hidden');
      }, { once: true });
    })();
  </script>

  <!-- Sound toggle -->
  <script>
    (() => {
      const section = document.querySelector('section');
      const vid = document.getElementById('hero-video');
      const hint = document.getElementById('sound-hint');
      section.addEventListener('click', () => {
        vid.muted = !vid.muted;
        hint.textContent = vid.muted ? 'Sound On' : 'Sound Off';
      });
    })();
  </script>

  <!-- Form submission -->
  <script>
    (() => {
      const form = document.getElementById('garage-form');
      const btn = document.getElementById('garage-submit-btn');
      const confirm = document.getElementById('garage-confirm');
      const frames = ['░░░', '▒░░', '▓▒░', '▓▓▒', '▓▓▓', '▓▓▒', '▓▒░', '▒░░'];
      let tick;

      function startLoader() {
        let i = 0;
        btn.disabled = true;
        btn.textContent = frames[0];
        tick = setInterval(() => {
          i = (i + 1) % frames.length;
          btn.textContent = frames[i];
        }, 120);
      }

      function stopLoader() {
        clearInterval(tick);
        btn.disabled = false;
        btn.textContent = 'Sign Up';
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        startLoader();
        try {
          const res = await fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(new FormData(form)).toString()
          });
          stopLoader();
          if (res.ok) {
            form.classList.add('hidden');
            confirm.classList.remove('hidden');
            confirm.textContent = '▓ You\'re in. See you at the next event.';
          } else {
            confirm.classList.remove('hidden');
            confirm.textContent = '░ Something went wrong. Try again.';
            confirm.classList.add('text-red-400');
          }
        } catch {
          stopLoader();
          confirm.classList.remove('hidden');
          confirm.textContent = '░ Network error. Try again.';
          confirm.classList.add('text-red-400');
        }
      });
    })();
  </script>

</Base>
```

Note: The submit button ID changed from `garage-btn` to `garage-submit-btn` to avoid collision with the garage selector button ID on the watch page (both used `garage-btn` in the old code but were on separate pages — Astro components could cause issues if IDs leak).

- [ ] **Step 2: Run dev server and verify homepage**

```bash
npm run dev
```

Open http://localhost:4321 — verify:
- Flicker effect works on background images
- Video plays and loader disappears
- Sound toggle works
- All content sections render correctly
- Form submits (will fail locally since Netlify forms need deployment, but should not JS-error)
- Scroll anchors work (#upcoming-events, #signup)

- [ ] **Step 3: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: migrate homepage to index.astro"
```

---

### Task 7: Migrate Watch Page (watch.astro)

**Files:**
- Create: `src/pages/watch.astro`

- [ ] **Step 1: Create watch.astro**

The watch page uses the Flicker component for bg images and has substantial inline JS for the YouTube player. All the watch-specific CSS goes in a `<style>` block. The YouTube iframe API script is loaded via a `<script>` tag in the head slot.

```astro
---
import Base from '../layouts/Base.astro';
import Flicker from '../components/Flicker.astro';
---

<Base title="Watch" description="A VHS screen saver. Random clips from the garage.">

  <Fragment slot="head">
    <script is:inline src="https://www.youtube.com/iframe_api"></script>
  </Fragment>

  <style>
    #yt-loader::after {
      content: '░░░';
      animation: vhs-dots 0.9s steps(1) infinite;
    }
    #yt-player-wrap iframe {
      width: 100%;
      aspect-ratio: 4/3;
      display: block;
      border: none;
    }
    .panel-btn {
      transition: color 0.2s, opacity 0.2s;
    }
    .panel-btn:hover { color: rgba(255,255,255,0.8); }
    .setting-opt {
      padding: 4px 10px;
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.15);
      transition: background 0.15s, border-color 0.15s;
    }
    .setting-opt:hover { border-color: rgba(255,255,255,0.4); }
    .setting-opt.active {
      background: rgba(255,255,255,0.15);
      border-color: rgba(255,255,255,0.5);
    }
  </style>

  <div id="screen" class="relative w-full h-screen flex items-center overflow-hidden">
    <Flicker>
      <div id="yt-loader" class="absolute top-[44.5%] left-[20.5%] w-[24%] z-0 rotate-[2.5deg] flex items-center justify-center text-white/40 text-sm"></div>
      <div id="yt-player-wrap" class="absolute top-[40.5%] left-[20.5%] w-[24%] z-0 rotate-[2.5deg] opacity-0 transition-opacity duration-500">
        <div id="yt-player"></div>
      </div>
    </Flicker>
  </div>

  <!-- Corner UI -->
  <div id="corner-ui" class="fixed inset-0 z-30 pointer-events-none transition-opacity duration-300">
    <div class="absolute top-4 left-4 pointer-events-auto">
      <button id="garage-sel-btn" class="panel-btn text-white/40 text-xs">▓ Matt's Garage</button>
      <div id="garage-panel" class="hidden mt-2 bg-black/90 border border-white/20 p-3 w-48 text-xs">
        <p class="text-white/60 mb-2">Garage</p>
        <div class="text-white/80 p-2 border border-white/30 bg-white/10">Matt's Garage</div>
        <p class="text-white/30 mt-2 text-[10px]">More garages coming soon</p>
      </div>
    </div>

    <div class="absolute top-4 right-4 pointer-events-auto text-right">
      <button id="channel-btn" class="panel-btn text-white/40 text-xs">CH ░ <span id="channel-name">oracrest</span></button>
      <div id="channel-panel" class="hidden mt-2 bg-black/90 border border-white/20 p-3 w-64 text-xs text-left">
        <p class="text-white/60 mb-2">Channel</p>
        <div class="flex gap-2 mb-3">
          <input id="channel-input" type="text" placeholder="YouTube channel URL or ID"
            class="flex-1 px-2 py-1 bg-black border border-white/30 text-white text-xs placeholder-white/30 focus:outline-none focus:border-white/60" />
          <button id="channel-load" class="px-3 py-1 border border-white/30 text-white/60 hover:text-white hover:border-white/60 transition-colors">Load</button>
        </div>
        <p class="text-white/30 text-[10px]">Paste a youtube.com/user/ or youtube.com/channel/ URL</p>
      </div>
    </div>

    <div class="absolute bottom-4 left-4 pointer-events-auto">
      <div id="settings-panel" class="hidden mb-2 bg-black/90 border border-white/20 p-3 w-56 text-xs">
        <p class="text-white/60 mb-2">Clip Length</p>
        <div class="flex gap-1 mb-3" id="clip-options">
          <span class="setting-opt" data-val="30000">30s</span>
          <span class="setting-opt" data-val="60000">1m</span>
          <span class="setting-opt" data-val="300000">5m</span>
          <span class="setting-opt active" data-val="0">&#8734;</span>
        </div>
        <p class="text-white/60 mb-2">Sleep Timer</p>
        <div class="flex gap-1" id="sleep-options">
          <span class="setting-opt" data-val="3600000">1hr</span>
          <span class="setting-opt" data-val="7200000">2hr</span>
          <span class="setting-opt" data-val="14400000">4hr</span>
          <span class="setting-opt active" data-val="0">&#8734;</span>
        </div>
      </div>
      <button id="settings-btn" class="panel-btn text-white/40 text-xs">▒ Settings</button>
    </div>

    <div class="absolute bottom-4 right-4 pointer-events-auto">
      <button id="fullscreen-btn" class="panel-btn text-white/40 text-xs">[ ]</button>
    </div>
  </div>

  <!-- Sleep overlay -->
  <div id="sleep-overlay" class="hidden fixed inset-0 z-40 bg-black/80 flex items-center justify-center cursor-pointer">
    <p class="text-white/30 text-sm">░ paused ░ click to resume</p>
  </div>

  <script is:inline>
    const YOUTUBE_API_KEY = '';

    const GARAGES = [
      { id: 'matts', name: "Matt's Garage", bg: 'bg-vertical', channel: 'oracrest' }
    ];

    const DEFAULT_CHANNEL_ID = 'UC-wMG2tGhmeBOCO9IVbu4kg';

    const SEED_VIDEOS = [
      '7NoPy_y1ENM', 'CQiDcue0Mwg', 'argK6e8sZrc', 'hkFqZGpX2aI',
      'T5y2jcGYZj4', 'V1ETmE426Xc', 'R7o9aGdz92o', '2_kFa7Prp4A',
      'mthwgR-cqWk', 'skaEO-fUeIo', 'YblSGYjPugQ', 'edum1muSs7s',
      '3StHm3JtTlo', 'bq5ASTfWWLQ', 'l3tKnOaGjfg'
    ];

    const STORAGE_KEY = 'vhsg_watch';

    const App = {
      player: null,
      playlist: [...SEED_VIDEOS],
      currentIndex: -1,
      clipLimitMs: 0,
      sleepTimerMs: 0,
      sleepTimeout: null,
      clipTimeout: null,
      channelId: '',
      channelName: 'oracrest',

      loadSettings() {
        try {
          const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
          if (saved.clipLimit !== undefined) this.clipLimitMs = saved.clipLimit;
          if (saved.sleepTimer !== undefined) this.sleepTimerMs = saved.sleepTimer;
          if (saved.channelName) this.channelName = saved.channelName;
          if (saved.channelId) this.channelId = saved.channelId;
          if (saved.playlist && saved.playlist.length) this.playlist = saved.playlist;
        } catch (e) {}
      },

      saveSettings() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          clipLimit: this.clipLimitMs,
          sleepTimer: this.sleepTimerMs,
          channelName: this.channelName,
          channelId: this.channelId,
          playlist: this.playlist
        }));
      },

      initPlayer() {
        this.player = new YT.Player('yt-player', {
          height: '100%',
          width: '100%',
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            rel: 0,
            showinfo: 0,
            playsinline: 1,
            origin: window.location.origin
          },
          events: {
            onReady: (e) => this.onPlayerReady(e),
            onStateChange: (e) => this.onStateChange(e),
            onError: (e) => this.onError(e)
          }
        });
      },

      onPlayerReady() {
        this.playRandom();
        if (this.sleepTimerMs > 0) this.startSleepTimer();
      },

      onStateChange(event) {
        if (event.data === YT.PlayerState.PLAYING) {
          document.getElementById('yt-player-wrap').classList.remove('opacity-0');
          document.getElementById('yt-loader').classList.add('hidden');
          this.startClipTimer();
        }
        if (event.data === YT.PlayerState.ENDED) {
          this.playRandom();
        }
      },

      onError() {
        this.playRandom();
      },

      playRandom() {
        if (!this.playlist.length) return;
        let idx;
        do {
          idx = Math.floor(Math.random() * this.playlist.length);
        } while (idx === this.currentIndex && this.playlist.length > 1);
        this.currentIndex = idx;
        this.player.loadVideoById(this.playlist[idx]);
      },

      startClipTimer() {
        clearTimeout(this.clipTimeout);
        if (this.clipLimitMs > 0) {
          this.clipTimeout = setTimeout(() => this.playRandom(), this.clipLimitMs);
        }
      },

      startSleepTimer() {
        clearTimeout(this.sleepTimeout);
        if (this.sleepTimerMs > 0) {
          this.sleepTimeout = setTimeout(() => {
            this.player.pauseVideo();
            document.getElementById('sleep-overlay').classList.remove('hidden');
          }, this.sleepTimerMs);
        }
      },

      setClipLimit(ms) {
        this.clipLimitMs = ms;
        this.saveSettings();
        this.startClipTimer();
      },

      setSleepTimer(ms) {
        this.sleepTimerMs = ms;
        this.saveSettings();
        this.startSleepTimer();
      },

      async loadChannel(input) {
        let channelId = '';
        let channelName = input;

        try {
          const url = new URL(input.includes('://') ? input : 'https://' + input);
          const path = url.pathname;
          if (path.startsWith('/channel/')) {
            channelId = path.split('/')[2];
            channelName = channelId;
          } else if (path.startsWith('/user/') || path.startsWith('/@') || path.startsWith('/c/')) {
            channelName = path.split('/').filter(Boolean).pop().replace('@', '');
          }
        } catch (e) {
          channelName = input.replace('@', '');
        }

        this.channelName = channelName;
        document.getElementById('channel-name').textContent = channelName;

        if (YOUTUBE_API_KEY) {
          await this.fetchChannelVideos(channelId, channelName);
        }

        this.saveSettings();
        this.playRandom();
      },

      async fetchChannelVideos(channelId, channelName) {
        if (!YOUTUBE_API_KEY) return;

        try {
          if (!channelId) {
            const chRes = await fetch(
              `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${channelName}&key=${YOUTUBE_API_KEY}`
            );
            const chData = await chRes.json();
            if (chData.items && chData.items.length) {
              channelId = chData.items[0].id;
            } else {
              const searchRes = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${channelName}&type=channel&maxResults=1&key=${YOUTUBE_API_KEY}`
              );
              const searchData = await searchRes.json();
              if (searchData.items && searchData.items.length) {
                channelId = searchData.items[0].id.channelId;
              }
            }
          }

          if (!channelId) return;
          this.channelId = channelId;

          const cacheKey = `vhsg_ch_${channelId}`;
          const cached = localStorage.getItem(cacheKey);
          if (cached) {
            const { videos, ts } = JSON.parse(cached);
            if (Date.now() - ts < 3600000) {
              this.playlist = videos;
              return;
            }
          }

          const res = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&maxResults=50&order=date&key=${YOUTUBE_API_KEY}`
          );
          const data = await res.json();
          if (data.items && data.items.length) {
            this.playlist = data.items.map(i => i.id.videoId);
            localStorage.setItem(cacheKey, JSON.stringify({
              videos: this.playlist,
              ts: Date.now()
            }));
          }
        } catch (e) {
          console.warn('YouTube API fetch failed, using existing playlist');
        }
      }
    };

    function onYouTubeIframeAPIReady() {
      App.loadSettings();
      App.initPlayer();
    }

    document.addEventListener('DOMContentLoaded', () => {
      function togglePanel(btnId, panelId) {
        const btn = document.getElementById(btnId);
        const panel = document.getElementById(panelId);
        const allPanels = ['garage-panel', 'channel-panel', 'settings-panel'];

        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasHidden = panel.classList.contains('hidden');
          allPanels.forEach(id => document.getElementById(id).classList.add('hidden'));
          if (wasHidden) panel.classList.remove('hidden');
        });
      }

      togglePanel('garage-sel-btn', 'garage-panel');
      togglePanel('channel-btn', 'channel-panel');
      togglePanel('settings-btn', 'settings-panel');

      document.addEventListener('click', () => {
        ['garage-panel', 'channel-panel', 'settings-panel'].forEach(id =>
          document.getElementById(id).classList.add('hidden')
        );
      });

      ['garage-panel', 'channel-panel', 'settings-panel'].forEach(id => {
        document.getElementById(id).addEventListener('click', e => e.stopPropagation());
      });

      const clipOpts = document.querySelectorAll('#clip-options .setting-opt');
      clipOpts.forEach(opt => {
        opt.addEventListener('click', () => {
          clipOpts.forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          App.setClipLimit(parseInt(opt.dataset.val));
        });
      });

      const sleepOpts = document.querySelectorAll('#sleep-options .setting-opt');
      sleepOpts.forEach(opt => {
        opt.addEventListener('click', () => {
          sleepOpts.forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          App.setSleepTimer(parseInt(opt.dataset.val));
        });
      });

      App.loadSettings();
      clipOpts.forEach(o => {
        if (parseInt(o.dataset.val) === App.clipLimitMs) {
          clipOpts.forEach(x => x.classList.remove('active'));
          o.classList.add('active');
        }
      });
      sleepOpts.forEach(o => {
        if (parseInt(o.dataset.val) === App.sleepTimerMs) {
          sleepOpts.forEach(x => x.classList.remove('active'));
          o.classList.add('active');
        }
      });
      document.getElementById('channel-name').textContent = App.channelName;

      document.getElementById('channel-load').addEventListener('click', () => {
        const val = document.getElementById('channel-input').value.trim();
        if (val) {
          App.loadChannel(val);
          document.getElementById('channel-panel').classList.add('hidden');
        }
      });

      document.getElementById('channel-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          document.getElementById('channel-load').click();
        }
      });

      document.getElementById('fullscreen-btn').addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen();
        }
      });

      document.addEventListener('fullscreenchange', () => {
        const ui = document.getElementById('corner-ui');
        if (document.fullscreenElement) {
          ui.style.opacity = '0';
          ui.style.pointerEvents = 'none';
          ['garage-panel', 'channel-panel', 'settings-panel'].forEach(id =>
            document.getElementById(id).classList.add('hidden')
          );
        } else {
          ui.style.opacity = '1';
          ui.style.pointerEvents = '';
        }
      });

      document.getElementById('sleep-overlay').addEventListener('click', () => {
        document.getElementById('sleep-overlay').classList.add('hidden');
        App.player.playVideo();
        App.startSleepTimer();
      });
    });
  </script>

</Base>
```

Note: The garage button ID changed from `garage-btn` to `garage-sel-btn` to avoid collision with the homepage form button. The `<script is:inline>` directive tells Astro not to process this script — important because the YouTube API callback `onYouTubeIframeAPIReady` must be a global function. The body class on watch.html had `overflow-hidden h-screen w-screen` — those are now on the `#screen` div instead since the body class comes from Base.astro.

- [ ] **Step 2: Run dev server and verify /watch**

```bash
npm run dev
```

Open http://localhost:4321/watch — verify:
- Background flicker effect works
- YouTube player loads and plays a random video in the CRT mask
- Corner UI buttons toggle panels
- Settings controls work (clip length, sleep timer)
- Fullscreen toggle works and hides corner UI
- Channel input loads a new channel

- [ ] **Step 3: Commit**

```bash
git add src/pages/watch.astro
git commit -m "feat: migrate watch page to watch.astro"
```

---

### Task 8: Migrate Plan Page (plan.astro)

**Files:**
- Create: `src/pages/plan.astro`

- [ ] **Step 1: Create plan.astro**

The simplest page — just styled text. Plan.html used its own inline CSS instead of Tailwind, with custom sizes. We'll reproduce that styling in a scoped `<style>` block.

```astro
---
import Base from '../layouts/Base.astro';
---

<Base title="The Plan" description="Build it, grow it, sell it. The VHS Garage plan.">

  <style>
    .plan {
      max-width: 540px;
      padding: 48px 24px;
      color: #ccc;
    }
    .plan h1 { color: #fff; font-size: 14px; margin: 0 0 32px; }
    .plan h2 { color: #666; font-size: 11px; margin: 24px 0 12px; letter-spacing: 1px; }
    .plan ol { margin: 0; padding: 0 0 0 20px; }
    .plan li { font-size: 13px; margin: 0 0 6px; line-height: 1.5; }
  </style>

  <div class="plan">
    <h1>The Plan</h1>

    <h2>BUILD</h2>
    <ol>
      <li>Catalog any VHS clip — what's on it, which tape it came from</li>
      <li>Build capture tools to digitize clips into the database</li>
      <li>Build the player and stream clips to YouTube</li>
    </ol>

    <h2>GROW</h2>
    <ol>
      <li>Draw people in via unique curated clips and shares</li>
      <li>Turn VHS Garage into the brand people show up for</li>
      <li>Make every event bigger than the last one</li>
      <li>Pack the swaps — more people, more tapes, more trades</li>
    </ol>

    <h2>SELL</h2>
    <ol>
      <li>Limited merch drops that sell out</li>
      <li>Curated tape packs and custom dubs</li>
      <li>Split the money, do it again</li>
    </ol>
  </div>

</Base>
```

- [ ] **Step 2: Run dev server and verify /plan**

```bash
npm run dev
```

Open http://localhost:4321/plan — verify it renders identically to the current plan.html: small VCR font text, three sections, black background.

- [ ] **Step 3: Commit**

```bash
git add src/pages/plan.astro
git commit -m "feat: migrate plan page to plan.astro"
```

---

### Task 9: Netlify Configuration

**Files:**
- Create: `netlify.toml`

- [ ] **Step 1: Create netlify.toml**

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"
```

Astro's file-based routing generates `/watch/index.html` which Netlify serves as `/watch` automatically. No redirect rules needed.

- [ ] **Step 2: Add .gitignore entries for Astro build artifacts**

Read the existing `.gitignore` (if any) and add Astro-specific entries. If no `.gitignore` exists, create one:

```
node_modules/
dist/
.astro/
.DS_Store
```

- [ ] **Step 3: Commit**

```bash
git add netlify.toml .gitignore
git commit -m "chore: add Netlify build config and .gitignore"
```

---

### Task 10: Build Verification

- [ ] **Step 1: Run production build**

```bash
npm run build
```

Expected: Build succeeds. Output in `dist/` directory. Check that all pages exist:

```bash
ls dist/index.html dist/watch/index.html dist/plan/index.html
```

- [ ] **Step 2: Preview the production build**

```bash
npm run preview
```

Open http://localhost:4321 and check all 4 pages:
- Homepage: flicker, video, sound toggle, form, content, footer
- /watch: YouTube player, corner UI, fullscreen
- /plan: three lists

- [ ] **Step 3: Verify static assets are in dist/**

```bash
ls dist/fonts/VCR.ttf dist/images/bg-vertical.webp dist/images/bg-vertical-dark.webp dist/video/vhs-garage-loop.mp4 dist/favicon.png dist/unfurl.png dist/site.webmanifest
```

All should exist. If any are missing, check the `public/` directory structure.

- [ ] **Step 4: Commit (no changes expected, but commit .astro cache if generated)**

```bash
git status
```

If there are uncommitted changes, stage and commit them.

---

### Task 11: Clean Up Old Files

**Files:**
- Remove: old HTML files and unused assets from root

- [ ] **Step 1: Remove old HTML files and redirects**

```bash
git rm index.html watch.html plan.html _redirects
```

- [ ] **Step 2: Remove old root-level assets (keep originals in public/)**

```bash
git rm bg-vertical.webp bg-vertical-dark.webp favicon.png unfurl.png VCR.ttf vhs-garage-loop.mp4 site.webmanifest
```

- [ ] **Step 3: Remove unused assets that were never referenced**

```bash
git rm bg-vertical-dark.png bg-vertical.png garage-vertical.png vhs-garage-bg.png vhs-garage-bg-empty.png vhs-loop.mp4
```

- [ ] **Step 4: Remove ScreenFlow source files (not for production)**

```bash
git rm -r video/
```

- [ ] **Step 5: Verify build still works after cleanup**

```bash
npm run build && npm run preview
```

All pages should still work correctly.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove old HTML files and unused assets"
```

- [ ] **Step 7: Push to trigger Netlify deploy**

```bash
git push
```

Verify the Netlify deploy succeeds and the live site works at vhsgarage.com.
