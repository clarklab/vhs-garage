# make-draft.py <slug> <houseIndex> — check a locally written set (W/writes/<slug>.json, the
# WRITE-BRIEF.md output) against the house rules and write the payload the tab turns into a draft:
#   W/drafts/<slug>.json  (fetched by draft.js's window.__makeDraft via serve.py)
#   W/drafts/_draft.js    (a copy of draft.js, so the tab can load it from the same server)
# houseIndex rotates the hashtag house set across a run of drafts (0, 1, 2, …), as batch mode does.
#
# Hand-written copy. A set written to the current brief has no title-slide line, no sign-off and no
# post copy: those are written by hand afterwards (COPY.md) into W/copy/<slug>.json
#   {"intro", "outro", "postTitle", "postDesc", "filmTags"?, "hook"?}
# and checked here with check-copy.mjs. The draft then carries that copy as its own (postEdited), so
# the studio never regenerates it. A set in the older shape (a `meta` block and a finished title
# slide) still works without a copy file and gets the app's generated post copy and sign-off.
import json, os, re, shutil, subprocess, sys
W = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames')
HERE = os.path.dirname(os.path.abspath(__file__))
slug, house = sys.argv[1], int(sys.argv[2])
w = json.load(open(f'{W}/writes/{slug}.json'))
label = f"{w['title']} ({w['year']})"
copy_file = f'{W}/copy/{slug}.json'
copy = json.load(open(copy_file)) if os.path.exists(copy_file) else None
slides = [dict(s) for s in w['slides']]
assert 9 <= len(slides) <= 12, f'{len(slides)} slides; expected a title slide plus 8 to 11 facts'

if copy:
    r = subprocess.run(['node', f'{HERE}/check-copy.mjs'], input=json.dumps({'title': w['title'], 'year': w['year'], 'copy': copy}),
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'{slug}: the hand-written copy has problems:\n{r.stdout}{r.stderr}')
    slides[0]['caption'] = f"{label}\n{copy['intro'].strip()}"
else:
    assert 'meta' in w, f'no {copy_file}: this set needs its title-slide line, sign-off and post copy written by hand (COPY.md)'
    assert slides[0]['caption'].startswith(f'{label}\n'), 'title slide must start with "Title (Year)\\n"'

for i, s in enumerate(slides):
    for k in ('caption', 'grab'):
        assert '—' not in s[k] and '–' not in s[k], f'dash in slide {i} {k}'
    assert len(s['caption']) <= 300, f'slide {i} caption is {len(s["caption"])} chars (max 300)'
    assert len(s['grab']) <= 200, f'slide {i} grab is {len(s["grab"])} chars (max 200)'

songs = (w.get('intro') or {}).get('songs') or (w.get('meta') or {}).get('songs') or []
songs = [{k: s[k] for k in ('title', 'artist', 'why') if s.get(k)} for s in songs if s.get('title')]
if copy:
    tags = re.findall(r'(?:^|[\s(])#([A-Za-z0-9_]+)', copy['postDesc'])
    meta = {'hook': copy.get('hook') or copy['postDesc'].strip().split('\n')[0], 'filmTags': copy.get('filmTags') or tags[:2], 'songs': songs}
else:
    for k in ('hook', 'filmTags'): assert w['meta'].get(k), f'meta.{k} missing'
    meta = {'hook': w['meta']['hook'], 'filmTags': w['meta']['filmTags'], 'songs': songs}

payload = {'title': w['title'], 'year': int(w['year']), 'imdbId': w['imdbId'], 'runtimeSeconds': int(w['runtimeSeconds']),
           'slides': [{'caption': s['caption'], 'timecode': int(round(s['timecode'])), 'grab': s['grab']} for s in slides],
           'meta': meta, 'house': house}
if copy:
    payload['outro'] = copy['outro'].strip()
    payload['post'] = {'title': copy['postTitle'].strip(), 'description': copy['postDesc'].strip()}
os.makedirs(f'{W}/drafts', exist_ok=True)
json.dump(payload, open(f'{W}/drafts/{slug}.json', 'w'), ensure_ascii=False)
shutil.copy(f'{HERE}/draft.js', f'{W}/drafts/_draft.js')
print(f'ok {slug}: {len(payload["slides"])} slides, {"hand-written copy" if copy else f"generated copy, house set {house}"} → {W}/drafts/{slug}.json')
print('In the tab (serve.py running), once per session:  (0, eval)(await (await fetch("http://127.0.0.1:8765/drafts/_draft.js")).text())')
print(f'then:  JSON.stringify(await window.__makeDraft(await (await fetch("http://127.0.0.1:8765/drafts/{slug}.json")).json()))')
print('Record the returned id in W/ids.json as {"<slug>": "<id>"} for make-briefs.py, review.py and deliver.py.')
