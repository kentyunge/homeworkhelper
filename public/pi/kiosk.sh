#!/bin/bash
# Opens the station screen full-screen. The desktop starts this at login (set up by the installer).
DIR="$HOME/.homework-station"
# shellcheck disable=SC1091
source "$DIR/station.env"
BROWSER=$(command -v chromium || command -v chromium-browser)

# Wait for the camera program to pair and save the station's token.
for _ in $(seq 1 150); do [ -s "$DIR/token" ] && break; sleep 2; done

while true; do
  TOKEN=$(cat "$DIR/token" 2>/dev/null)
  "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
    --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 \
    --password-store=basic --disable-features=Translate --ozone-platform-hint=auto \
    "$APP_URL/station#k=$TOKEN" &
  BROWSER_PID=$!
  # If the station gets a new token (re-paired), reopen the screen with it.
  while kill -0 "$BROWSER_PID" 2>/dev/null; do
    sleep 5
    if [ "$(cat "$DIR/token" 2>/dev/null)" != "$TOKEN" ]; then
      kill "$BROWSER_PID" 2>/dev/null
      sleep 2
    fi
  done
  sleep 3
done
