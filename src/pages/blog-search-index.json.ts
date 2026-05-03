// Build-time JSON index for the blog search. Astro renders this as a
// static file at /blog-search-index.json which the BlogHeader's search
// (powered by Fuse.js) fetches once on first focus and queries
// client-side. Drafts excluded.
//
// We strip MDX-style imports/exports and JSX tags from the body to
// keep the index smaller and the search relevance stronger (matching
// "<AmazonCard>" or import statements would never be useful). Plain
// markdown markers (# headers, **bold**, links) are kept since they
// don't hurt search and stripping them adds risk for marginal benefit.

import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

function stripMdxNoise(raw: string): string {
  return raw
    .replace(/^---[\s\S]*?---/m, '')              // frontmatter (defensive — should already be parsed away)
    .replace(/^import\s.+$/gm, '')                 // mdx imports
    .replace(/^export\s.+$/gm, '')                 // mdx exports
    .replace(/<[A-Z][A-Za-z0-9]*\b[^>]*\/?>/g, '') // self-closing JSX tags
    .replace(/<\/?[A-Z][A-Za-z0-9]*\b[^>]*>/g, '') // open/close JSX tags
    .replace(/\n{3,}/g, '\n\n')                    // collapse runs of blank lines
    .trim();
}

export const GET: APIRoute = async () => {
  const posts = await getCollection('blog');
  const index = posts
    .filter((p) => !p.data.draft)
    .map((p) => ({
      slug: p.id.replace(/\.(md|mdx)$/, ''),
      title: p.data.title,
      description: p.data.description,
      categories: p.data.categories || [],
      hasVideo: p.data.hasVideo || false,
      image: p.data.image || null,
      pubDate: p.data.pubDate.toISOString(),
      body: stripMdxNoise(p.body || ''),
    }));
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json' },
  });
};
