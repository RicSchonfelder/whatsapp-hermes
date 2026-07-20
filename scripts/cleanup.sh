#!/usr/bin/env bash
# scripts/cleanup.sh — remove temporary operational artifacts from the
# whatsapp-hermes project root.
#
# SAFETY: this script ONLY deletes log files (*.log) and the generated QR
# image (qr_pair.png). It NEVER touches wa_auth/ (WhatsApp session secrets)
# or .env (configuration secrets). Those are git-ignored on purpose.
#
# Usage:  bash scripts/cleanup.sh   (run from project root, or anywhere)

set -euo pipefail

# Resolve project root regardless of where the script is called from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT"

echo "Cleaning temporary artifacts in: $ROOT"

# Remove log files in the root (not inside wa_auth/).
shopt -s nullglob
for f in *.log; do
  echo "  rm $f"
  rm -f "$f"
done
shopt -u nullglob

# Remove the generated QR image (contains a live pairing secret — safe to drop once paired).
if [ -f qr_pair.png ]; then
  echo "  rm qr_pair.png"
  rm -f qr_pair.png
fi

echo "Done. wa_auth/ and .env were left untouched."
