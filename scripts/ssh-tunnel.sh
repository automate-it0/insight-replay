#!/bin/bash
# ─── SSH tunnel to insight-replay (port 81) ───
# Run this on YOUR machine (not the server) to access insight-replay
# safely without exposing port 81 to the internet.
#
# Usage: ./ssh-tunnel.sh user@your-server-ip
# Then open: http://localhost:81

SERVER="${1:-root@your-server-ip}"
echo "🔌 Creating SSH tunnel to ${SERVER}:81 → localhost:81"
echo "   Open: http://localhost:81"
echo "   Press Ctrl+C to close tunnel"
ssh -N -L 81:localhost:81 "${SERVER}"
