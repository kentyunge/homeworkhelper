#!/usr/bin/env python3
"""
Homework Helper desk station: the camera side.

Watches the desk with a small, low-resolution view (free, nothing leaves the Pi) and sends a full
photo to the app only when new writing has appeared and the page has been still for a moment.

  station.py            run the station (the installer sets this up as a service)
  station.py focus      live view + sharpness score at http://<pi>:8000 for focusing the lens
  station.py --source fake:DIR   use a folder of images instead of the camera (for testing)

Settings come from ~/.homework-station/station.env (written by the installer).
"""

import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

HOME = Path(os.environ.get("STATION_HOME", Path.home() / ".homework-station"))


def load_env():
    env_file = HOME / "station.env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


load_env()

APP_URL = os.environ.get("APP_URL", "").rstrip("/")
TOKEN_FILE = Path(os.environ.get("TOKEN_FILE", HOME / "token"))
ROTATE = int(os.environ.get("ROTATE", "0"))  # degrees clockwise to rotate photos: 0, 90, 180, 270
UPLOAD_LONG_SIDE = int(os.environ.get("UPLOAD_LONG_SIDE", "2000"))

LORES = (320, 240)
STEP_S = 0.4  # how often to look at the low-res view
STILL_S = 2.0  # the page must be still this long before a photo is sent (hand out of the way)
MOTION_LEVEL = 3.0  # average pixel change between looks that counts as movement
INK_DIFF = 28  # how much a pixel must change to count as new ink
INK_FRACTION = 0.0012  # share of pixels that must change to count as new writing (~90 px at 320x240)
MIN_UPLOAD_GAP_S = 4.0
AWAKE_AFTER_MOTION_S = 10 * 60  # keep asking the app for instructions this long after movement
POLL_ACTIVE_S = 3.0
POLL_PAIRING_S = 5.0


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


# ---------------------------------------------------------------- talking to the app


class Api:
    def __init__(self, base, token=None):
        self.base = base
        self.token = token

    def request(self, method, path, body=None, content_type=None, timeout=30):
        headers = {"user-agent": "homework-station/1"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body)
                headers["content-type"] = content_type or "application/octet-stream"
            else:
                data = json.dumps(body).encode()
                headers["content-type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"{method} {path} -> {e.code}: {detail}") from None


def ensure_token(api):
    """Pair once: ask the app for a token and a code (shown on the station's screen)."""
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text().strip()
    result = api.request("POST", "/api/v1/stations/pair", {})
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(result["token"])
    TOKEN_FILE.chmod(0o600)
    log(f"Pairing code: {result['code']}  (enter it on the parent page under Desk stations)")
    return result["token"]


# ---------------------------------------------------------------- cameras


class PiCamera:
    """The Raspberry Pi camera (Camera Module 2 or 3) through picamera2."""

    def __init__(self):
        from picamera2 import Picamera2

        self.cam = Picamera2()
        full = self.cam.sensor_resolution
        config = self.cam.create_still_configuration(
            main={"size": full, "format": "RGB888"},
            lores={"size": LORES, "format": "YUV420"},
            buffer_count=2,
            display=None,
        )
        self.cam.configure(config)
        self.cam.start()
        try:  # Camera Module 3 has autofocus; Module 2 doesn't (focus it by hand, see the guide).
            from libcamera import controls

            self.cam.set_controls({"AfMode": controls.AfModeEnum.Continuous})
        except Exception:
            pass
        time.sleep(1.5)  # let exposure settle

    def gray(self):
        yuv = self.cam.capture_array("lores")
        return yuv[: LORES[1], : LORES[0]].astype(np.int16)

    def photo(self):
        rgb = self.cam.capture_array("main")
        # picamera2's "RGB888" is BGR in memory order.
        return Image.fromarray(rgb[:, :, ::-1])


class FakeCamera:
    """Plays a folder of images in name order, each for a few seconds. For testing without a Pi."""

    def __init__(self, folder, hold_s=None):
        self.files = sorted(p for p in Path(folder).iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
        if not self.files:
            raise SystemExit(f"No images in {folder}")
        self.hold = hold_s or float(os.environ.get("FAKE_HOLD_S", "6"))
        self.start = time.time()

    def current(self):
        i = min(int((time.time() - self.start) / self.hold), len(self.files) - 1)
        return Image.open(self.files[i]).convert("RGB")

    def gray(self):
        return np.asarray(self.current().convert("L").resize(LORES), dtype=np.int16)

    def photo(self):
        return self.current()


def open_camera(source):
    if source.startswith("fake:"):
        return FakeCamera(source[5:])
    return PiCamera()


def jpeg(img):
    if ROTATE:
        img = img.rotate(-ROTATE, expand=True)
    scale = UPLOAD_LONG_SIDE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


# ---------------------------------------------------------------- deciding when to send a photo


def motion(a, b):
    """Average change between two low-res views: high while a hand or pencil is moving."""
    return float(np.mean(np.abs(a - b)))


def new_ink(reference, current):
    """Share of the view that changed a lot since the last photo sent: new writing (or a new page)."""
    return float(np.mean(np.abs(current - reference) > INK_DIFF))


class Watcher:
    """Sends a photo when the page is still and differs from the last photo sent."""

    def __init__(self):
        self.previous = None
        self.still_since = time.time()
        self.reference = None
        self.last_upload = float("-inf")
        self.last_motion = time.time()

    def look(self, view, now):
        if self.previous is not None and motion(view, self.previous) > MOTION_LEVEL:
            self.still_since = now
            self.last_motion = now
        self.previous = view

    def settled(self, now):
        return now - self.still_since >= STILL_S

    def should_send(self, view, now, requested=False):
        if now - self.last_upload < MIN_UPLOAD_GAP_S:
            return False
        if requested or self.reference is None:
            return True
        return self.settled(now) and new_ink(self.reference, view) > INK_FRACTION

    def sent(self, view, now):
        self.reference = view
        self.last_upload = now

    def reset(self):
        self.reference = None


# ---------------------------------------------------------------- main loop


def run(source):
    if not APP_URL:
        raise SystemExit("APP_URL isn't set. Run the installer, or put APP_URL=https://... in ~/.homework-station/station.env")
    api = Api(APP_URL)
    while True:
        try:
            api.token = ensure_token(api)
            break
        except Exception as e:  # no network yet at boot
            log("Can't reach the app yet:", e)
            time.sleep(10)

    camera = open_camera(source)
    watcher = Watcher()
    state = {"approved": False, "watching": False, "captureRequested": False}
    next_poll = 0.0
    log("Station running. App:", APP_URL)

    while True:
        now = time.time()
        view = camera.gray()
        watcher.look(view, now)

        # Ask the app what to do only when someone's at the desk (or pairing), so an empty kitchen costs nothing.
        awake = now - watcher.last_motion < AWAKE_AFTER_MOTION_S or state["watching"]
        interval = POLL_PAIRING_S if not state["approved"] else POLL_ACTIVE_S
        if (awake or not state["approved"]) and now >= next_poll:
            next_poll = now + interval
            try:
                new_state = api.request("GET", "/api/v1/station/camera")
                if new_state.get("watching") and not state["watching"]:
                    log("Watching started")
                    watcher.reset()
                if state["watching"] and not new_state.get("watching"):
                    log("Watching stopped")
                state = new_state
            except Exception as e:
                log("Couldn't check in:", e)
                if "401" in str(e):
                    log("This station isn't paired anymore. Getting a new pairing code.")
                    TOKEN_FILE.unlink(missing_ok=True)
                    api.token = ensure_token(api)

        if state.get("watching"):
            requested = bool(state.get("captureRequested"))
            if watcher.should_send(view, now, requested):
                try:
                    data = jpeg(camera.photo())
                    path = "/api/v1/station/frames" + ("?requested=1" if requested else "")
                    result = api.request("POST", path, data, "image/jpeg", timeout=120)
                    log("Sent photo:", result)
                    if result.get("status") != "busy":
                        watcher.sent(camera.gray(), time.time())
                    state["captureRequested"] = False
                except Exception as e:
                    log("Couldn't send photo:", e)
                    watcher.last_upload = time.time()

        time.sleep(STEP_S)


# ---------------------------------------------------------------- focus helper


def sharpness(gray):
    """Higher is sharper: how strongly neighboring pixels differ (variance of a Laplacian)."""
    g = gray.astype(np.float32)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


def focus(source, port=8000):
    """Serve a live view with a sharpness score, for turning the lens until writing is crisp."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    camera = open_camera(source)
    page = """<!doctype html><meta name=viewport content="width=device-width">
<title>Focus</title><body style="background:#111;color:#eee;font:16px system-ui;margin:12px">
<p>Put a page of handwriting under the camera. Turn the lens a little at a time; higher sharpness is better.</p>
<p>Sharpness: <b id=s>…</b> (best so far <b id=b>…</b>)</p>
<img id=i style="max-width:100%;border:1px solid #444">
<script>
let best=0;async function tick(){const r=await fetch('/score');const j=await r.json();best=Math.max(best,j.score);
s.textContent=j.score.toFixed(0);b.textContent=best.toFixed(0);i.src='/frame.jpg?'+Date.now();setTimeout(tick,700)}tick()
</script>"""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path.startswith("/frame.jpg"):
                img = camera.photo()
                # Show the middle of the frame at full detail, where focus is easiest to judge.
                w, h = img.size
                crop = img.crop((w // 4, h // 4, w * 3 // 4, h * 3 // 4))
                buf = io.BytesIO()
                crop.save(buf, "JPEG", quality=80)
                body, kind = buf.getvalue(), "image/jpeg"
            elif self.path.startswith("/score"):
                img = camera.photo().convert("L")
                w, h = img.size
                center = np.asarray(img.crop((w // 4, h // 4, w * 3 // 4, h * 3 // 4)).resize((800, 600)))
                body, kind = json.dumps({"score": sharpness(center)}).encode(), "application/json"
            else:
                body, kind = page.encode(), "text/html"
            self.send_response(200)
            self.send_header("content-type", kind)
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    log(f"Focus helper: open http://{os.uname().nodename}.local:{port} (or this Pi's IP) on a phone or laptop. Ctrl+C to stop.")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    args = sys.argv[1:]
    source = "picamera"
    if "--source" in args:
        i = args.index("--source")
        source = args[i + 1]
        del args[i : i + 2]
    if args and args[0] == "focus":
        focus(source)
    else:
        run(source)
