"""Web server for the SPHEREx sky-change viewer.

Run with:  uvicorn app:app --app-dir backend --port 8000
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

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
# Change detection stacks every sweep (tens of exposures each): heavy on memory
# and on the archive, so only a few may run at once.
_changes_slots = threading.BoundedSemaphore(int(os.environ.get("CHANGES_SLOTS", "2")))
SPECTRUM_POINT_TIMEOUT = 120   # seconds to wait for any one exposure


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
        raise HTTPException(502, f"NASA's image archive (IRSA) did not answer after several tries ({e})")
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
    # The page may ask for a sample of the exposures first, so the cache key
    # says exactly which exposures were measured.
    ids = hashlib.sha1("|".join(sorted(e["id"] for e in exposures)).encode()).hexdigest()[:12]
    cache = sx._cache_path("spectrum", f"v3:{ra:.4f}:{dec:.4f}:{ids}", ".json")

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
                try:
                    p = out.get(timeout=SPECTRUM_POINT_TIMEOUT)
                except queue.Empty:
                    # The archive stalled: end the stream cleanly (and cache
                    # nothing) instead of cutting the connection mid-line.
                    yield json.dumps({"error": "the archive stopped answering; try again later",
                                      "done": True, "partial": True}) + "\n"
                    return
                if not p.get("skip"):
                    points.append(p)
                yield json.dumps(p) + "\n"
            sx.write_cache(cache, json.dumps(points))
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
    cache = sx._cache_path("changes", f"v2:{ra:.4f}:{dec:.4f}:{size:.3f}", ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    if not _changes_slots.acquire(blocking=False):
        raise HTTPException(503, "Sky Blink is busy finding changes for other visitors. Try again in a minute.",
                            headers={"Retry-After": "30"})
    try:
        out = _find_changes(ra, dec, size)
    finally:
        _changes_slots.release()
    sx.write_cache(cache, json.dumps(out, default=float))
    return out


def _find_changes(ra: float, dec: float, size: float) -> dict:
    try:
        stacks = detect.stack_sweeps(ra, dec, size, 300, log=lambda *a: None)
    except Exception as e:
        raise HTTPException(502, f"The images for this spot could not be read ({e}). Try again in a minute.")
    usable, rep = stacks["sweeps"], stacks["report"]
    # Never report "no change" from images that did not load.
    if len(usable) < 2:
        why = "; ".join(f"{s['label']}: {s['reason']}" for s in rep["skipped"]) or "no repeat visits found"
        raise HTTPException(422, f"Sky Blink could not compare this spot: it needs two complete sweeps "
                                 f"and could build {len(usable)} ({why}). Nothing was measured, so no result is shown.")
    if rep["images_tried"] and rep["images_failed"] / rep["images_tried"] > 0.3:
        raise HTTPException(502, f"{rep['images_failed']} of {rep['images_tried']} images could not be read, "
                                 "too many for a trustworthy comparison. Try again in a minute.")
    try:
        result = detect.find_changes(stacks)
    except Exception as e:
        raise HTTPException(502, f"Change detection failed ({e}).")
    if not result.get("n_sources"):
        raise HTTPException(422, "No stars could be measured in these images, so Sky Blink cannot say whether anything changed.")
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
        "checked": {"images_used": sum(s["n"] for s in sweeps), "images_failed": rep["images_failed"],
                    "sweeps_skipped": rep["skipped"]},
    }
    return out


@app.middleware("http")
async def cache_static(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/showcase/") and response.status_code == 200:
        # Pre-computed results change only when the site is rebuilt.
        response.headers.setdefault("Cache-Control", "public, max-age=3600")
    elif path.endswith((".js", ".css", ".html")) or path in ("/", "/explore.html"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.exception_handler(404)
@app.exception_handler(StarletteHTTPException)
async def custom_http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        accept = request.headers.get("accept", "")
        if "text/html" in accept or "*/*" in accept:
            p404 = WEB / "404.html"
            if p404.exists():
                return FileResponse(p404, status_code=404)
        return Response(content=json.dumps({"detail": exc.detail}), status_code=404, media_type="application/json")
    return Response(content=json.dumps({"detail": exc.detail}), status_code=exc.status_code,
                    media_type="application/json", headers=getattr(exc, "headers", None))


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
