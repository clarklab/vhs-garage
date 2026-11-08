# make-briefs.py — W/briefs/<slug>.md for every fresh draft in W/ids.json: the picker's fact sheet,
# built from the library dump (W/inbox/facts.json, from dump-facts.js) plus the writer's visible /
# stand-in flags and notes from W/writes/<slug>.json. W/films.json maps slug → movie file.
import json, os
W = os.environ.get('TIK_FRAMES_WORK') or os.path.expanduser('~/.cache/vhs-tik-frames')
films = json.load(open(f'{W}/films.json')); ids = json.load(open(f'{W}/ids.json'))
facts = {p['id']: p for p in json.load(open(f'{W}/inbox/facts.json'))}
os.makedirs(f'{W}/briefs', exist_ok=True)
for slug, pid in ids.items():
    p = facts[pid]; w = json.load(open(f'{W}/writes/{slug}.json'))
    L = [f"# {p['title']} ({p['year']}) — slug `{slug}`", '', f"Film: `{films[slug]}`", f"Draft id: {pid}", '',
         f"This is a FRESH draft: pick all {len(p['slides'])} slides (0 to {len(p['slides'])-1}). Every current time is only the writer's guess.", '']
    for s in p['slides']:
        ws = w['slides'][s['i']] if s['i'] < len(w['slides']) else {}
        L += [f"## Slide {s['i']}" + (' — TITLE SLIDE' if s['kind'] == 'title' else ''),
              f"Caption: {s['caption'].strip()}",
              f"Hint (the writer's guess at the shot, not gospel): {s['hint'].strip() or '(none)'}",
              f"Writer's guess at the time: {s['t']}s"]
        if s['kind'] != 'title':
            L.append('On screen? ' + ("YES, the fact's subject appears in the film; find that moment." if ws.get('visible', True)
                     else "NO, this fact is about something not shown; pick a STAND-IN (standIn: true) of the person/scene it is about, as the hint says."))
            if ws.get('note'): L.append(f"Writer's note: {ws['note']}")
        L.append('')
    open(f'{W}/briefs/{slug}.md', 'w').write('\n'.join(L)); print(slug, len(p['slides']), 'slides →', f'{W}/briefs/{slug}.md')
