export default defineAppConfig({
  docus: {
    name: 'Vigie',
    description: 'Self-hosted telemetry for Node apps: logs, traces, tasks, alerts, a status page and MCP, on OpenTelemetry and ClickHouse.',
    url: 'https://vigie.chronicstone.dev',
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
    colors: { primary: 'coral', neutral: 'slate' },
  },
  navigation: { sub: 'header' },
  toc: {
    title: 'On this page',
    bottom: {
      title: 'Community',
      links: [
        { icon: 'i-simple-icons-github', label: 'Star on GitHub', to: 'https://github.com/ChronicStone/vigie', target: '_blank' },
        { icon: 'i-simple-icons-npm', label: 'Packages on npm', to: 'https://www.npmjs.com/org/vigiejs', target: '_blank' },
        { icon: 'i-lucide-bug', label: 'Report an issue', to: 'https://github.com/ChronicStone/vigie/issues/new', target: '_blank' },
      ],
    },
  },
})
