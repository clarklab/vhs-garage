import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    template: z.enum(['dispatch', 'guide']).default('dispatch'),
    excerpt: z.string().optional(),
    tags: z.array(z.string()).default([]),
    lastUpdated: z.string().optional(),
    draft: z.boolean().default(false),
    // Per-post HERO image — used at the top of the single post page
    // (large, full-bleed). Files live in /public/images/blog/{slug}.webp
    // (or .jpg / .gif). Optional — posts without an image render with
    // a small placeholder hatched block in card layouts.
    image: z.string().optional(),
    // Per-post INDEX/CARD image — what shows in card lists (homepage,
    // /blog index, category pages, videos archive). Falls back to
    // `image` when not set, so old posts keep their current behavior.
    // The motivation: hero shots are often big/animated/colorful (a
    // 12MB looping GIF, say), while index lists feel calmer with a
    // smaller B&W pixel-art teaser. Setting indexImage lets each post
    // give two answers — "what should this look like as a thumbnail"
    // and "what should this look like at the top of the page itself."
    indexImage: z.string().optional(),
    // Categories the post belongs to. A post can be in multiple (e.g. a
    // hardware review that's also written as a guide). Drives the
    // /blog/category/{slug} archive pages and the Categories dropdown in
    // BlogHeader. Default empty — posts without a category just don't
    // appear under any category page.
    categories: z.array(
      z.enum(['Tapes', 'Hardware', 'Guides', 'Collections'])
    ).default([]),
    // Set to true on posts that embed video (YouTube embed, captured clip,
    // etc.) so the "Videos" item in BlogHeader's Open menu can list them.
    // We're explicit rather than parsing the body since some videos arrive
    // as JSX components and detection would be fragile.
    hasVideo: z.boolean().default(false),
  }),
});

export const collections = { blog };
