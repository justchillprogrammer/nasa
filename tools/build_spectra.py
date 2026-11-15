"""Measure the brightness spectrum of every showcase target from real exposures.

For a fixed target, every SPHEREx exposure covering it (all six detectors,
0.75 to 5 µm) is measured at the target position with the same quick-look
photometry the Explorer uses (backend/imaging.py). Exposures where the
measuring circle holds a saturated or flagged pixel are left out, never
filled in. For a tracked object (a comet) the per-image measurements made
while following it are used as they are.

Writes the points into web/showcase/<slug>/meta.json as "spectrum", with
"spectrum_source" describing how they were made.

    python tools/build_spectra.py            # every target
    python tools/build_spectra.py barnard    # one target
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import imaging  # noqa: E402
import spherex as sx  # noqa: E402

SHOW = ROOT / "web" / "showcase"


def measure_fixed(ra: float, dec: float) -> tuple[list[dict], int]:
    exposures = sx.search(ra, dec)["exposures"]

    def one(e):
        try:
            p = imaging.photometry(e["key"], ra, dec)
        except Exception:
            return None
        if not p:
            return None
        return {"lam": p["lam"], "flux": p["flux"], "err": p["err"], "det": p["det"],
                "epoch": e["epoch"], "mjd": p["mjd"]}

    with ThreadPoolExecutor(16) as pool:
        pts = [p for p in pool.map(one, exposures) if p]
    pts.sort(key=lambda p: p["lam"])
    return pts, len(exposures)


def build(slug: str) -> None:
    meta_path = SHOW / slug / "meta.json"
    meta = json.loads(meta_path.read_text())
    if meta.get("type") == "track":
        pts = sorted(({"lam": f["lam"], "flux": f["flux"], "err": f["err"], "epoch": 0,
                       "det": int(f["id"].rsplit("D", 1)[-1]), "mjd": f["mjd"]}
                      for f in meta["frames"] if f.get("flux") is not None), key=lambda p: p["lam"])
        total = len(meta["frames"])
        how = "measured on the object in each image while following it"
    else:
        pts, total = measure_fixed(meta["ra"], meta["dec"])
        how = "measured at the target position in every exposure"
    meta["spectrum"] = pts
    meta["spectrum_source"] = {
        "method": f"Quick-look aperture photometry, {how}. Not calibrated science values.",
        "measured": len(pts), "exposures": total,
        "skipped": total - len(pts),
        "skipped_reason": "saturated or flagged pixels inside the measuring circle, or off the detector",
    }
    meta_path.write_text(json.dumps(meta, indent=1))
    print(f"{slug}: {len(pts)} of {total} exposures measured")


if __name__ == "__main__":
    idx = json.loads((SHOW / "index.json").read_text())["targets"]
    wanted = sys.argv[1:] or [t["slug"] for t in idx]
    for s in wanted:
        build(s)
