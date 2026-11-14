"""Pre-compute the showcase targets into small static files.

For every target this runs the change detector, writes one stacked image per
sweep (float16, so the browser can still blink and subtract real values),
small preview pictures, and a JSON file with the detected changes and their
plain-language description.

Run from the repository root:
    python tools/build_showcase.py            # every target
    python tools/build_showcase.py barnard    # just one

Output goes to web/showcase/. The site reads web/showcase/index.json.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import warnings
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
warnings.filterwarnings("ignore")

import detect  # noqa: E402
import narrate  # noqa: E402

OUT = ROOT / "web" / "showcase"
TARGETS = json.loads((ROOT / "tools" / "targets.json").read_text())


def stretch(img: np.ndarray, lo: float, hi: float) -> np.ndarray:
    a = np.clip((img - lo) / (hi - lo), 0, None)
    a = np.arcsinh(8 * a) / np.arcsinh(8)
    return (np.clip(np.nan_to_num(a), 0, 1) * 255).astype(np.uint8)


def build(t: dict) -> dict:
    slug = t["slug"]
    print(f"== {t['name']}", flush=True)
    stacks, result = detect.analyze_field(t["ra"], t["dec"], t.get("size", 0.25), t.get("npix", 300),
                                          log=lambda *a: print("  ", *a, flush=True))
    sweeps = stacks["sweeps"]
    d = OUT / slug
    d.mkdir(parents=True, exist_ok=True)
    for f in d.glob("*"):
        f.unlink()

    ref = sweeps[0]["image"]
    lo = float(np.nanpercentile(ref, 25))
    hi = float(np.nanpercentile(ref, 99.7))
    out_sweeps = []
    for s in sweeps:
        img = s["image"].astype("<f2")
        (d / f"s{s['index']}.bin").write_bytes(img.tobytes())
        out_sweeps.append({
            "index": s["index"], "label": s["label"], "mjd": round(s["mjd"], 4),
            "mjd0": round(s["mjd0"], 4), "mjd1": round(s["mjd1"], 4), "n": s["n"],
            "frame": f"s{s['index']}.bin", "thumb": f"s{s['index']}.png",
            "lams": [round(e["lam"], 3) for e in s["exposures"]],
        })

    text = narrate.describe(t, sweeps, result)
    meta = {
        "slug": slug, "name": t["name"], "note": t.get("note", ""),
        "ra": t["ra"], "dec": t["dec"], "size": stacks["size"], "npix": stacks["npix"],
        "lam_lo": stacks["lam_lo"], "lam_hi": stacks["lam_hi"],
        "sweeps": out_sweeps, "changes": result["changes"],
        "n_sources": result.get("n_sources"), "text": text,
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=1, default=float))
    write_thumbs(d, meta)
    print(f"   {len(result['changes'])} changes; text by {text['writer']}", flush=True)
    return meta


def write_thumbs(d: Path, meta: dict) -> None:
    """Preview pictures for the feed cards, cropped around the main change so
    a small motion is visible at card size."""
    n = meta["npix"]
    frames = [np.frombuffer((d / s["frame"]).read_bytes(), dtype="<f2").astype(np.float32).reshape(n, n)
              for s in meta["sweeps"]]
    if meta["changes"]:
        c = meta["changes"][0]
        tr = c.get("track") or [{"x": c["x"], "y": c["y"]}]
        cx = sum(p["x"] for p in tr) / len(tr)
        cy = sum(p["y"] for p in tr) / len(tr)
        half = 50
    else:
        cx = cy = (n - 1) / 2
        half = n // 2
    x0 = int(round(min(max(cx - half, 0), n - 2 * half)))
    y0 = int(round(min(max(cy - half, 0), n - 2 * half)))
    lo = float(np.nanpercentile(frames[0], 25))
    hi = float(np.nanpercentile(frames[0], 99.7))
    # Saturated star cores have no data; draw them white, as a camera would.
    frames = [np.where(np.isnan(f), hi * 10, f) for f in frames]
    crops = [f[y0:y0 + 2 * half, x0:x0 + 2 * half] for f in frames]
    for s, cimg in zip(meta["sweeps"], crops):
        Image.fromarray(stretch(cimg, lo, hi)).resize((320, 320), Image.LANCZOS) \
            .crop((0, 60, 320, 260)).save(d / s["thumb"], optimize=True)


def refresh(t: dict) -> None:
    """Redo the text and pictures of a finished target without re-measuring."""
    d = OUT / t["slug"]
    mp = d / "meta.json"
    if not mp.exists():
        return
    meta = json.loads(mp.read_text())
    sweeps = [{"label": s["label"], "n": s["n"]} for s in meta["sweeps"]]
    meta["text"] = narrate.describe(t, sweeps, {"changes": meta["changes"], "n_sources": meta["n_sources"]})
    meta["name"], meta["note"] = t["name"], t.get("note", "")
    mp.write_text(json.dumps(meta, indent=1, default=float))
    write_thumbs(d, meta)
    print(f"refreshed {t['slug']}: text by {meta['text']['writer']}", flush=True)


def index_entry(t: dict, m: dict) -> dict:
    kinds: dict[str, int] = {}
    candidates = 0
    for c in m["changes"]:
        if c["kind"] == "moved" or c.get("verified"):
            kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
        else:
            candidates += 1
    return {
        "slug": t["slug"], "name": t["name"], "note": t.get("note", ""), "group": t.get("group", ""),
        "ra": t["ra"], "dec": t["dec"], "kinds": kinds, "candidates": candidates,
        "summary": m["text"]["summary"],
        "writer": m["text"]["writer"], "thumbs": [f"{t['slug']}/{s['thumb']}" for s in m["sweeps"]],
        "labels": [s["label"] for s in m["sweeps"]],
    }


def write_index() -> int:
    """Rebuild index.json from every finished target on disk."""
    entries = []
    for t in TARGETS:
        mp = OUT / t["slug"] / "meta.json"
        if mp.exists():
            entries.append(index_entry(t, json.loads(mp.read_text())))
    (OUT / "index.json").write_text(json.dumps({"targets": entries}, indent=1))
    return len(entries)


def main(only: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if only == ["--index-only"]:
        print(f"index: {write_index()} targets")
        return
    if only and only[0] == "--refresh":
        for t in TARGETS:
            if len(only) == 1 or t["slug"] in only[1:]:
                refresh(t)
        print(f"index: {write_index()} targets")
        return
    for t in TARGETS:
        if only and t["slug"] not in only:
            continue
        try:
            build(t)
        except Exception as e:  # keep going; report at the end
            print(f"   FAILED: {e}", flush=True)
            continue
        write_index()           # after every target, so the site is usable early
    print(f"index: {write_index()} targets")


if __name__ == "__main__":
    main(sys.argv[1:])
