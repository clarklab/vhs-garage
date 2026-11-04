# Put picked frames into a draft in the studio library.
#
#   deliver.py <slug> <film path> <project id> <picks.json>
#
# picks.json is [{ "i": slide index (outro not counted), "t": seconds, "standIn": bool, "why": str }].
# Give every slide for a fresh draft, or only the ones being fixed: slides not
# listed are left exactly as they are.
#
# 1. a full-size frame at each pick  → $TIK_FRAMES_WORK/deliver/<slug>/<i>.jpg
# 2. each one uploaded through the site's own image endpoint (tik-media, the
#    one publishing uses; uploads expire after about 2 hours, so apply soon)
# 3. delivery.json + apply.js: run apply.js in a vhsgarage.com/tik tab (the
#    studio's library lives in that browser) to save the frames into the draft.
#    A linked browser then syncs the change to the cloud copy and the phone.
import json, os, subprocess, sys, urllib.request

SP = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames')
SITE = 'https://vhsgarage.com'

slug, film, pid, picks_file = sys.argv[1:5]
picks = sorted(json.load(open(picks_file)), key=lambda m: m['i'])
out = f'{SP}/deliver/{slug}'
os.makedirs(out, exist_ok=True)

items = []
for m in picks:
    i, t = int(m['i']), float(m['t'])
    f = f'{out}/{i}.jpg'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t), '-i', film, '-frames:v', '1',
                    '-vf', "scale='min(1920,iw)':-2", '-q:v', '2', f], check=True)
    req = urllib.request.Request(f'{SITE}/.netlify/functions/tik-media', data=open(f, 'rb').read(),
                                 headers={'Content-Type': 'image/jpeg', 'Origin': SITE, 'Referer': SITE + '/tik/'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        url = json.loads(r.read())['url']
    note = ('Stand-in: ' if m.get('standIn') else '') + m.get('why', '')
    items.append({'i': i, 't': t, 'url': url, 'note': note})
    print(f'{i:2d} {t:>8}s  {os.path.getsize(f) // 1024:4d} KB  uploaded', flush=True)

delivery = {'id': pid, 'items': items}
json.dump(delivery, open(f'{out}/delivery.json', 'w'))

# The apply step, as a function call so several films can go in one paste.
js = """window.__applyFrames = window.__applyFrames || (async (d) => {
  const { getProject, putProject } = await import('/scripts/tik/store.js');
  const p = await getProject(d.id);
  if (!p) throw new Error('no project ' + d.id);
  const slides = p.slides.filter((s) => s.kind !== 'outro');
  for (const it of d.items) if (!slides[it.i]) throw new Error(`no slide ${it.i} (the set has ${slides.length})`);
  const blobs = [];
  for (const it of d.items) {
    const res = await fetch(it.url);
    if (!res.ok) throw new Error(`frame ${it.i}: ${res.status} (uploads expire after ~2h; run deliver.py again)`);
    blobs.push(await res.blob());
  }
  const now = Date.now();
  d.items.forEach((it, k) => {
    const s = slides[it.i];
    const prev = s.frameScan || {};
    s.frame = blobs[k];
    s.timecode = it.t;
    s.adjust = null;
    s.frameScan = {
      source: 'claude', score: 100, review: false, at: now,
      why: it.note ? `Picked by Claude from the whole film: ${it.note}` : 'Picked by Claude from a local look at the whole film',
      ...(prev.wrong ? { wasWrong: prev.wrong, fixed: true } : {}),
    };
  });
  if (d.items.some((it) => it.i === 0)) p.thumb = slides[0].frame;
  p.batch = { ...(p.batch || {}), pendingFrames: false };
  p.updatedAt = now;
  await putProject(p);
  const back = await getProject(d.id);
  const after = back.slides.filter((s) => s.kind !== 'outro');
  return JSON.stringify({ title: back.movie?.title || back.name, replaced: d.items.map((it) => [it.i, after[it.i].timecode]), stillWrong: after.filter((s) => s.frameScan?.wrong).length });
});
await window.__applyFrames(%s)""" % json.dumps(delivery)
open(f'{out}/apply.js', 'w').write(js)
print('apply JS written to', f'{out}/apply.js')
