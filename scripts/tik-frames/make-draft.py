# make-draft.py <slug> <houseIndex> — check a locally written set (W/writes/<slug>.json, the
# WRITE-BRIEF.md output) against the house rules and write the payload the tab turns into a draft:
#   W/drafts/<slug>.json  (fetched by draft.js's window.__makeDraft via serve.py)
#   W/drafts/_draft.js    (a copy of draft.js, so the tab can load it from the same server)
# houseIndex rotates the hashtag house set across a run of drafts (0, 1, 2, …), as batch mode does.
import json, os, shutil, sys
W = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames')
HERE = os.path.dirname(os.path.abspath(__file__))
slug, house = sys.argv[1], int(sys.argv[2])
w = json.load(open(f'{W}/writes/{slug}.json'))
assert 9 <= len(w['slides']) <= 12, f'{len(w["slides"])} slides; expected a title slide plus 8 to 11 facts'
for i, s in enumerate(w['slides']):
    for k in ('caption', 'grab'):
        assert '—' not in s[k] and '–' not in s[k], f'dash in slide {i} {k}'
    assert len(s['caption']) <= 300, f'slide {i} caption is {len(s["caption"])} chars (max 300)'
    assert len(s['grab']) <= 200, f'slide {i} grab is {len(s["grab"])} chars (max 200)'
assert w['slides'][0]['caption'].startswith(f"{w['title']} ({w['year']})\n"), 'title slide must start with "Title (Year)\\n"'
for k in ('hook', 'filmTags'): assert w['meta'].get(k), f'meta.{k} missing'
payload = {'title': w['title'], 'year': int(w['year']), 'imdbId': w['imdbId'], 'runtimeSeconds': int(w['runtimeSeconds']),
           'slides': [{'caption': s['caption'], 'timecode': int(round(s['timecode'])), 'grab': s['grab']} for s in w['slides']],
           'meta': {'hook': w['meta']['hook'], 'filmTags': w['meta']['filmTags'], 'songs': w['meta'].get('songs', [])}, 'house': house}
os.makedirs(f'{W}/drafts', exist_ok=True)
json.dump(payload, open(f'{W}/drafts/{slug}.json', 'w'), ensure_ascii=False)
shutil.copy(f'{HERE}/draft.js', f'{W}/drafts/_draft.js')
print(f'ok {slug}: {len(payload["slides"])} slides, house set {house} → {W}/drafts/{slug}.json')
print('In the tab (serve.py running), once per session:  (0, eval)(await (await fetch("http://127.0.0.1:8765/drafts/_draft.js")).text())')
print(f'then:  JSON.stringify(await window.__makeDraft(await (await fetch("http://127.0.0.1:8765/drafts/{slug}.json")).json()))')
print('Record the returned id in W/ids.json as {"<slug>": "<id>"} for make-briefs.py, review.py and deliver.py.')
