#!/bin/bash

export DISPLAY=:0
export HOME=/home/logisource

# ==========================================
# LS Inventory TFT Kiosk
# Resolution: 320x480 Portrait
# ==========================================

# Disable screen blanking
xset -dpms 2>/dev/null || true
xset s off 2>/dev/null || true
xset s noblank 2>/dev/null || true

echo "Waiting for LS Inventory..."

while ! curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1
do
    sleep 1
done

echo "LS Inventory ready."
echo "Starting Chromium kiosk 320x480..."

exec /usr/sbin/runuser \
    -u logisource \
    -- \
    /usr/bin/env \
    DISPLAY=:0 \
    HOME=/home/logisource \
    /usr/bin/chromium \
    --kiosk \
    --no-first-run \
    --no-default-browser-check \
    --noerrdialogs \
    --disable-session-crashed-bubble \
    --disable-infobars \
    --disable-translate \
    --disable-features=Translate \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --window-position=0,0 \
    --window-size=320,480 \
    --force-device-scale-factor=1 \
    --user-data-dir=/home/logisource/.config/lsinventory-kiosk \
    http://127.0.0.1:3000
