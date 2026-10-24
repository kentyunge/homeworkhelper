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

import glob
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
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


def use_desktop_audio():
    """
    The station runs as a background service, which doesn't automatically see the desktop's sound
    system (PipeWire). Without it, audio tools open the sound card directly and lock everyone else out.
    Point them at the logged-in user's PipeWire instead.
    """
    runtime = f"/run/user/{os.getuid()}"
    os.environ.setdefault("XDG_RUNTIME_DIR", runtime)
    os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime}/bus")
    os.environ.setdefault("PULSE_SERVER", f"unix:{runtime}/pulse/native")


use_desktop_audio()

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
POLL_WATCHING_S = 1.5  # faster while someone's working, so replies are spoken promptly
POLL_PAIRING_S = 5.0


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


# ---------------------------------------------------------------- talking to the app


class Api:
    def __init__(self, base, token=None):
        self.base = base
        self.token = token

    def fetch(self, method, path, timeout=60):
        """Raw bytes (e.g. audio). Raises RuntimeError with the app's error message on failure."""
        headers = {"user-agent": "homework-station/1"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=b"" if method == "POST" else None, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            try:
                message = json.loads(raw).get("error") or raw[:300]
            except Exception:
                message = raw[:300]
            raise RuntimeError(message) from None

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


# ---------------------------------------------------------------- sound
# The Pi's own audio (PipeWire) works even when the kiosk browser's sound doesn't, so the station
# speaks from here: ElevenLabs MP3s through mpg123, otherwise the built-in voice through spd-say.


def run_quiet(cmd, timeout):
    """Run a command; return an error message, or None if it worked."""
    if not shutil.which(cmd[0]):
        return f"{cmd[0]} isn't installed. Rerun the installer."
    try:
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        return f"{cmd[0]} didn't finish within {timeout} seconds (the audio output may be stuck)"
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip().splitlines()
        return f"{cmd[0]} failed: {detail[-1] if detail else f'exit code {result.returncode}'}"
    return None


def default_output():
    """The name of the speaker PipeWire plays to by default (e.g. 'USB Audio' or 'Built-in Audio'), or None."""
    if not shutil.which("wpctl"):
        return None
    try:
        out = subprocess.run(["wpctl", "inspect", "@DEFAULT_AUDIO_SINK@"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    for key in ("node.description", "node.nick", "node.name"):
        for line in out.splitlines():
            if key in line and "=" in line:
                return line.split("=", 1)[1].strip().strip('"')
    return None


def player():
    # Only players that go through PipeWire; plain aplay would take over the sound card.
    for cmd in ("pw-play", "paplay"):
        if shutil.which(cmd):
            return cmd
    return "pw-play"


def audio_problem():
    """Why sound can't play right now, or None. Checked before playing anything."""
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    if not (os.path.exists(f"{runtime}/pipewire-0") or os.path.exists(f"{runtime}/pulse/native")):
        return "The Pi's sound system (PipeWire) isn't running for this user. Rerun the installer and restart."
    return None


def play_tone():
    """A half-second tone, to test the speaker without any voice involved."""
    if audio_problem():
        return audio_problem()
    rate = 22050
    t = np.arange(int(rate * 0.5)) / rate
    fade = np.minimum(1, np.minimum(t, t[::-1]) * 40)
    samples = (np.sin(2 * np.pi * 660 * t) * fade * 12000).astype(np.int16)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    try:
        return run_quiet([player(), path], timeout=10)
    finally:
        os.unlink(path)


def say_builtin(text):
    if audio_problem():
        return audio_problem()
    return run_quiet(["spd-say", "-w", "-l", "en", text], timeout=30)


def play_mp3(data):
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        if audio_problem():
            return audio_problem()
        # "-o pulse" plays through PipeWire (never straight to the sound card).
        return run_quiet(["mpg123", "-q", "-o", "pulse", path], timeout=60)
    finally:
        os.unlink(path)


class Speaker:
    """Speaks one thing at a time in the background, so the camera keeps watching."""

    def __init__(self, api):
        self.api = api
        self.last_id = None
        self.thread = None

    def handle(self, speech):
        if not speech or speech.get("id") == self.last_id:
            return
        self.last_id = speech["id"]
        if self.thread and self.thread.is_alive():
            return  # still talking; this one is skipped rather than talking over itself
        self.thread = threading.Thread(target=self.say, args=(speech,), daemon=True)
        self.thread.start()

    def say(self, speech):
        text = speech.get("text", "")
        if speech.get("provider") == "elevenlabs":
            try:
                problem = play_mp3(self.api.fetch("GET", f"/api/v1/station/speech/{speech['id']}"))
                if not problem:
                    return
                log("Natural voice failed:", problem)
            except Exception as e:
                log("Natural voice failed, using the built-in voice:", e)
        problem = say_builtin(text)
        if problem:
            log("Built-in voice failed:", problem)


def sound_check(api, check_id, name):
    """Test the speaker, the built-in voice and ElevenLabs, and report each result to the screen."""
    results = []

    def add(label, problem, ok_text):
        results.append({"name": label, "ok": problem is None, "detail": problem or ok_text})
        log(f"Sound check, {label}:", problem or "ok")

    output = default_output()
    tone = play_tone()
    if tone and "didn't finish" in tone:
        tone += ". Another program may be holding the sound device: see 'No sound' in the setup guide."
    add("Speaker", tone, f"Played a tone through: {output}." if output else "Played a tone (couldn't tell which output).")
    add("Built-in voice", say_builtin(f"Hi, this is {name}. This is the built-in voice."), "Spoke with the built-in voice.")
    try:
        audio = api.fetch("POST", "/api/v1/station/voice-test")
        add("Natural voice (ElevenLabs)", play_mp3(audio), "Played a natural voice clip.")
    except Exception as e:
        add("Natural voice (ElevenLabs)", str(e), "")
    try:
        api.request("POST", "/api/v1/station/sound-check/results", {"id": check_id, "results": results})
    except Exception as e:
        log("Couldn't report sound check:", e)


class TouchWatcher:
    """Notices taps on the touchscreen (any input device), so a tap wakes the station like movement does."""

    def __init__(self):
        self.files = []
        for path in glob.glob("/dev/input/event*"):
            try:
                self.files.append(os.open(path, os.O_RDONLY | os.O_NONBLOCK))
            except OSError:
                pass

    def touched(self):
        hit = False
        for fd in self.files:
            try:
                while os.read(fd, 4096):
                    hit = True
            except (BlockingIOError, OSError):
                pass
        return hit


# ---------------------------------------------------------------- main loop


def camera_problem(error):
    """A plain-language reason the camera couldn't be used, shown on the station's screen."""
    text = str(error)
    if isinstance(error, ModuleNotFoundError) and "picamera2" in text:
        return "The camera software isn't installed. On the Pi, run: sudo apt install -y python3-picamera2"
    if isinstance(error, IndexError) or "list index out of range" in text or "no cameras" in text.lower():
        return "No camera found. Check the camera's ribbon cable at both ends."
    if "busy" in text.lower() or "in use" in text.lower():
        return "The camera is in use by another program (like the focus helper). Restart the station."
    return f"The camera isn't working: {text[:200]}"


class Backoff:
    """Waits longer after each failure in a row (6 s, 12 s, 24 s... up to a minute), so errors don't pile up."""

    def __init__(self, first=6.0, most=60.0):
        self.first, self.most, self.wait, self.until = first, most, 0.0, 0.0

    def ready(self, now):
        return now >= self.until

    def failed(self, now):
        self.wait = min(self.most, max(self.first, self.wait * 2))
        self.until = now + self.wait
        return self.wait

    def succeeded(self):
        self.wait, self.until = 0.0, 0.0


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

    def report_camera(problem):
        try:
            api.request("POST", "/api/v1/station/status", {"cameraError": problem})
        except Exception as e:
            log("Couldn't report camera status:", e)

    def open_with_retries():
        while True:
            try:
                cam = open_camera(source)
                report_camera(None)
                return cam
            except Exception as e:
                problem = camera_problem(e)
                log(problem)
                report_camera(problem)
                time.sleep(30)

    camera = open_with_retries()
    watcher = Watcher()
    speaker = Speaker(api)
    touch = TouchWatcher()
    checks_done = set()
    sending = Backoff()
    polling = Backoff(first=5.0)
    state = {"approved": False, "watching": False, "captureRequested": False}
    next_poll = 0.0
    log("Station running. App:", APP_URL)

    while True:
        now = time.time()
        try:
            view = camera.gray()
        except Exception as e:
            problem = camera_problem(e)
            log(problem)
            report_camera(problem)
            time.sleep(5)
            camera = open_with_retries()
            continue
        watcher.look(view, now)
        if touch.touched():
            watcher.last_motion = now  # a tap on the screen wakes the station too
            next_poll = min(next_poll, now)

        # Ask the app what to do only when someone's at the desk (or pairing), so an empty kitchen costs nothing.
        awake = now - watcher.last_motion < AWAKE_AFTER_MOTION_S or state["watching"]
        interval = POLL_PAIRING_S if not state["approved"] else POLL_WATCHING_S if state["watching"] else POLL_ACTIVE_S
        if (awake or not state["approved"]) and now >= next_poll and polling.ready(now):
            next_poll = now + interval
            try:
                new_state = api.request("GET", "/api/v1/station/camera")
                polling.succeeded()
                if new_state.get("watching") and not state["watching"]:
                    log("Watching started")
                    watcher.reset()
                    sending.succeeded()
                if state["watching"] and not new_state.get("watching"):
                    log("Watching stopped")
                state = new_state
                speaker.handle(state.get("speech"))
                check = state.get("soundCheck")
                if check and check["id"] not in checks_done:
                    checks_done.add(check["id"])
                    threading.Thread(target=sound_check, args=(api, check["id"], "the desk station"), daemon=True).start()
            except Exception as e:
                log(f"Couldn't check in (trying again in {polling.failed(now):.0f}s):", e)
                if "-> 401" in str(e):
                    log("This station isn't paired anymore. Getting a new pairing code.")
                    TOKEN_FILE.unlink(missing_ok=True)
                    api.token = ensure_token(api)

        if state.get("watching") and sending.ready(now):
            requested = bool(state.get("captureRequested"))
            if watcher.should_send(view, now, requested):
                try:
                    data = jpeg(camera.photo())
                    path = "/api/v1/station/frames" + ("?requested=1" if requested else "")
                    result = api.request("POST", path, data, "image/jpeg", timeout=120)
                    log("Sent photo:", result)
                    sending.succeeded()
                    if result.get("status") != "busy":
                        watcher.sent(camera.gray(), time.time())
                    state["captureRequested"] = False
                except Exception as e:
                    # The app explains the problem on the station's screen; wait before trying again.
                    log(f"Couldn't send photo (trying again in {sending.failed(time.time()):.0f}s):", e)
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
