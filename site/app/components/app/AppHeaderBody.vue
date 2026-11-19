<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content'

const navigation = inject<Ref<ContentNavigationItem[]>>('navigation')
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- The header links, for phones, where they don't fit next to search. -->
    <div class="flex flex-wrap gap-2">
      <UButton to="/" external label="vigie.chronicstone.dev" icon="i-lucide-arrow-left" color="neutral" variant="outline" size="sm" />
      <UButton to="https://www.npmjs.com/org/vigiejs" target="_blank" label="npm" icon="i-simple-icons-npm" color="neutral" variant="ghost" size="sm" />
    </div>
    <UContentNavigation highlight variant="link" :navigation="navigation" />
  </div>
</template>
