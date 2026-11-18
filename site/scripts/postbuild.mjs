// The landing page is hand-written HTML: it becomes the site's front page.
import { copyFileSync } from 'node:fs'
copyFileSync('public/landing.html', '.output/public/index.html')
console.log('landing copied to .output/public/index.html')
