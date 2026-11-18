import { defineCollection, defineContentConfig, z } from '@nuxt/content'

export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: 'page',
      source: { include: '**', prefix: '/docs', exclude: ['index.md'] },
      schema: z.object({
        links: z.array(z.object({ label: z.string(), icon: z.string(), to: z.string(), target: z.string().optional() })).optional(),
      }),
    }),
    landing: defineCollection({ type: 'page', source: { include: 'index.md' } }),
  },
})
