#!/usr/bin/env bash
# Deploy to the shared host: sync the repo, keep (or create) the server's secrets, build and
# start the stack, and install the nginx site with a certificate on the first run.
#
#   DEPLOY_HOST=root@<server-ip> infra/server/deploy.sh      (from the repository root)
#
# The server's address is not in Git: the domain is behind Cloudflare, which hides it.
#
# Secrets are generated ON the server, once, into /opt/pitstop/.env.prod (mode 600); they
# never pass through this machine or Git.
set -euo pipefail
HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. DEPLOY_HOST=root@<server-ip>}"
DIR="${DEPLOY_DIR:-/opt/pitstop}"
DOMAIN="${DEPLOY_DOMAIN:-pitstop.mardonjon.me}"

rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .venv --exclude .git \
  --exclude /output --exclude /samples --exclude /models --exclude /ai \
  --exclude '__pycache__' --exclude .pytest_cache --exclude .ruff_cache --exclude test-results \
  --exclude 'apps/web/public/ort' --exclude 'apps/web/public/maplibre' \
  --exclude '.env' --exclude '.env.*' --exclude '**/.env' --exclude .DS_Store \
  ./ "$HOST:$DIR/"

ssh "$HOST" DIR="$DIR" DOMAIN="$DOMAIN" 'bash -s' <<'REMOTE'
set -euo pipefail
cd "$DIR"
if [ ! -f .env.prod ]; then
  umask 077
  cat > .env.prod <<ENV
DOMAIN=$DOMAIN
ENVIRONMENT=demo
AUTH_DISABLED=true
POSTGRES_PASSWORD=$(openssl rand -hex 24)
MINIO_ROOT_USER=pitstop
MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
RATE_LIMIT_PER_MINUTE=1200
ENV
  echo "created .env.prod"
fi
docker compose -p pitstop -f docker-compose.prod.yml -f infra/server/docker-compose.server.yml \
  --env-file .env.prod up -d --build
if [ ! -e "/etc/nginx/sites-enabled/$DOMAIN" ]; then
  cp infra/server/pitstop.nginx.conf "/etc/nginx/sites-available/$DOMAIN"
  ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
  nginx -t && systemctl reload nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --redirect
fi
docker compose -p pitstop -f docker-compose.prod.yml -f infra/server/docker-compose.server.yml --env-file .env.prod ps
REMOTE
