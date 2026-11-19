// The landing page is hand-written HTML: it becomes the site's front page.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const out = '.output/public'
const site = 'https://vigie.chronicstone.dev'

copyFileSync('public/landing.html', `${out}/index.html`)
console.log(`landing copied to ${out}/index.html`)

// Search engines need absolute URLs, and the landing page belongs in the sitemap too.
const sitemap = `${out}/sitemap.xml`
if (existsSync(sitemap)) {
  let xml = readFileSync(sitemap, 'utf8').replace(/<loc>\//g, `<loc>${site}/`)
  if (!xml.includes(`<loc>${site}/</loc>`)) xml = xml.replace(/(<urlset[^>]*>)/, `$1\n  <url>\n    <loc>${site}/</loc>\n  </url>`)
  writeFileSync(sitemap, xml)
  console.log('sitemap URLs made absolute')
}
