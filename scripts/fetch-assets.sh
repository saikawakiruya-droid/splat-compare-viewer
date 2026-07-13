#!/usr/bin/env bash
# Download the splat assets listed in assets-manifest.json into public/.
#
# Usage:
#   ASSET_BASE_URL="https://your-shared-storage/path" ./scripts/fetch-assets.sh
#
# ASSET_BASE_URL should point to a location hosting the files by the exact
# names in assets-manifest.json (e.g. a shared Drive folder exported as direct
# links, an S3/R2 bucket, or any static host). Files already present are skipped.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p public

if ! command -v jq >/dev/null 2>&1; then
  echo "jq が必要です (brew install jq)。または public/ に手動で配置してください。" >&2
  echo "必要なファイル:" >&2
  sed -n 's/.*"\(.*\.[a-z]*\)".*/  \1/p' assets-manifest.json >&2 || true
  exit 1
fi

if [ -z "${ASSET_BASE_URL:-}" ]; then
  echo "ASSET_BASE_URL が未設定です。" >&2
  echo "共有ストレージのベースURLを指定して再実行するか、以下を public/ に手動で置いてください:" >&2
  jq -r '.files[] | "  " + .' assets-manifest.json >&2
  exit 1
fi

BASE="${ASSET_BASE_URL%/}"
for f in $(jq -r '.files[]' assets-manifest.json); do
  if [ -f "public/$f" ]; then
    echo "skip  public/$f (既に存在)"
    continue
  fi
  echo "fetch $BASE/$f -> public/$f"
  curl -fSL "$BASE/$f" -o "public/$f"
done
echo "完了。npx vite で起動してください。"
