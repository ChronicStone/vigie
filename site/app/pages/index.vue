<script setup lang="ts">
// "/" is the hand-written landing page (public/landing.html, copied to index.html after the build).
// Inside the docs app, a link to "/" (the header logo) lands here: load the real page instead of a 404.
// A second redirect within 3 s means the landing is missing: stop there instead of reloading forever.
if (import.meta.client && !import.meta.dev) {
  const last = Number(sessionStorage.getItem('vigie:to-landing') || 0)
  if (Date.now() - last > 3000) {
    sessionStorage.setItem('vigie:to-landing', String(Date.now()))
    window.location.replace('/')
  }
}
</script>

<template>
  <div />
</template>
