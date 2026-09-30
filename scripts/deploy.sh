#!/usr/bin/env bash
set -euo pipefail

# KysoQR deploy script — Server mode (see docs/DEPLOY.md).
#
# Run from inside the cloned repo on the server (e.g. /opt/kysoqr),
# as the app's dedicated user. Used both for the first deploy and every
# redeploy afterwards. Never touches .env (gitignored; `git reset --hard`
# below only affects tracked files) and never invents its own build/start
# steps — reuses exactly the scripts already declared in package.json.
#
# Usage: ./scripts/deploy.sh [branch]   (default: main)

BRANCH="${1:-main}"
SERVICE_NAME="kysoqr"
UNIT_FILE="deploy/${SERVICE_NAME}.service"

echo "==> Fetching '${BRANCH}'..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/${BRANCH}"

echo "==> Installing dependencies..."
npm install

echo "==> Building..."
npm run build

echo "==> Restarting service (${SERVICE_NAME})..."
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" | grep -q "${SERVICE_NAME}.service"; then
  sudo systemctl restart "$SERVICE_NAME"
  sudo systemctl status "$SERVICE_NAME" --no-pager
else
  echo "Service '${SERVICE_NAME}' isn't installed yet — this looks like a first deploy."
  echo "One-time setup:"
  echo "  sudo cp ${UNIT_FILE} /etc/systemd/system/"
  echo "  sudo systemctl daemon-reload"
  echo "  sudo systemctl enable --now ${SERVICE_NAME}"
fi

echo "==> Done."
