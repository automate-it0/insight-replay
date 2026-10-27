#!/bin/bash
# scripts/cron-purge.sh
# ----------------------------------------------------------------------------
# Cron job to purge sessions older than 90 days.
#
# Add to crontab (runs daily at 3 AM server time):
#     0 3 * * * /home/z/my-project/scripts/cron-purge.sh >> /home/z/my-project/logs/cron-purge.log 2>&1
#
# Required env vars:
#   ADMIN_TOKEN  — must match process.env.ADMIN_TOKEN on the server. If unset,
#                  the script refuses to run (the server would 401 the request
#                  anyway, but failing here produces a clearer log line).
#
# Optional env vars:
#   HOST  — base URL of the Insight Replay server (default: http://localhost:3000)
#   DAYS  — retention window in days (default: 90; must match server's expectation)
# ----------------------------------------------------------------------------
set -uo pipefail

ADMIN_TOKEN="${ADMIN_TOKEN:-}"
HOST="${HOST:-http://localhost:3000}"
DAYS="${DAYS:-90}"

if [ -z "$ADMIN_TOKEN" ]; then
  echo "$(date -Iseconds) ERROR: ADMIN_TOKEN env var not set — refusing to run."
  exit 1
fi

RESPONSE=$(curl -s -X POST --max-time 120 \
  "${HOST}/api/admin/retention-purge?days=${DAYS}" \
  -H "x-admin-token: ${ADMIN_TOKEN}")

echo "$(date -Iseconds) purge response: ${RESPONSE}"
