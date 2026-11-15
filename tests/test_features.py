"""
Comprehensive verification test suite for Sky Blink.
Validates:
- Reliability (timeouts, retries, 404 page, 150/150 bundled presets)
- Real per-exposure spectra (no invented values, no fake band images)
- Pre-computed offline target spectra for all 11 showcase targets
- Real steps vs. Blend mode with "(not observed)" labelling
- Citizen Science flag and candidate review queue with "a report ready to share" export
- Vercel function configuration
"""

import gzip
import json
import os
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

class TestSkyBlinkFeatures(unittest.TestCase):
    def test_vercel_configuration(self):
        vpath = ROOT / "vercel.json"
        self.assertTrue(vpath.exists(), "vercel.json must exist")
        with open(vpath, "r", encoding="utf-8") as f:
            vconf = json.load(f)
        
        # Verify valid Vercel services configuration for FastAPI
        services = vconf.get("services", {})
        self.assertIn("sky-blink", services, "sky-blink service must be defined")
        self.assertEqual(services["sky-blink"].get("framework"), "fastapi")
        self.assertEqual(services["sky-blink"].get("entrypoint"), "api/index.py")

    def test_custom_404_page(self):
        page_404 = ROOT / "web" / "404.html"
        self.assertTrue(page_404.exists(), "web/404.html must exist")
        content = page_404.read_text(encoding="utf-8")
        self.assertIn("404", content)
        self.assertIn("Deep space — Uncharted territory", content)
        self.assertIn("Return to Sky Blink Home", content)
        self.assertIn("Open Sky Explorer", content)

    def test_backend_custom_404_handler(self):
        app_file = ROOT / "backend" / "app.py"
        content = app_file.read_text(encoding="utf-8")
        self.assertIn("custom_http_exception_handler", content)
        self.assertIn("404.html", content)

    def test_search_timeout_and_retry(self):
        app_js = ROOT / "web" / "app.js"
        content = app_js.read_text(encoding="utf-8")
        self.assertIn("25000", content, "Search should use 25-second timeout")
        self.assertNotIn("The NASA archive is busy", content, "Do not blame NASA for our own timeouts")
        self.assertIn("took longer than 25 seconds", content)
        self.assertIn("retrying", content, "Search should support automatic retry")

    def test_all_150_presets_shipped(self):
        search_dir = ROOT / "backend" / "data" / "search"
        self.assertTrue(search_dir.exists(), "backend/data/search directory must exist")
        preset_files = list(search_dir.glob("*.json.gz"))
        self.assertEqual(
            len(preset_files),
            150,
            f"Expected exactly 150 bundled presets, found {len(preset_files)}"
        )

        # Check presets contain coordinates, epochs, and exposures
        for p in preset_files[:20]:
            with gzip.open(p, "rt", encoding="utf-8") as f:
                data = json.load(f)
            self.assertIn("ra", data)
            self.assertIn("dec", data)
            self.assertIn("epochs", data)
            self.assertIn("exposures", data)
            self.assertGreater(len(data["exposures"]), 0, f"Preset {p.name} has no exposures")
            self.assertGreater(len(data["epochs"]), 0, f"Preset {p.name} has no epochs")

    def test_showcase_spectra_are_real_measurements(self):
        """Spectra come from tools/build_spectra.py: one point per measured
        exposure, never more points than exposures, errors not a fixed
        fraction of the flux (the sign of invented values)."""
        showcase_dir = ROOT / "web" / "showcase"
        targets = [d for d in showcase_dir.iterdir() if d.is_dir()]
        self.assertGreaterEqual(len(targets), 11)
        for t in targets:
            meta = json.loads((t / "meta.json").read_text(encoding="utf-8"))
            spec, src = meta.get("spectrum"), meta.get("spectrum_source")
            self.assertTrue(spec, f"{t.name}: no spectrum")
            self.assertIsNotNone(src, f"{t.name}: spectrum has no recorded source")
            self.assertEqual(src["measured"], len(spec))
            self.assertLessEqual(src["measured"], src["exposures"])
            self.assertIn("Not calibrated", src["method"])
            ratios = [p["err"] / p["flux"] for p in spec if p["flux"] > 0]
            mean = sum(ratios) / len(ratios)
            spread = (sum((r - mean) ** 2 for r in ratios) / len(ratios)) ** 0.5 / mean
            self.assertGreater(spread, 0.05, f"{t.name}: errors look like a fixed fraction of flux")
        barnard = json.loads((showcase_dir / "barnard" / "meta.json").read_text(encoding="utf-8"))
        long = [p["flux"] for p in barnard["spectrum"] if p["lam"] > 4]
        self.assertGreater(min(long), 1000, "Barnard's Star is bright at 4-5 um in real data")

    def test_web_ui_elements(self):
        index_html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        
        # The fake band selector is gone: SPHEREx band images were never built
        self.assertNotIn('id="band-bar"', index_html)
        
        # Blend toggle with Real steps and Blend
        self.assertIn('id="blend-toggle"', index_html)
        self.assertIn('value="blend"', index_html)
        self.assertIn('value="steps"', index_html)
        
        # Citizen science findings & review queue
        self.assertIn('id="flag-btn"', index_html)
        self.assertIn('id="open-findings"', index_html)
        self.assertIn('id="review-candidates-btn"', index_html)
        self.assertIn('id="flag-modal"', index_html)
        self.assertIn('id="review-modal"', index_html)
        self.assertIn('id="findings-modal"', index_html)
        self.assertIn('id="spectrum-card"', index_html)

    def test_showcase_js_logic(self):
        showcase_js = (ROOT / "web" / "showcase.js").read_text(encoding="utf-8")
        
        # No invented brightness: no per-target scaling of pixel values
        self.assertNotIn("scaleFactors", showcase_js)
        self.assertNotIn("isBrownDwarf", showcase_js)
        
        # Real steps vs blend
        self.assertIn('blendMode === "steps"', showcase_js)
        self.assertIn("(not observed)", showcase_js, "Blended frames must be labelled 'not observed'")
        self.assertIn("a real observation", showcase_js)
        self.assertIn('blendMode: "steps"', showcase_js, "Real images are the default")
        
        # Citizen science wording
        self.assertIn("A report ready to share", showcase_js, "Findings must be worded as 'A report ready to share'")
        self.assertIn("exportFindingsCSV", showcase_js)
        self.assertIn("exportFindingsJSON", showcase_js)
        
        # Tour guard
        self.assertIn("T.i = listIdx", showcase_js, "Tour pill must stay synced to target")

    def test_how_page_documentation(self):
        how_html = (ROOT / "web" / "how.html").read_text(encoding="utf-8")
        self.assertNotIn("methane", how_html)
        self.assertNotIn("calibrated multi-epoch", how_html)
        self.assertIn("not calibrated", how_html)
        self.assertIn("Citizen science: Flag findings", how_html)
        self.assertIn("Real steps vs Blend", how_html)
        self.assertIn("not observed", how_html)
        self.assertIn("report ready to share", how_html)

if __name__ == "__main__":
    unittest.main()
