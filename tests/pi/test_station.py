"""Tests for the desk station's photo logic. Run: python3 -m unittest discover tests/pi"""

import importlib.util
import os
import sys
import unittest
from pathlib import Path

import numpy as np

os.environ["STATION_HOME"] = "/nonexistent"
spec = importlib.util.spec_from_file_location("station", Path(__file__).parents[2] / "public/pi/station.py")
station = importlib.util.module_from_spec(spec)
sys.modules["station"] = station
spec.loader.exec_module(station)

W, H = station.LORES


def page(lines=0, hand=False, brightness=200):
    """A blank page with `lines` lines of 'writing', optionally a hand in the corner."""
    img = np.full((H, W), brightness, dtype=np.int16)
    for i in range(lines):
        y = 30 + i * 30
        img[y : y + 4, 40:160] = 40
    if hand:
        img[150:240, 200:320] = 120
    return img


class WatcherTest(unittest.TestCase):
    def test_first_view_is_sent_right_away(self):
        w = station.Watcher()
        w.look(page(1), 0)
        self.assertTrue(w.should_send(page(1), 0))

    def test_new_line_is_sent_once_the_page_is_still(self):
        w = station.Watcher()
        t = 100.0
        w.look(page(1), t)
        w.sent(page(1), t)
        # Writing: the hand moves for a while.
        for k in range(10):
            t += 0.4
            w.look(page(1, hand=k % 2 == 0), t)
            self.assertFalse(w.should_send(page(2), t), "not while the hand is moving")
        # Hand gone, new line there, still for 2 seconds.
        for _ in range(6):
            t += 0.4
            w.look(page(2), t)
        self.assertTrue(w.should_send(page(2), t))
        w.sent(page(2), t)
        t += 10
        w.look(page(2), t)
        self.assertFalse(w.should_send(page(2), t), "nothing new since the last photo")

    def test_small_lighting_changes_are_not_new_writing(self):
        w = station.Watcher()
        w.sent(page(2), 0)
        for k in range(10):
            w.look(page(2, brightness=200 + k % 3), 10 + k * 0.4)
        self.assertFalse(w.should_send(page(2, brightness=205), 20))

    def test_check_now_sends_even_without_changes(self):
        w = station.Watcher()
        w.sent(page(2), 0)
        self.assertTrue(w.should_send(page(2), 10, requested=True))

    def test_photos_are_spaced_out(self):
        w = station.Watcher()
        w.sent(page(1), 0)
        self.assertFalse(w.should_send(page(3), 1, requested=True))

    def test_sharpness_prefers_crisp_images(self):
        crisp = page(3).astype(np.float32)
        blurry = crisp.copy()
        for _ in range(4):
            blurry[1:-1, 1:-1] = (blurry[:-2, 1:-1] + blurry[2:, 1:-1] + blurry[1:-1, :-2] + blurry[1:-1, 2:]) / 4
        self.assertGreater(station.sharpness(crisp), station.sharpness(blurry) * 3)


class ProblemsTest(unittest.TestCase):
    def test_backoff_doubles_up_to_a_minute_and_resets(self):
        b = station.Backoff()
        self.assertTrue(b.ready(0))
        self.assertEqual([b.failed(0) for _ in range(6)], [6, 12, 24, 48, 60, 60])
        self.assertFalse(b.ready(59))
        self.assertTrue(b.ready(60))
        b.succeeded()
        self.assertTrue(b.ready(0))

    def test_camera_problems_are_explained(self):
        self.assertIn("apt install -y python3-picamera2", station.camera_problem(ModuleNotFoundError("No module named 'picamera2'")))
        self.assertIn("ribbon cable", station.camera_problem(IndexError("list index out of range")))
        self.assertIn("isn't working", station.camera_problem(RuntimeError("weird")))


class SoundTest(unittest.TestCase):
    def test_run_quiet_explains_failures(self):
        self.assertIsNone(station.run_quiet(["true"], timeout=5))
        self.assertIn("isn't installed", station.run_quiet(["no-such-player-xyz"], timeout=5))
        self.assertIn("failed", station.run_quiet(["false"], timeout=5))
        self.assertIn("didn't finish", station.run_quiet(["sleep", "3"], timeout=1))

    def test_explains_when_the_sound_system_is_missing(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get("XDG_RUNTIME_DIR")
            os.environ["XDG_RUNTIME_DIR"] = d
            try:
                self.assertIn("isn't running", station.audio_problem())
                self.assertIn("isn't running", station.play_tone())
                open(f"{d}/pipewire-0", "w").close()
                self.assertIsNone(station.audio_problem())
            finally:
                if old is None:
                    del os.environ["XDG_RUNTIME_DIR"]
                else:
                    os.environ["XDG_RUNTIME_DIR"] = old

    def test_never_uses_aplay(self):
        self.assertIn(station.player(), ("pw-play", "paplay"))

    def test_speaker_says_each_thing_once(self):
        said = []
        sp = station.Speaker(api=None)
        sp.say = lambda speech: said.append(speech["text"])
        sp.handle({"id": 1, "text": "hello", "provider": "browser"})
        sp.thread.join()
        sp.handle({"id": 1, "text": "hello", "provider": "browser"})
        sp.handle(None)
        self.assertEqual(said, ["hello"])
        sp.handle({"id": 2, "text": "next", "provider": "browser"})
        sp.thread.join()
        self.assertEqual(said, ["hello", "next"])


if __name__ == "__main__":
    unittest.main()
