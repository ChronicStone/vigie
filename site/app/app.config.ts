export default defineAppConfig({
  docus: {
    name: 'Vigie',
    description: 'Self-hosted telemetry for Node apps: logs, traces, tasks, alerts, a status page and MCP, on OpenTelemetry and ClickHouse.',
    url: 'https://vigie-docs.vercel.app',
  },
  seo: {
    titleTemplate: '%s · Vigie',
    title: 'Vigie',
    description: 'Self-hosted telemetry for Node apps: logs, traces, tasks, alerts, a status page and MCP, on OpenTelemetry and ClickHouse.',
  },
  github: {
    owner: 'ChronicStone',
    name: 'vigie',
    url: 'https://github.com/ChronicStone/vigie',
    branch: 'main',
    rootDir: 'site',
  },
  header: {
    title: 'Vigie',
    logo: { alt: 'Vigie', light: '/logo-light.svg', dark: '/logo-dark.svg', favicon: '/favicon.svg', class: 'h-6 w-auto' },
  },
  ui: {
    colors: { primary: 'coral', neutral: 'stone' },
  },
  socials: {
    github: 'https://github.com/ChronicStone/vigie',
  },
})
