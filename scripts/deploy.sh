#!/usr/bin/env bash
# Build, test and publish to a host that runs the nginx container in deploy/.
# Needs .deploy.env (not versioned):
#   DEPLOY_HOST=user@host  DEPLOY_DIR=~/ross-visualizer  DEPLOY_PORT=8080  PUBLIC_URL=https://...
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f .deploy.env ]] || { echo "missing .deploy.env" >&2; exit 1; }
# shellcheck disable=SC1091
source .deploy.env
: "${DEPLOY_HOST:?}" "${DEPLOY_DIR:?}" "${DEPLOY_PORT:?}"

npm test
npm run build

# Non-interactive SSH on the server does not load the usual PATH.
REMOTE_PATH='export PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin:$PATH'

ssh "$DEPLOY_HOST" "mkdir -p $DEPLOY_DIR/www"
rsync -az --delete dist/ "$DEPLOY_HOST:$DEPLOY_DIR/www/"
rsync -az deploy/docker-compose.yml deploy/nginx.conf "$DEPLOY_HOST:$DEPLOY_DIR/"
ssh "$DEPLOY_HOST" "$REMOTE_PATH; cd $DEPLOY_DIR && printf 'PORT=%s\n' '$DEPLOY_PORT' > .env && docker compose up -d --force-recreate >/dev/null && sleep 1 && curl -fsS -o /dev/null http://127.0.0.1:$DEPLOY_PORT/ && echo 'container ok'"

if [[ -n "${PUBLIC_URL:-}" ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL")
  echo "$PUBLIC_URL -> $code"
fi
