#!/bin/bash
# deploy.sh — Build frontend + deploy with _worker.js

set -e
cd "$(dirname "$0")"

echo "=== Building NextJS ==="
cd frontend
NEXT_TELEMETRY_DISABLED=1 npx next build
cd ..

echo "=== Copying _worker.js ==="
cp _worker.js frontend/out/_worker.js

echo "=== Deploying to Cloudflare Pages ==="
# Token 請勿直接寫在檔案裡，設定環境變數：
# export CLOUDFLARE_API_TOKEN=cfat_XXXX
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN not set"
  exit 1
fi
npx wrangler pages deploy frontend/out/ --commit-dirty=true 2>&1

echo "=== Done ==="