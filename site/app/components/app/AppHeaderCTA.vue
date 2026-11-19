<script setup lang="ts">
// Header links next to search. "Site" is a full page load: "/" is the hand-written landing, not a docs route.
const links = [
  { label: 'Docs', to: '/docs/getting-started/introduction', icon: 'i-lucide-book-open' },
  { label: 'npm', to: 'https://www.npmjs.com/org/vigiejs', icon: 'i-simple-icons-npm', target: '_blank' },
]
</script>

<template>
  <div class="hidden md:flex items-center gap-1">
    <UButton
      v-for="link in links"
      :key="link.label"
      v-bind="link"
      color="neutral"
      variant="ghost"
      size="sm"
    />
    <UButton
      to="/"
      external
      label="vigie.chronicstone.dev"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="outline"
      size="sm"
      class="ml-1"
    />
  </div>
</template>
