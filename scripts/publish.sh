#!/bin/sh
# Publishes every Vigie package to npm under @vigiejs, in dependency order.
# Each publish opens npm in your browser to confirm with your security key.
set -e
cd "$(dirname "$0")/.."
for dir in packages/sdk packages/adonis packages/nestjs .; do
  name=$(node -p "require('./$dir/package.json').name")
  version=$(node -p "require('./$dir/package.json').version")
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "✓ $name@$version is already on npm"
    continue
  fi
  echo "→ publishing $name@$version"
  (cd "$dir" && npm publish --access public --auth-type=web)
done
echo "All Vigie packages are on npm."
