<script setup lang="ts">
// "/" is the hand-written landing page (public/landing.html, copied to index.html after the build).
// Inside the docs app, a link to "/" (the header logo) lands here: load the real page instead of a 404.
// The marker stops a second redirect if "/" ever served this app instead of the landing. No storage needed.
if (import.meta.client && !import.meta.dev && !new URLSearchParams(window.location.search).has('from')) {
  window.location.replace('/?from=docs')
}
</script>

<template>
  <div />
</template>
