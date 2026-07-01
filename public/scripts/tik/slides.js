// Pure reducers over the slide array. A slide is { id, bitmap?, caption }.
// bitmap is irrelevant to ordering/captioning, so these functions never read it.

// TikTok allows up to 35 images per photo post.
export const MAX_SLIDES = 35;

export function canAddSlide(slides) {
  return slides.length < MAX_SLIDES;
}

export function addSlide(slides, slide) {
  if (!canAddSlide(slides)) return slides;
  return [...slides, slide];
}

export function removeSlide(slides, id) {
  return slides.filter(x => x.id !== id);
}

export function reorderSlide(slides, fromIndex, toIndex) {
  if (fromIndex === toIndex) return slides;
  const next = [...slides];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function editCaption(slides, id, caption) {
  return slides.map(x => (x.id === id ? { ...x, caption } : x));
}
