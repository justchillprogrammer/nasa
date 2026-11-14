"""
Comprehensive verification test suite for Sky Blink.
Validates:
- Reliability (timeouts, retries, 404 page, 150/150 bundled presets)
- 6 SPHEREx detector bands (0.75 - 5.0 um)
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
        
        funcs = vconf.get("functions", {})
        api_func = funcs.get("api/index.py", {})
        self.assertGreaterEqual(
            api_func.get("maxDuration", 0),
            60,
            "maxDuration must be at least 60 seconds"
        )

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
        self.assertIn("The NASA archive is busy", content, "Search should have friendly busy message")
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

    def test_showcase_precomputed_spectra(self):
        showcase_dir = ROOT / "web" / "showcase"
        targets = [d for d in showcase_dir.iterdir() if d.is_dir()]
        self.assertGreaterEqual(len(targets), 11, "Expected at least 11 showcase targets")

        for t in targets:
            meta_path = t / "meta.json"
            self.assertTrue(meta_path.exists(), f"Missing meta.json in {t.name}")
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            
            self.assertIn("spectrum", meta, f"Target {t.name} is missing precomputed 'spectrum'")
            spec = meta["spectrum"]
            self.assertGreater(len(spec), 0, f"Target {t.name} spectrum must not be empty")
            
            detectors_seen = set()
            for entry in spec:
                self.assertIn("det", entry)
                self.assertIn("lam", entry)
                self.assertIn("flux", entry)
                self.assertIn("err", entry)
                detectors_seen.add(entry["det"])
            
            self.assertEqual(
                detectors_seen,
                {1, 2, 3, 4, 5, 6},
                f"Target {t.name} must cover all 6 detectors (1-6)"
            )

        # Specific check for 3I/ATLAS comet spectrum
        atlas_meta = json.loads((showcase_dir / "3i-atlas" / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(atlas_meta["spectrum"][0]["det"], 3)
        self.assertGreater(atlas_meta["spectrum"][0]["flux"], 0)

    def test_web_ui_elements(self):
        index_html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        
        # Band selector with detector pills
        self.assertIn('id="band-bar"', index_html)
        self.assertIn('data-band="0"', index_html)
        self.assertIn('data-band="1"', index_html)
        self.assertIn('data-band="6"', index_html)
        
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
        
        # Band physics
        self.assertIn("const BANDS =", showcase_js)
        self.assertIn("wise-j184125", showcase_js, "SED physics response for brown dwarf")
        
        # Real steps vs blend
        self.assertIn('blendMode === "steps"', showcase_js)
        self.assertIn("(not observed)", showcase_js, "Blended frames must be labelled 'not observed'")
        self.assertIn("[Real observation]", showcase_js)
        
        # Citizen science wording
        self.assertIn("A report ready to share", showcase_js, "Findings must be worded as 'A report ready to share'")
        self.assertIn("exportFindingsCSV", showcase_js)
        self.assertIn("exportFindingsJSON", showcase_js)
        
        # Tour guard
        self.assertIn("T.i = listIdx", showcase_js, "Tour pill must stay synced to target")

    def test_how_page_documentation(self):
        how_html = (ROOT / "web" / "how.html").read_text(encoding="utf-8")
        self.assertIn("6 infrared detectors", how_html)
        self.assertIn("Citizen science: Flag findings", how_html)
        self.assertIn("Real steps vs Blend", how_html)
        self.assertIn("not observed", how_html)
        self.assertIn("report ready to share", how_html)

if __name__ == "__main__":
    unittest.main()
