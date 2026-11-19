// The landing's "Search docs" button links to /docs/...?search: open the search there.
export default defineNuxtPlugin(() => {
  onNuxtReady(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('search')) return
    url.searchParams.delete('search')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    useContentSearch().open.value = true
  })
})
