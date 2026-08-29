#!/usr/bin/env bash
set -euo pipefail
cd /opt/LS_Inventory

echo "== Pre-flight sensitive file check =="
BAD=$(git status --porcelain | awk '{print $2}' | grep -E '(^|/)(\.env|device\.db|central\.db|license\.json)$|core\.[0-9]+$' || true)
if [ -n "$BAD" ]; then
  echo "WARNING: sensitive/runtime files detected in working tree:"
  echo "$BAD"
fi

echo "== Git status =="
git status --short

echo "== Stage production source/docs only =="
git add README.md docs assets scripts services central app.js views public package.json package-lock.json .gitignore 2>/dev/null || true

echo "== Verify staged files =="
git diff --cached --name-only

if git diff --cached --name-only | grep -E '(^|/)(\.env|device\.db|central\.db|license\.json)$|core\.[0-9]+$'; then
  echo "ABORT: sensitive/runtime file is staged."
  exit 1
fi

echo "Safe staging check passed."
echo "Run manually when ready:"
echo '  git commit -m "Update LS Inventory production documentation"'
echo '  git push origin main'
