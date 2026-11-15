"""Scientific consistency: one number per measurement, checked against catalogues."""

import json
import math
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import motion  # noqa: E402

SHOW = ROOT / "web" / "showcase"


def metas():
    idx = json.loads((SHOW / "index.json").read_text(encoding="utf-8"))
    return idx, {t["slug"]: json.loads((SHOW / t["slug"] / "meta.json").read_text(encoding="utf-8")) for t in idx["targets"]}


class TestMotionMaths(unittest.TestCase):
    def test_fit_recovers_a_known_motion(self):
        # 3 arcsec/px, star moving 9 arcsec/yr due north (y decreases), 2 years
        mjds = [60000, 60000 + 365.25, 60000 + 730.5]
        track = [{"x": 100, "y": 100}, {"x": 100, "y": 97}, {"x": 100, "y": 94}]
        m = motion.fit(track, mjds, 3.0, shift_arcsec=18, significance=9)
        self.assertAlmostEqual(m["rate_arcsec_per_year"], 9.0, places=1)
        self.assertEqual(m["pa_deg"], 0)
        self.assertEqual(m["direction"], "north")
        self.assertAlmostEqual(m["rate_err_arcsec_per_year"], 1.0, places=1)

    def test_east_is_left(self):
        mjds = [0, 365.25]
        m = motion.fit([{"x": 50, "y": 50}, {"x": 48, "y": 50}], mjds, 3.0, 6, 6)
        self.assertEqual(m["pa_deg"], 90)
        self.assertEqual(m["direction"], "east")

    def test_compare_flags_disagreement(self):
        m = {"rate_arcsec_per_year": 5.0, "rate_err_arcsec_per_year": 0.5, "pa_deg": 0, "pa_err_deg": 5}
        self.assertTrue(motion.compare(m, 0, 5200, "x")["agrees"])
        self.assertFalse(motion.compare(m, 0, 9000, "x")["agrees"])     # 8 sigma too fast
        self.assertFalse(motion.compare(m, 5000, 0, "x")["agrees"])     # 90 degrees off


class TestShowcaseNumbers(unittest.TestCase):
    def test_every_mover_has_one_rate_with_uncertainty_and_a_catalogue_check(self):
        _, ms = metas()
        movers = 0
        for slug, m in ms.items():
            for c in m.get("changes", []):
                if c["kind"] != "moved":
                    continue
                movers += 1
                for k in ("rate_arcsec_per_year", "rate_err_arcsec_per_year", "pa_deg", "pa_err_deg", "direction"):
                    self.assertIn(k, c, f"{slug}: {k}")
                self.assertEqual(c["direction"], motion.compass(c["pa_deg"]), slug)
                self.assertIn("catalogue", c, f"{slug}: no catalogue comparison")
                self.assertTrue(c["catalogue"]["agrees"], f"{slug}: {c['catalogue']}")
        self.assertEqual(movers, 6)

    def test_text_quotes_the_same_rate(self):
        idx, ms = metas()
        for t in idx["targets"]:
            m = ms[t["slug"]]
            for c in m.get("changes", []):
                if c["kind"] == "moved" and c.get("catalogue"):
                    self.assertIn(str(c["rate_arcsec_per_year"]), t["summary"], t["slug"])
                    self.assertNotIn(f"{c['shift_arcsec']} arcsec", t["summary"], f"{t['slug']}: quotes the raw shift")

    def test_no_second_number_in_target_notes(self):
        """Target notes must not carry their own speed next to the measurement."""
        idx, _ = metas()
        for t in idx["targets"]:
            if (t.get("kinds") or {}).get("moved"):
                self.assertIsNone(re.search(r"arcsec", t["note"]), t["slug"])

    def test_comet_dates_match_frames(self):
        _, ms = metas()
        m = ms["3i-atlas"]
        from datetime import datetime, timedelta
        last = (datetime(1858, 11, 17) + timedelta(days=m["frames"][-1]["mjd"])).strftime("%d %b %Y")
        self.assertEqual(m["facts"]["last_date"], last)

    def test_page_code_has_no_mixed_motion_formats(self):
        js = (ROOT / "web" / "showcase.js").read_text(encoding="utf-8")
        self.assertNotIn("shift_arcsec / c.rate_arcsec_per_year", js)   # the old "9.1 in 1.0 years"
        self.assertNotIn("Fairly sure", js)
        story = (ROOT / "web" / "story.js").read_text(encoding="utf-8")
        self.assertNotIn("shift_arcsec", story)
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("Eleven places", html)


if __name__ == "__main__":
    unittest.main()
