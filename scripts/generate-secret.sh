#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Insight Replay — generate a cryptographically secure secret
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/generate-secret.sh
#
# Prints a 32-byte (256-bit) random value, base64-encoded. Use it to fill in
# SESSION_SECRET and/or ENCRYPTION_KEY in your .env file. Run it twice —
# the two values MUST be different (a single leaked key should not give an
# attacker both cookie-signing and PII-decryption power).
#
# Requirements: openssl (preinstalled on macOS/Linux; bundled with Git for
# Windows). If openssl is missing, fall back to:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl not found. Falling back to Node.js crypto." >&2
  if command -v node >/dev/null 2>&1; then
    SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  else
    echo "ERROR: neither openssl nor node is available. Install one of them." >&2
    exit 1
  fi
else
  SECRET="$(openssl rand -base64 32)"
fi

cat <<EOF
Generated secret (32 bytes, base64):
  $SECRET

Strength check (must be valid):
EOF

# Re-check the secret's strength using the app's own validator so we
# guarantee the value will be accepted at boot time. Falls back to a
# simple length heuristic if bun isn't installed.
if command -v bun >/dev/null 2>&1; then
  bun -e "
    const { validateSecretStrength } = require('./src/lib/crypto');
    const r = validateSecretStrength(process.argv[1]);
    console.log('  valid:', r.valid, '| score:', r.score + '/5');
    if (r.issues.length) console.log('  issues:', r.issues.join('; '));
  " "$SECRET" 2>/dev/null || echo "  (skipped — couldn't load crypto module)"
else
  LEN="${#SECRET}"
  echo "  length: $LEN chars (>= 16 required)"
fi

cat <<EOF

Add to your .env file as:
  SESSION_SECRET=$SECRET
  ENCRYPTION_KEY=<run this script again to get a DIFFERENT value>

Reminder: SESSION_SECRET and ENCRYPTION_KEY must be DIFFERENT values.
EOF
