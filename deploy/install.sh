#!/bin/sh
# Installs Vigie on a server with Docker. Safe to run again: it keeps secrets and data.
#   deploy/install.sh                     private, on 127.0.0.1 (reach it with Tailscale or an SSH tunnel)
#   deploy/install.sh --domain vigie.you.com   public, with HTTPS from Caddy
set -eu
cd "$(dirname "$0")"
domain=""
[ "${1:-}" = "--domain" ] && domain="${2:?give the domain}"

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 is required."; exit 1; }

secret() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40; }

if [ ! -f .env ]; then
  umask 077
  {
    echo "CLICKHOUSE_PASSWORD=$(secret)"
    echo "BETTER_AUTH_SECRET=$(secret)"
    if [ -n "$domain" ]; then
      echo "VIGIE_PUBLIC_URL=https://$domain"
      echo "VIGIE_DOMAIN=$domain"
    else
      echo "VIGIE_PUBLIC_URL=http://localhost:4310"
    fi
  } > .env
  echo "Wrote deploy/.env with fresh secrets (mode 600)."
fi

profile=""
[ -n "$domain" ] && profile="--profile public"
# shellcheck disable=SC2086
docker compose $profile up -d --build --wait

code=$(docker compose exec -T vigie sh -c 'cat /data/setup-code 2>/dev/null || true')
key=$(docker compose exec -T vigie bun cli/vigie.ts setup 2>/dev/null | sed -n 's/^  *\(vk_[A-Za-z0-9_-]*\)$/\1/p' | head -1)
url=$(sed -n 's/^VIGIE_PUBLIC_URL=//p' .env)

echo
echo "Vigie is running at $url"
[ -n "$code" ] && echo "First sign-in: create the owner with setup code $code"
[ -n "$key" ] && echo "Ingest key, shown once: $key"
echo
echo "Point a service at it:"
if [ -n "$domain" ]; then echo "  OTEL_EXPORTER_OTLP_ENDPOINT=$url/otlp"; else echo "  OTEL_EXPORTER_OTLP_ENDPOINT=http://<this-host>:4318"; fi
echo "  OTEL_EXPORTER_OTLP_HEADERS=authorization=<your ingest key>"
