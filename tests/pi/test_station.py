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


if __name__ == "__main__":
    unittest.main()
