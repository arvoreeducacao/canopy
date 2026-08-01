#!/bin/sh
set -e
DATA="${CANOPY_DATA_DIR:-/data}"
CDP_PORT="${CANOPY_CDP_PORT:-9222}"
mkdir -p "$DATA/profile"

# Chromium supervised in a loop — the daemon already retries the CDP port
# every 3s, so a crashed browser reattaches by itself. The profile lives on
# the /data volume: logins survive restarts and redeploys.
(
  while true; do
    # The profile survives container replacement (volume), but its Singleton*
    # files reference the previous container's hostname/pid — Chromium refuses
    # to start with them present. Safe to clear: nothing else uses the profile.
    rm -f "$DATA/profile/SingletonLock" "$DATA/profile/SingletonCookie" "$DATA/profile/SingletonSocket"
    "${CHROME_BIN:-chromium}" \
      --headless=new \
      --remote-debugging-port="$CDP_PORT" \
      --remote-debugging-address=127.0.0.1 \
      --user-data-dir="$DATA/profile" \
      --no-first-run --no-default-browser-check \
      --disable-session-crashed-bubble --hide-crash-restore-bubble \
      --no-sandbox --disable-dev-shm-usage --disable-gpu \
      --window-size=1440,900 \
      about:blank || true
    echo "[entrypoint] chromium exited — restarting in 1s"
    sleep 1
  done
) &

exec node /app/bin/canopy.js
