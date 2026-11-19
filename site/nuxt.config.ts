export default defineNuxtConfig({
  extends: ['docus'],
  css: ['~/assets/css/main.css'],
  // Docus links /favicon.ico, which this site doesn't ship: the SVG mark is the icon everywhere.
  app: { head: { link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }] } },
  // The landing is a night scene: the docs open in the same night, and the toggle still offers day.
  colorMode: { preference: 'dark', fallback: 'dark' },
  // The logos are SVG and need no resizing; Vercel's image service is not part of a static deploy.
  image: { provider: 'none' },
  ogImage: {
    fonts: ['Funnel+Display:600', 'Geist:400', 'Geist:500'],
  },
  site: {
    name: 'Vigie',
    url: 'https://vigie.chronicstone.dev',
  },
  llms: {
    domain: 'https://vigie.chronicstone.dev',
    title: 'Vigie',
    description: 'Self-hosted telemetry for Node apps: logs, traces, tasks, alerts, a status page and MCP, on OpenTelemetry and ClickHouse. Adonis and NestJS in one command.',
  },
  // Nuxt 4.4's payload cache rejects the key "/", which fails the prerender of the home page.
  experimental: { payloadExtraction: false },
  nitro: {
    // Plain static files in .output/public everywhere, Vercel included.
    preset: 'static',
    prerender: {
      routes: ['/', '/docs/getting-started/introduction'],
      crawlLinks: true,
      failOnError: false,
    },
  },
})
