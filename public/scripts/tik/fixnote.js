// A file the browser can't use, and the one command that fixes it.
//
// Three places need this — the clip bar, a failed Shoot row, and the editor
// when a file won't open at all — and all three need the same thing: say what
// is wrong without blaming the file, show a command with THIS file's name
// already in it, and get it into the clipboard in one click.

// { note, label, command } → one element to append. Browser-only (DOM), but
// every string it shows is built by the pure helpers in ffmpeg.js.
export function fixNote({ note = '', label = '', command = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'flex w-full flex-col gap-1 rounded-lg border border-neutral-800 bg-black/50 p-2';

  if (note) {
    const why = document.createElement('p');
    why.className = 'text-[11px] leading-snug text-amber-300/80';
    why.textContent = note;
    wrap.append(why);
  }

  const head = document.createElement('div');
  head.className = 'flex items-center justify-between gap-2';
  const cap = document.createElement('span');
  cap.className = 'text-[10px] font-semibold uppercase tracking-wide text-neutral-500';
  cap.textContent = label;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'flex-none rounded-md bg-neutral-800 px-2 py-1 text-[11px] font-semibold text-neutral-200 hover:bg-neutral-700';
  copy.textContent = 'Copy';
  head.append(cap, copy);

  const code = document.createElement('code');
  code.className = 'block overflow-x-auto whitespace-pre text-[11px] leading-relaxed text-emerald-300';
  code.textContent = command;

  const brew = document.createElement('span');
  brew.className = 'text-[10px] text-neutral-600';
  brew.textContent = 'No ffmpeg? brew install ffmpeg';

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      copy.textContent = 'Copied';
    } catch (e) {
      // Refused — an unfocused tab, a permissions policy. Select the command
      // instead, so the shortcut is one press away rather than a careful drag
      // across a line of shell.
      console.warn('[tik] clipboard refused the command; selecting it instead:', e);
      try {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        copy.textContent = 'Press ⌘C';
      } catch (e2) {
        console.warn('[tik] could not select the command either:', e2);
        copy.textContent = 'Select it';
      }
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2200);
  });

  wrap.append(head, code, brew);
  return wrap;
}
