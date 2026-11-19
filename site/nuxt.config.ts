export default defineNuxtConfig({
  extends: ['docus'],
  css: ['~/assets/css/main.css'],
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
      crawlLinks: true,
      failOnError: false,
    },
  },
})
