<script setup lang="ts">
// The landing, inside the docs app so it shares Docus's top bar (logo, search, theme, GitHub).
import markup from '~/components/landing/landing.html?raw'
import '~/components/landing/landing.css'

const title = 'Self-hosted telemetry for Node apps'
const description = 'Self-hosted telemetry for Node apps, Adonis and NestJS first, on OpenTelemetry and ClickHouse, in one small process.'
useHead({ link: [{ rel: 'canonical', href: 'https://vigie.chronicstone.dev/' }] })
useSeoMeta({
  title,
  ogType: 'website',
  ogUrl: 'https://vigie.chronicstone.dev/',
  description,
  ogTitle: `Vigie: ${title}`,
  ogDescription: description,
  ogImage: 'https://vigie.chronicstone.dev/og.png',
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt: 'A pixel lighthouse sweeping the sea: Vigie, self-hosted telemetry for Node apps',
  twitterCard: 'summary_large_image',
  twitterImage: 'https://vigie.chronicstone.dev/og.png',
})

const root = ref<HTMLElement>()
let stop: (() => void) | undefined

// Links into the docs stay inside the app instead of reloading the page.
function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  const href = a?.getAttribute('href')
  if (!href || !href.startsWith('/') || a!.target || e.metaKey || e.ctrlKey || e.shiftKey) return
  e.preventDefault()
  navigateTo(href)
}

onMounted(async () => {
  const { mountLanding } = await import('~/components/landing/landing.js')
  if (root.value) stop = mountLanding(root.value)
})
onBeforeUnmount(() => stop?.())
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div ref="root" class="vl" @click="onClick" v-html="markup" />
</template>
