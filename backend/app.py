"""Web server for the SPHEREx sky-change viewer.

Run with:  uvicorn app:app --app-dir backend --port 8000
"""

from __future__ import annotations

import json
import os
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import detect
import imaging
import narrate
import spherex as sx

WEB = Path(__file__).resolve().parent.parent / "web"
MAX_NPIX = 512
MAX_SIZE_DEG = 1.5

app = FastAPI(title="SPHEREx Blink")
# Tuned for fast I/O bound S3 range fetches while keeping memory low.
_pool = ThreadPoolExecutor(max_workers=int(os.environ.get("SPECTRUM_WORKERS", "12")))
_cutout_slots = threading.BoundedSemaphore(int(os.environ.get("CUTOUT_SLOTS", "6")))


def _check(ra: float, dec: float) -> None:
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise HTTPException(400, "ra must be 0-360 and dec -90 to 90 degrees")


@app.get("/api/search")
def api_search(ra: float, dec: float, response: Response):
    """Every SPHEREx exposure covering a position, with the wavelength each
    one samples there, grouped into the mission's six-monthly sky passes."""
    _check(ra, dec)
    try:
        res = sx.search(ra, dec)
    except Exception as e:
        raise HTTPException(502, f"archive search failed: {e}")
    response.headers["Cache-Control"] = "public, max-age=3600, s-maxage=86400"
    return {"ra": ra, "dec": dec, "epochs": res["epochs"], "exposures": res["exposures"]}


@app.get("/api/resolve")
def api_resolve(name: str, response: Response):
    """Resolve an astronomical object name (SIMBAD/NED/VizieR) to sky coordinates."""
    try:
        res = sx.resolve_name(name)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"name lookup failed: {e}")
    response.headers["Cache-Control"] = "public, max-age=86400, s-maxage=86400"
    return res


@app.get("/api/cutout")
def api_cutout(
    ra: float, dec: float, id: str = "",
    key: str | None = None,
    size: float = Query(0.25, gt=0, le=MAX_SIZE_DEG),
    npix: int = Query(300, ge=32, le=MAX_NPIX),
):
    """One exposure resampled onto the shared north-up grid.

    The body is raw little-endian float32 (npix * npix values, MJy/sr, NaN
    where there is no data) so the browser can stretch, blink and subtract
    frames itself. Measured details travel in the X-Frame-Meta header.
    """
    _check(ra, dec)
    if key and sx.valid_key(key):
        exp_key = key
    else:
        try:
            exp_key = sx.find_exposure(ra, dec, id)["key"]
        except KeyError:
            raise HTTPException(404, "unknown exposure for this position")
    try:
        with _cutout_slots:
            img, meta = imaging.cutout(exp_key, ra, dec, size, npix)
    except Exception as e:
        raise HTTPException(502, f"could not read the image: {e}")
    return Response(
        content=img.astype("<f4").tobytes(),
        media_type="application/octet-stream",
        headers={
            "X-Frame-Meta": json.dumps(meta),
            "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
        },
    )


@app.api_route("/api/spectrum", methods=["GET", "POST"])
def api_spectrum(ra: float, dec: float, payload: dict | None = Body(default=None)):
    """Brightness at the position in every exposure, streamed as it is measured.

    One JSON object per line: first {"total": n}, then one point per exposure,
    then {"done": true}. Because each exposure sees the position through a
    different part of the colour filter, the points together form a spectrum.
    """
    _check(ra, dec)
    if payload and isinstance(payload.get("exposures"), list):
        exposures = [
            e for e in payload["exposures"]
            if isinstance(e, dict) and sx.valid_key(str(e.get("key", "")))
        ]
    else:
        try:
            exposures = sx.search(ra, dec)["exposures"]
        except Exception as e:
            raise HTTPException(502, f"archive search failed: {e}")
    cache = sx._cache_path("spectrum", f"v2:{ra:.4f}:{dec:.4f}", ".json")

    def stream():
        if cache.exists():
            points = json.loads(cache.read_text())
            yield json.dumps({"total": len(exposures)}) + "\n"
            for p in points:
                yield json.dumps(p) + "\n"
            yield json.dumps({"done": True}) + "\n"
            return

        yield json.dumps({"total": len(exposures)}) + "\n"
        out: queue.Queue = queue.Queue()
        stop = threading.Event()

        def work(e):
            if stop.is_set():
                return
            try:
                p = imaging.photometry(e["key"], ra, dec)
            except Exception:
                p = None
            out.put({"id": e["id"], "epoch": e["epoch"], **p} if p else {"id": e["id"], "skip": True})

        for e in exposures:
            _pool.submit(work, e)
        points = []
        try:
            for _ in exposures:
                p = out.get(timeout=120)
                if not p.get("skip"):
                    points.append(p)
                yield json.dumps(p) + "\n"
            cache.write_text(json.dumps(points))
            yield json.dumps({"done": True}) + "\n"
        finally:
            stop.set()   # client went away: let queued work drain quickly

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/api/changes")
def api_changes(ra: float, dec: float, size: float = Query(0.25, ge=0.05, le=0.5)):
    """Quick change detection for any position.

    Stacks each sweep, finds sources, and reports what moved or changed
    brightness. Skips the slower single-exposure confirmation used for the
    showcase, so every brightness change here is a candidate.
    """
    _check(ra, dec)
    cache = sx._cache_path("changes", f"v1:{ra:.4f}:{dec:.4f}:{size:.3f}", ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    try:
        stacks = detect.stack_sweeps(ra, dec, size, 300, log=lambda *a: None)
        result = detect.find_changes(stacks)
    except Exception as e:
        raise HTTPException(502, f"change detection failed: {e}")
    for c in result["changes"]:
        if c["kind"] != "moved" and c.get("verified") is None:
            c["verified"] = False
        if c.get("season_pattern"):
            c["check"] = "seen only when the telescope faced the other way; could be a reflection inside the instrument"
    result["changes"].sort(key=lambda c: (c["kind"] != "moved", -c["significance"]))
    for n, c in enumerate(result["changes"], 1):
        c["rank"] = n
    sweeps = stacks["sweeps"]
    target = {"name": f"the position {ra:.4f} {dec:+.4f}"}
    text = narrate.describe(target, sweeps, result)
    out = {
        "ra": ra, "dec": dec, "size": size, "npix": stacks["npix"],
        "sweeps": [{"label": s["label"], "n": s["n"], "mjd": s["mjd"]} for s in sweeps],
        "changes": result["changes"], "n_sources": result.get("n_sources"), "text": text,
    }
    cache.write_text(json.dumps(out, default=float))
    return out


@app.middleware("http")
async def cache_static(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/showcase/") and response.status_code == 200:
        # Pre-computed results change only when the site is rebuilt.
        response.headers.setdefault("Cache-Control", "public, max-age=3600")
    return response


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
