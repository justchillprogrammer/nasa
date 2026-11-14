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
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import imaging
import spherex as sx

WEB = Path(__file__).resolve().parent.parent / "web"
MAX_NPIX = 512
MAX_SIZE_DEG = 1.5

app = FastAPI(title="SPHEREx Blink")
# Small on purpose: the free hosting tiers have little CPU and memory.
_pool = ThreadPoolExecutor(max_workers=int(os.environ.get("SPECTRUM_WORKERS", "4")))
_cutout_slots = threading.BoundedSemaphore(int(os.environ.get("CUTOUT_SLOTS", "3")))


def _check(ra: float, dec: float) -> None:
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise HTTPException(400, "ra must be 0-360 and dec -90 to 90 degrees")


@app.get("/api/search")
def api_search(ra: float, dec: float):
    """Every SPHEREx exposure covering a position, with the wavelength each
    one samples there, grouped into the mission's six-monthly sky passes."""
    _check(ra, dec)
    try:
        res = sx.search(ra, dec)
    except Exception as e:
        raise HTTPException(502, f"archive search failed: {e}")
    slim = [{k: v for k, v in e.items() if k != "key"} for e in res["exposures"]]
    return {"ra": ra, "dec": dec, "epochs": res["epochs"], "exposures": slim}


@app.get("/api/cutout")
def api_cutout(
    ra: float, dec: float, id: str,
    size: float = Query(0.25, gt=0, le=MAX_SIZE_DEG),
    npix: int = Query(300, ge=32, le=MAX_NPIX),
):
    """One exposure resampled onto the shared north-up grid.

    The body is raw little-endian float32 (npix * npix values, MJy/sr, NaN
    where there is no data) so the browser can stretch, blink and subtract
    frames itself. Measured details travel in the X-Frame-Meta header.
    """
    _check(ra, dec)
    try:
        exp = sx.find_exposure(ra, dec, id)
    except KeyError:
        raise HTTPException(404, "unknown exposure for this position")
    try:
        with _cutout_slots:
            img, meta = imaging.cutout(exp["key"], ra, dec, size, npix)
    except Exception as e:
        raise HTTPException(502, f"could not read the image: {e}")
    return Response(
        content=img.astype("<f4").tobytes(),
        media_type="application/octet-stream",
        headers={"X-Frame-Meta": json.dumps(meta), "Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/spectrum")
def api_spectrum(ra: float, dec: float):
    """Brightness at the position in every exposure, streamed as it is measured.

    One JSON object per line: first {"total": n}, then one point per exposure,
    then {"done": true}. Because each exposure sees the position through a
    different part of the colour filter, the points together form a spectrum.
    """
    _check(ra, dec)
    try:
        res = sx.search(ra, dec)
    except Exception as e:
        raise HTTPException(502, f"archive search failed: {e}")
    exposures = res["exposures"]
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


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
