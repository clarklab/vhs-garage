// Wikipedia source material for autopilot: film articles' Production/Filming/
// Casting sections are where most published movie trivia originates. Grounding
// the model in them beats pure recall. extractFilmSections() is pure (tested);
// fetchFilmSource() hits Wikipedia's free API (no key; UA per their etiquette).

const UA = 'vhs-garage-tik/1.0 (https://vhsgarage.com)';
const RELEVANT_HEADING = /production|filming|develop|casting|effects|music|score|post-produc|pre-produc|writing|stunts|makeup|design|editing|cinematograph/i;
const LEAD_MAX = 1500;

// Given a plaintext Wikipedia extract ("== Heading ==" markers), keep the lead
// plus the production-adjacent sections, capped at maxChars.
export function extractFilmSections(plaintext, maxChars = 12000) {
  const text = String(plaintext || '');
  if (!text.trim()) return '';

  // Split into [lead, h1, body1, h2, body2, …] on top-level "== Heading ==".
  const parts = text.split(/^==\s*([^=\n]+?)\s*==\s*$/m);
  const lead = (parts[0] || '').trim().slice(0, LEAD_MAX);
  const kept = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const heading = parts[i].trim();
    const body = (parts[i + 1] || '').replace(/^===.*$/gm, '').trim(); // drop sub-headings, keep prose
    if (RELEVANT_HEADING.test(heading) && body) kept.push(`${heading}:\n${body}`);
  }

  if (!kept.length && !lead) return '';
  return [lead, ...kept].filter(Boolean).join('\n\n').slice(0, maxChars);
}

// Find the film's article and return { pageTitle, text } of the relevant
// sections, or null when nothing usable is found. Throws only on abort.
export async function fetchFilmSource(title, year, signal) {
  const q = [title, year, 'film'].filter(Boolean).join(' ');
  const searchUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=' + encodeURIComponent(q);
  const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': UA }, signal });
  if (!searchRes.ok) { console.warn('[tik-wiki] search failed', { status: searchRes.status }); return null; }
  const searchData = await searchRes.json().catch(() => ({}));
  const pageTitle = searchData?.query?.search?.[0]?.title;
  if (!pageTitle) { console.warn('[tik-wiki] no article found', { q }); return null; }

  const extractUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=' + encodeURIComponent(pageTitle);
  const exRes = await fetch(extractUrl, { headers: { 'User-Agent': UA }, signal });
  if (!exRes.ok) { console.warn('[tik-wiki] extract failed', { pageTitle, status: exRes.status }); return null; }
  const exData = await exRes.json().catch(() => ({}));
  const pages = exData?.query?.pages || {};
  const extract = Object.values(pages)[0]?.extract || '';
  const text = extractFilmSections(extract);
  if (!text) { console.warn('[tik-wiki] no relevant sections', { pageTitle }); return null; }
  return { pageTitle, text };
}
