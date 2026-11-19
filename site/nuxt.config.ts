export default defineNuxtConfig({
  extends: ['docus'],
  css: ['~/assets/css/main.css'],
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
  nitro: {
    // Plain static files in .output/public everywhere, Vercel included: the landing is copied in after the build.
    preset: 'static',
    prerender: {
      // The landing page is static HTML served at / by Vercel, so the crawl starts in the docs.
      routes: ['/docs/getting-started/introduction'],
      // "/" is the hand-written landing, written by scripts/postbuild.mjs.
      ignore: [/^\/$/],
      crawlLinks: true,
      failOnError: false,
    },
  },
})
