"""Pre-search the explorer's presets and named objects.

The first archive search for a new position takes up to a minute. This runs
that search once for every preset and named object, and ships the results in
backend/data/search/ (gzipped), where spherex.search() looks first.

Run from the repository root:
    python tools/build_spots.py            # all spots, skipping ones already done
    python tools/build_spots.py --force    # redo all
"""

from __future__ import annotations

import gzip
import json
import re
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import spherex as sx  # noqa: E402


def spots() -> list[dict]:
    """Every preset in web/app.js and every object in web/names.json."""
    out = []
    src = (ROOT / "web" / "app.js").read_text()
    # The explorer shows the first few presets of each category; do those first.
    for block in src.split('category: "')[1:]:
        for rank, m in enumerate(re.finditer(r'\{ name: "([^"]+)"[^}]*?ra: ([-\d.]+), dec: ([-\d.]+)', block)):
            out.append({"name": m.group(1), "ra": float(m.group(2)), "dec": float(m.group(3)), "rank": rank})
    out.sort(key=lambda s: s["rank"])
    names = json.loads((ROOT / "web" / "names.json").read_text())
    for o in names.get("objects", []):
        out.append({"name": o["name"], "ra": float(o["ra"]), "dec": float(o["dec"])})
    seen, uniq = set(), []
    for s in out:
        k = (round(s["ra"], 4), round(s["dec"], 4))
        if k not in seen:
            seen.add(k)
            uniq.append(s)
    return uniq


def main(force: bool) -> None:
    todo = spots()
    out_dir = sx.BUNDLED / "search"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"{len(todo)} spots", flush=True)

    def run(s):
        dst = sx.bundled_path("search", sx.search_key(s["ra"], s["dec"]))
        if dst.exists() and not force:
            return s["name"], "already done", 0
        t = time.time()
        try:
            res = sx.search(s["ra"], s["dec"])
        except Exception as e:
            return s["name"], f"FAILED {e}", round(time.time() - t)
        with gzip.open(dst, "wt") as f:
            json.dump(res, f, separators=(",", ":"))
        return s["name"], f"{len(res['exposures'])} exposures", round(time.time() - t)

    with ThreadPoolExecutor(3) as pool:
        for name, what, sec in pool.map(run, todo):
            print(f"  {name}: {what} ({sec}s)", flush=True)
    total = sum(p.stat().st_size for p in out_dir.glob("*.json.gz"))
    print(f"done: {len(list(out_dir.glob('*.json.gz')))} files, {total / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main("--force" in sys.argv)
