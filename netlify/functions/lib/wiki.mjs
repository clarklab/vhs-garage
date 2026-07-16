// Wikipedia source material for the tik agents. Film articles' Production/
// Filming/Casting sections are where most published movie trivia originates;
// actor articles' Career sections ground the "Remembering Some Guys" role
// lists. Grounding the model in them beats pure recall. The extract*() helpers
// are pure (tested); the fetch*() helpers hit Wikipedia's free API (no key;
// UA per their etiquette).

const UA = 'vhs-garage-tik/1.0 (https://vhsgarage.com)';
const FILM_HEADING = /production|filming|develop|casting|effects|music|score|post-produc|pre-produc|writing|stunts|makeup|design|editing|cinematograph/i;
const ACTOR_HEADING = /career|film|television|acting|roles|work|legacy|reception/i;
const LEAD_MAX = 1500;

// Given a plaintext Wikipedia extract ("== Heading ==" markers), keep the lead
// plus the sections whose headings match `headingRe`, capped at maxChars.
function extractSections(plaintext, headingRe, maxChars) {
  const text = String(plaintext || '');
  if (!text.trim()) return '';

  // Split into [lead, h1, body1, h2, body2, …] on top-level "== Heading ==".
  const parts = text.split(/^==\s*([^=\n]+?)\s*==\s*$/m);
  const lead = (parts[0] || '').trim().slice(0, LEAD_MAX);
  const kept = [];
  for (let i = 1; i < parts.length - 1; i += 2) {
    const heading = parts[i].trim();
    const body = (parts[i + 1] || '').replace(/^===.*$/gm, '').trim(); // drop sub-headings, keep prose
    if (headingRe.test(heading) && body) kept.push(`${heading}:\n${body}`);
  }

  if (!kept.length && !lead) return '';
  return [lead, ...kept].filter(Boolean).join('\n\n').slice(0, maxChars);
}

// Film articles: lead + production-adjacent sections.
export function extractFilmSections(plaintext, maxChars = 12000) {
  return extractSections(plaintext, FILM_HEADING, maxChars);
}

// Actor articles: lead + career/filmography-adjacent sections.
export function extractActorSections(plaintext, maxChars = 10000) {
  return extractSections(plaintext, ACTOR_HEADING, maxChars);
}

// Shared: search for an article, fetch its plaintext extract. Returns
// { pageTitle, extract } or null; throws only on abort.
async function fetchExtract(query, signal) {
  const searchUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=' + encodeURIComponent(query);
  const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': UA }, signal });
  if (!searchRes.ok) { console.warn('[tik-wiki] search failed', { status: searchRes.status }); return null; }
  const searchData = await searchRes.json().catch(() => ({}));
  const pageTitle = searchData?.query?.search?.[0]?.title;
  if (!pageTitle) { console.warn('[tik-wiki] no article found', { query }); return null; }

  const extractUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=' + encodeURIComponent(pageTitle);
  const exRes = await fetch(extractUrl, { headers: { 'User-Agent': UA }, signal });
  if (!exRes.ok) { console.warn('[tik-wiki] extract failed', { pageTitle, status: exRes.status }); return null; }
  const exData = await exRes.json().catch(() => ({}));
  const pages = exData?.query?.pages || {};
  const extract = Object.values(pages)[0]?.extract || '';
  return { pageTitle, extract };
}

// Find the film's article and return { pageTitle, text } of the relevant
// sections, or null when nothing usable is found. Throws only on abort.
export async function fetchFilmSource(title, year, signal) {
  const q = [title, year, 'film'].filter(Boolean).join(' ');
  const found = await fetchExtract(q, signal);
  if (!found) return null;
  const text = extractFilmSections(found.extract);
  if (!text) { console.warn('[tik-wiki] no relevant sections', { pageTitle: found.pageTitle }); return null; }
  return { pageTitle: found.pageTitle, text };
}

// Find the actor's article and return { pageTitle, text } of the career-
// adjacent sections, or null when nothing usable is found. Throws only on abort.
export async function fetchActorSource(name, signal) {
  const found = await fetchExtract(`${name} actor`, signal);
  if (!found) return null;
  const text = extractActorSections(found.extract);
  if (!text) { console.warn('[tik-wiki] no relevant actor sections', { pageTitle: found.pageTitle }); return null; }
  return { pageTitle: found.pageTitle, text };
}
