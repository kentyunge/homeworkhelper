#!/bin/bash
# Homework Helper desk station installer, for a Raspberry Pi with Raspberry Pi OS (with desktop).
# Run as your normal user (not with sudo):
#   curl -fsSL https://<your app>/pi/install | bash
# Set HYPERPIXEL=no to skip turning on the HyperPixel 4.0 screen.
set -euo pipefail

APP_URL="__APP_URL__"
DIR="$HOME/.homework-station"
REBOOT=0

if [ "$(id -u)" = 0 ]; then
  echo "Run this as your normal user, not with sudo. It asks for your password when it needs it."
  exit 1
fi
case "$APP_URL" in
  http*) ;;
  *) echo "Download this installer from the app: curl -fsSL https://<your app>/pi/install | bash"; exit 1 ;;
esac

echo "==> Installing packages (a few minutes)"
sudo apt-get update
CHROMIUM=chromium
apt-cache show chromium >/dev/null 2>&1 || CHROMIUM=chromium-browser
sudo apt-get install -y python3-picamera2 python3-numpy python3-pil "$CHROMIUM" speech-dispatcher espeak-ng rpicam-apps || \
  sudo apt-get install -y python3-picamera2 python3-numpy python3-pil "$CHROMIUM" speech-dispatcher espeak-ng

echo "==> Checking the camera"
if ! /usr/bin/python3 -c "import picamera2" 2>/dev/null; then
  echo "The camera software (python3-picamera2) didn't install. This needs Raspberry Pi OS (64-bit, with desktop)."
  echo "Check the system with: cat /etc/os-release"
  exit 1
fi
CAMERAS=$(/usr/bin/python3 -c "from picamera2 import Picamera2; print(len(Picamera2.global_camera_info()))" 2>/dev/null || echo 0)
if [ "$CAMERAS" = "0" ]; then
  echo "WARNING: no camera found. Shut down (sudo shutdown now), unplug, and reseat the camera's ribbon cable:"
  echo "  on the Pi, metal contacts face the HDMI ports; on the camera, they face the circuit board."
  echo "The rest of the setup continues; the station shows a message until the camera is found."
else
  echo "Camera found."
fi

echo "==> Downloading the station program"
mkdir -p "$DIR"
curl -fsSL "$APP_URL/pi/station.py" -o "$DIR/station.py"
curl -fsSL "$APP_URL/pi/kiosk.sh" -o "$DIR/kiosk.sh"
chmod +x "$DIR/station.py" "$DIR/kiosk.sh"
if [ ! -f "$DIR/station.env" ]; then
  cat > "$DIR/station.env" <<CONF
APP_URL=$APP_URL
# Turn photos if the camera is mounted sideways or upside down: 0, 90, 180 or 270 (clockwise)
ROTATE=0
CONF
else
  sed -i "s#^APP_URL=.*#APP_URL=$APP_URL#" "$DIR/station.env"
fi

echo "==> Starting the camera program at boot"
sudo tee /etc/systemd/system/homework-station.service >/dev/null <<UNIT
[Unit]
Description=Homework Helper desk station camera
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
ExecStart=/usr/bin/python3 $DIR/station.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable homework-station
sudo systemctl restart homework-station

echo "==> Opening the station screen when the desktop starts"
# labwc (current Raspberry Pi OS)
mkdir -p "$HOME/.config/labwc"
grep -qs "homework-station" "$HOME/.config/labwc/autostart" || echo "$DIR/kiosk.sh &" >> "$HOME/.config/labwc/autostart"
# Wayfire (older Bookworm images)
if [ -f "$HOME/.config/wayfire.ini" ] && ! grep -qs "homework-station" "$HOME/.config/wayfire.ini"; then
  printf '\n[autostart]\nhomework = %s\n' "$DIR/kiosk.sh" >> "$HOME/.config/wayfire.ini"
fi
# X11 desktop
mkdir -p "$HOME/.config/lxsession/LXDE-pi"
grep -qs "homework-station" "$HOME/.config/lxsession/LXDE-pi/autostart" || echo "@$DIR/kiosk.sh" >> "$HOME/.config/lxsession/LXDE-pi/autostart"

echo "==> Signing in to the desktop automatically and keeping the screen on"
sudo raspi-config nonint do_boot_behaviour B4 || true
sudo raspi-config nonint do_blanking 1 || true

CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt
if [ "${HYPERPIXEL:-yes}" = "yes" ] && ! grep -qs "hyperpixel4" "$CONFIG"; then
  echo "==> Turning on the HyperPixel 4.0 screen"
  printf '\n# HyperPixel 4.0 screen (added by Homework Helper)\ndtoverlay=vc4-kms-dpi-hyperpixel4\n' | sudo tee -a "$CONFIG" >/dev/null
  REBOOT=1
fi

echo
echo "Done."
sleep 3
CODE=$(journalctl -u homework-station -n 50 --no-pager 2>/dev/null | grep -o "Pairing code: [A-Z0-9]*" | tail -1 || true)
[ -n "$CODE" ] && echo "$CODE  (also shown on the station's screen)"
echo "Next: on the parent page, open Desk stations and enter the pairing code."
echo "To focus the camera: sudo systemctl stop homework-station && python3 $DIR/station.py focus"
if [ "$REBOOT" = 1 ]; then
  echo "Restarting in 10 seconds to turn on the screen (Ctrl+C to restart later yourself)..."
  sleep 10
  sudo reboot
fi
