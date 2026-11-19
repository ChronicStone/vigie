<script setup lang="ts">
// The landing at "/" ends on its own sunrise footer; the docs keep Docus's footer.
const route = useRoute()
</script>

<template>
  <UFooter v-if="route.path !== '/'">
    <template #left>
      <AppFooterLeft />
    </template>

    <template #right>
      <AppFooterRight />
    </template>
  </UFooter>
</template>
