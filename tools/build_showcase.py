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
import math
import sys
import warnings
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
warnings.filterwarnings("ignore")

import detect  # noqa: E402
import motion  # noqa: E402
import narrate  # noqa: E402
import track  # noqa: E402

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

    apply_motion(t, {"size": t.get("size", 0.25), "npix": stacks["npix"], "sweeps": sweeps, "changes": result["changes"]})
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


def build_track(t: dict) -> dict:
    """A comet or asteroid: real exposures centred on its predicted position."""
    slug = t["slug"]
    print(f"== {t['name']} (following)", flush=True)
    res = track.follow(t["horizons"], size=t.get("size", 0.12), npix=t.get("npix", 160),
                       start=t.get("start", track.MISSION_START), stop=t.get("stop"),
                       log=lambda *a: print("  ", *a, flush=True))
    frames = res["frames"]
    if len(frames) < 3:
        raise RuntimeError(f"only {len(frames)} usable images")
    d = OUT / slug
    d.mkdir(parents=True, exist_ok=True)
    for f in d.glob("*"):
        f.unlink()
    out = []
    for i, f in enumerate(frames):
        (d / f"f{i}.bin").write_bytes(f["image"].astype("<f2").tobytes())
        out.append({"mjd": round(f["mjd"], 6), "lam": round(f["lam"], 3), "frame": f"f{i}.bin",
                    "id": f["id"], "flux": None if f["flux"] is None else round(f["flux"], 4),
                    "err": None if f["err"] is None else round(f["err"], 4)})
    # Shift-and-stack: every image is centred on the object, so a median
    # keeps the object and smears the stars (each lands somewhere else).
    stack = np.nanmedian(np.stack([f["image"] for f in frames]), axis=0).astype(np.float32)
    s_sig = detect._robust_sigma(stack)
    stack = stack / s_sig if s_sig and s_sig > 0 else stack
    c = stack.shape[0] // 2
    stack_snr = float(np.nanmax(stack[c - 4:c + 5, c - 4:c + 5]))
    (d / "stack.bin").write_bytes(stack.astype("<f2").tobytes())

    # facts for the text
    mjds = [f["mjd"] for f in frames]
    visits = 1 + sum(1 for a, b in zip(mjds, mjds[1:]) if b - a > 3)
    near = [r for r in res["daily"] if mjds[0] - 1 <= r["mjd"] <= mjds[-1] + 1] or res["daily"]
    deltas = [r["delta"] for r in near if r["delta"]]
    rates = [math.hypot(r["rate_ra"] or 0, r["rate_dec"] or 0) for r in near if r["rate_ra"] is not None]
    delta = round(float(np.median(deltas)), 2) if deltas else None
    facts = {
        "n_images": len(frames), "visits": visits,
        "first_date": dt.datetime(1858, 11, 17) .__add__(dt.timedelta(days=mjds[0])).strftime("%d %b %Y"),
        "last_date": dt.datetime(1858, 11, 17).__add__(dt.timedelta(days=mjds[-1])).strftime("%d %b %Y"),
        "distance_au": delta,
        "distance_million_km": round(delta * 149.6) if delta else None,
        "sky_speed_arcsec_per_hour": round(float(np.median(rates)), 1) if rates else None,
        "stacked_images_peak_vs_noise": round(stack_snr),
        "visible_when_stacked": stack_snr > 10,
    }
    text = narrate.describe_track(t, facts)
    meta = {
        "type": "track", "slug": slug, "name": t["name"], "note": t.get("note", ""),
        "size": res["size"], "npix": res["npix"], "frames": out, "stack": "stack.bin",
        "facts": facts, "text": text,
        "horizons": t["horizons"],
        "built": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    (d / "meta.json").write_text(json.dumps(meta, indent=1, default=float))
    write_track_thumbs(d, meta, frames, stack)
    print(f"   {len(frames)} images; text by {text['writer']}", flush=True)
    return meta


def write_track_thumbs(d: Path, meta: dict, frames: list[dict], stack: np.ndarray) -> None:
    """Card pictures: one single image, then the stack, so the card itself
    shows the object appearing out of the crowd."""
    picks = [frames[len(frames) // 2]["image"], stack]
    for j, img in enumerate(picks):
        a = np.arcsinh(np.clip(np.nan_to_num(img, nan=50), -2, None) / 3) / np.arcsinh(40)
        Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).resize((320, 320), Image.LANCZOS) \
            .crop((0, 60, 320, 260)).save(d / f"t{j}.png", optimize=True)
    meta["thumbs"] = [f"t{j}.png" for j in range(len(picks))]
    (d / "meta.json").write_text(json.dumps(meta, indent=1, default=float))


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


def apply_motion(t: dict, meta: dict) -> None:
    """Fit every moving star's rate and direction through all sweeps and,
    when the target has a catalogue proper motion, compare with it."""
    arcsec_px = meta["size"] * 3600 / meta["npix"]
    mjds = [s["mjd"] for s in meta["sweeps"]]
    for c in meta["changes"]:
        if c["kind"] != "moved" or len(c.get("track", [])) != len(mjds):
            continue
        c.update(motion.fit(c["track"], mjds, arcsec_px, c["shift_arcsec"], c["significance"]))
        if "pm_ra_mas" in t and (c.get("offset_arcmin") or 99) < 0.5:
            c["catalogue"] = motion.compare(c, t["pm_ra_mas"], t["pm_dec_mas"], t["pm_source"])


def refresh(t: dict) -> None:
    """Redo the text and pictures of a finished target without re-measuring."""
    d = OUT / t["slug"]
    mp = d / "meta.json"
    if not mp.exists():
        return
    meta = json.loads(mp.read_text())
    if meta.get("type") == "track":
        meta["text"] = narrate.describe_track(t, meta["facts"])
        meta["name"], meta["note"] = t["name"], t.get("note", "")
        mp.write_text(json.dumps(meta, indent=1, default=float))
        print(f"refreshed {t['slug']}: text by {meta['text']['writer']}", flush=True)
        return
    apply_motion(t, meta)
    sweeps = [{"label": s["label"], "n": s["n"]} for s in meta["sweeps"]]
    meta["text"] = narrate.describe(t, sweeps, {"changes": meta["changes"], "n_sources": meta["n_sources"]})
    meta["name"], meta["note"] = t["name"], t.get("note", "")
    mp.write_text(json.dumps(meta, indent=1, default=float))
    write_thumbs(d, meta)
    print(f"refreshed {t['slug']}: text by {meta['text']['writer']}", flush=True)


def index_entry(t: dict, m: dict) -> dict:
    if m.get("type") == "track":
        f = m["frames"]
        return {
            "slug": t["slug"], "name": t["name"], "note": t.get("note", ""), "group": t.get("group", ""),
            "type": "track", "kinds": {"tracked": len(f)}, "candidates": 0,
            "summary": m["text"]["summary"], "writer": m["text"]["writer"],
            "thumbs": [f"{t['slug']}/{x}" for x in m.get("thumbs", [])],
            "labels": [m["facts"]["first_date"], m["facts"]["last_date"]],
        }
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
            build_track(t) if t.get("type") == "track" else build(t)
        except Exception as e:  # keep going; report at the end
            print(f"   FAILED: {e}", flush=True)
            continue
        write_index()           # after every target, so the site is usable early
    print(f"index: {write_index()} targets")


if __name__ == "__main__":
    main(sys.argv[1:])
