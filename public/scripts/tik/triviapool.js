// The trivia pool behind the picker: hold every ranked item IMDb has for a
// film, show the best N, and refill instantly when one is thrown out.
//
// The whole thing is one ranked array plus a set of rejected ids. "Visible" is
// simply the first N survivors, so dropping the item in slot 3 slides #11 up
// into view with no bookkeeping, no re-fetch, and no way for a refill to hand
// back something already rejected. Restoring is just as cheap, which is what
// makes undo possible.
//
// No DOM and no network — app.js owns both. Unit-tested.

export const DEFAULT_PICK = 10;
export const MAX_PICK = 25;

// items: the ranked list from the server (most helpful first).
export function createTriviaPool(items, size = DEFAULT_PICK) {
  let order = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.text === 'string' && it.text.trim())
    .map((it, i) => ({ ...it, id: String(it.id || `i${i}`), rank: i + 1 }));
  const dropped = new Set();
  let pick = clampSize(size);

  const survivors = () => order.filter((it) => !dropped.has(it.id));

  return {
    // The N items currently on screen, best first.
    visible: () => survivors().slice(0, pick),
    // Ranked items waiting behind the visible ones.
    benchCount: () => Math.max(0, survivors().length - pick),
    // Everything the user threw out, in the order it was ranked.
    removed: () => order.filter((it) => dropped.has(it.id)),
    total: () => order.length,
    size: () => pick,

    // True when the bench ran dry and we can no longer fill every slot — the
    // UI says so out loud rather than quietly showing a short list.
    exhausted: () => survivors().length < pick,

    // Throw one out. The next-best unrejected item takes its slot.
    remove(id) {
      const key = String(id);
      if (!order.some((it) => it.id === key) || dropped.has(key)) return false;
      dropped.add(key);
      return true;
    },

    // Undo a removal. The item returns to its ranked position, pushing the
    // lowest-ranked visible item back onto the bench.
    restore(id) {
      return dropped.delete(String(id));
    },

    // Drop every currently visible item at once and pull up a fresh set —
    // "none of these, show me the next ten".
    replaceAll() {
      for (const it of survivors().slice(0, pick)) dropped.add(it.id);
      return this.visible();
    },

    reset() {
      dropped.clear();
      return this.visible();
    },

    setSize(n) {
      pick = clampSize(n);
      return this.visible();
    },

    // Re-rank by an agent's ordering of ids, attaching its reason to each item.
    // Ids it didn't mention keep their existing relative order behind the ones
    // it did, so the bench stays sensible and nothing is ever lost.
    //
    // Only the ORDER changes — `dropped` is untouched, so items already thrown
    // out stay out, and visible() is still just "the first N survivors". That
    // is what keeps delete-and-refill working across a re-rank.
    applyOrder(ids, why = {}) {
      const wanted = (Array.isArray(ids) ? ids : []).map(String);
      const rank = new Map(wanted.map((id, i) => [id, i]));
      const known = new Set(order.map((it) => it.id));
      if (!wanted.some((id) => known.has(id))) return this.visible(); // nothing matched; leave as-is

      order = order
        .map((it, i) => ({ ...it, why: why[it.id] || it.why || '', curated: rank.has(it.id), _was: i }))
        .sort((a, b) => {
          const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
          const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
          return ra - rb || a._was - b._was; // ties and leftovers keep vote order
        })
        .map(({ _was, ...it }) => it);
      return this.visible();
    },

    // The best N survivors, independent of what's on screen — the candidate
    // list for curation, which needs more than the visible ten to choose from.
    top: (n) => survivors().slice(0, Math.max(0, Math.round(Number(n) || 0))),

    // True once an agent ranking has been applied.
    isCurated: () => order.some((it) => it.curated),
  };
}

function clampSize(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_PICK;
  return Math.min(MAX_PICK, Math.max(1, v));
}

// Compact "2.2K helpful" style label for a pool item, so the picker shows the
// same signal IMDb does. Exact counts under 1000, rounded above.
export function helpfulLabel(item) {
  const up = Math.max(0, Math.round(Number(item?.up) || 0));
  if (!up) return 'no votes yet';
  if (up >= 1_000_000) return `${trimZero((up / 1_000_000).toFixed(1))}M helpful`;
  if (up >= 1_000) return `${trimZero((up / 1_000).toFixed(1))}K helpful`;
  return `${up} helpful`;
}

function trimZero(s) {
  return s.replace(/\.0$/, '');
}
