<script setup lang="ts">
// "/" is the hand-written landing page (public/landing.html, copied to index.html after the build).
// Inside the docs app, a link to "/" (the header logo) lands here: load the real page instead of a 404.
if (import.meta.client && !import.meta.dev) window.location.replace('/')
useHead({ meta: [{ 'http-equiv': 'refresh', content: '0; url=/' }] })
</script>

<template>
  <div />
</template>
