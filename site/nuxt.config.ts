export default defineNuxtConfig({
  extends: ['docus'],
  css: ['~/assets/css/main.css'],
  site: {
    name: 'Vigie',
    url: 'https://vigie-docs.vercel.app',
  },
  nitro: {
    prerender: {
      // The landing page is static HTML served at / by Vercel, so the crawl starts in the docs.
      routes: ['/docs/getting-started/introduction'],
      crawlLinks: true,
      failOnError: false,
    },
  },
})
