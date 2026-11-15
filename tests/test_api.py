"""Offline tests of the web server: no request here reaches the NASA archive."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("SPHEREX_CACHE", tempfile.mkdtemp(prefix="skyblink-test-"))
sys.path.insert(0, str(ROOT / "backend"))

try:
    from fastapi.testclient import TestClient
    import app as server
    import spherex as sx
except ImportError as e:   # pragma: no cover - dependencies missing
    raise unittest.SkipTest(f"server dependencies not installed: {e}")


class TestApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(server.app)

    def test_rejects_bad_coordinates(self):
        for q in ("ra=400&dec=0", "ra=10&dec=95", "ra=-1&dec=0"):
            r = self.client.get(f"/api/search?{q}")
            self.assertEqual(r.status_code, 400, q)
            self.assertIn("ra must be", r.json()["detail"])

    def test_unknown_api_path_is_json_404(self):
        r = self.client.get("/api/nothing-here", headers={"accept": "application/json"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("detail", r.json())

    def test_unknown_page_is_html_404(self):
        r = self.client.get("/no-such-page", headers={"accept": "text/html"})
        self.assertEqual(r.status_code, 404)
        self.assertIn("404", r.text)

    def test_home_and_explorer_pages_served(self):
        for path in ("/", "/explore.html", "/showcase/index.json"):
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_bundled_preset_search_is_offline(self):
        # Barnard's Star is pre-searched in backend/data/search, so this must
        # answer without any network access.
        with mock.patch.object(sx, "requests") as req:
            req.get.side_effect = AssertionError("network used")
            req.Session.side_effect = AssertionError("network used")
            r = self.client.get("/api/search?ra=269.4462&dec=4.7697")
        self.assertEqual(r.status_code, 200)
        self.assertGreater(len(r.json()["exposures"]), 0)

    def test_changes_busy_returns_503_with_retry_after(self):
        slots = server._changes_slots
        taken = 0
        while slots.acquire(blocking=False):
            taken += 1
        try:
            r = self.client.get("/api/changes?ra=10.1234&dec=20.5678&size=0.25")
            self.assertEqual(r.status_code, 503)
            self.assertEqual(r.headers.get("retry-after"), "30")
            self.assertIn("busy", r.json()["detail"])
        finally:
            for _ in range(taken):
                slots.release()

    def test_changes_releases_slot_on_failure(self):
        with mock.patch.object(server.detect, "stack_sweeps", side_effect=RuntimeError("boom")):
            for _ in range(5):   # more than the number of slots
                r = self.client.get("/api/changes?ra=11.1&dec=21.2&size=0.25")
                self.assertEqual(r.status_code, 502)

    def test_spectrum_stream_ends_cleanly_when_archive_stalls(self):
        exposures = [{"key": "a", "id": "1", "epoch": 0}, {"key": "b", "id": "2", "epoch": 0}]
        with mock.patch.object(server, "SPECTRUM_POINT_TIMEOUT", 0.2), \
             mock.patch.object(server.sx, "valid_key", return_value=True), \
             mock.patch.object(server.imaging, "photometry", side_effect=lambda *a: __import__("time").sleep(2)):
            r = self.client.post("/api/spectrum?ra=12.3456&dec=1.2345", json={"exposures": exposures})
        lines = [json.loads(x) for x in r.text.splitlines() if x]
        self.assertEqual(lines[0], {"total": 2})
        self.assertTrue(lines[-1].get("done"))
        self.assertTrue(lines[-1].get("partial"))
        # nothing half-measured may be cached
        cache = sx._cache_path("spectrum", "v2:12.3456:1.2345", ".json")
        self.assertFalse(cache.exists())


class TestCacheWrite(unittest.TestCase):
    def test_write_cache_is_atomic_and_leaves_no_temp_files(self):
        d = Path(tempfile.mkdtemp())
        p = d / "x.json"
        sx.write_cache(p, json.dumps({"a": 1}))
        sx.write_cache(p, b"bytes too")
        self.assertEqual(p.read_bytes(), b"bytes too")
        self.assertEqual([f.name for f in d.iterdir()], ["x.json"])

    def test_write_cache_ignores_unwritable_place(self):
        sx.write_cache(Path("/proc/definitely/not/here.json"), "x")   # must not raise


class TestExplorerHomeTargets(unittest.TestCase):
    """The Explorer lists every home-page target, and home cards do not flicker."""

    def test_explorer_loads_home_page_targets(self):
        js = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
        self.assertIn('const FEATURED_CAT = "On the home page"', js)
        self.assertIn('fetch("showcase/index.json")', js)
        self.assertIn('"Moving objects"', js)
        self.assertIn("function openPreset", js)

    def test_every_home_target_can_open_in_explorer(self):
        idx = json.loads((ROOT / "web" / "showcase" / "index.json").read_text(encoding="utf-8"))
        for t in idx["targets"]:
            fixed = isinstance(t.get("ra"), (int, float)) and isinstance(t.get("dec"), (int, float))
            # either a fixed position, or a tracked object opened in the time machine
            self.assertTrue(fixed or t.get("type") == "track", t["slug"])

    def test_home_cards_do_not_cycle(self):
        css = (ROOT / "web" / "showcase.css").read_text(encoding="utf-8")
        js = (ROOT / "web" / "showcase.js").read_text(encoding="utf-8")
        self.assertNotIn("@keyframes cycle", css)
        self.assertNotIn("animation-delay", js)


class TestHomeStory(unittest.TestCase):
    """The home page opens with a scroll-driven story over real images."""

    def test_story_markup_and_scripts(self):
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="story"', html)
        self.assertIn('id="story-canvas"', html)
        self.assertIn('story.js', html)
        self.assertIn('id="tour-start"', html)   # showcase.js needs it
        self.assertGreaterEqual(html.count('class="chapter'), 6)

    def test_story_uses_real_frames_and_no_autoplay(self):
        js = (ROOT / "web" / "story.js").read_text(encoding="utf-8")
        self.assertIn('const SLUG = "barnard"', js)
        self.assertIn("decodeF16", js)
        self.assertNotIn("setInterval", js)      # nothing blinks on its own
        self.assertTrue((ROOT / "web" / "showcase" / "barnard" / "meta.json").exists())

    def test_story_steps_between_scenes(self):
        js = (ROOT / "web" / "story.js").read_text(encoding="utf-8")
        self.assertIn("let stops = [", js)
        self.assertIn('addEventListener("wheel", onWheel, { passive: false })', js)
        self.assertIn('addEventListener("touchmove", onTouchMove, { passive: false })', js)
        css = (ROOT / "web" / "story.css").read_text(encoding="utf-8")
        self.assertIn("scrollbar-width: none", css)

    def test_old_hero_removed(self):
        js = (ROOT / "web" / "showcase.js").read_text(encoding="utf-8")
        self.assertNotIn("heroInit", js)


if __name__ == "__main__":
    unittest.main()
