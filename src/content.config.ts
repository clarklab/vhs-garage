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
    // Per-post hero image. Files live in /public/images/blog/{slug}.webp
    // (or .jpg). Optional — posts without an image render with a small
    // placeholder hatched block in card layouts.
    image: z.string().optional(),
  }),
});

export const collections = { blog };
