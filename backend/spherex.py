"""Access to SPHEREx Level-2 spectral images in the NASA/IPAC IRSA archive.

Three things live here:

* ``search``      - which exposures cover a sky position (IRSA TAP service)
* ``load_header`` - the image header (sky and detector geometry) of one exposure
* ``read_rows``   - a strip of pixel rows of one exposure

Pixels are read with HTTP range requests against the public cloud copy of the
archive, so a small patch of sky costs kilobytes instead of the 65 MB file.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import struct
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
# Public mirrors of the same files. The cloud bucket answers range requests
# fastest; the archive itself is the fallback.
DATA_BASES = [
    "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/",
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/",
]
URI_PREFIX = "ibe/data/spherex/"

DETECTOR_SIZE = 2040          # active pixels per side
BLOCK = 2880                  # FITS block size in bytes
HEADER_GUESS = 12 * BLOCK     # enough for the primary and image headers
EPOCH_GAP_DAYS = 45           # a longer pause than this starts a new sky pass

CACHE = Path(os.environ.get("SPHEREX_CACHE", Path(__file__).resolve().parent.parent / ".cache"))

_local = threading.local()
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _session() -> requests.Session:
    if not hasattr(_local, "s"):
        s = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=2)
        s.mount("https://", adapter)
        _local.s = s
    return _local.s


def _lock(name: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(name, threading.Lock())


def _cache_path(kind: str, key: str, ext: str) -> Path:
    d = CACHE / kind
    d.mkdir(parents=True, exist_ok=True)
    return d / (hashlib.sha1(key.encode()).hexdigest()[:20] + ext)


def _get_range(key: str, start: int, end: int | None, suffix: int | None = None) -> bytes:
    """Fetch bytes [start, end] of an archive file (or the last ``suffix`` bytes)."""
    rng = f"bytes=-{suffix}" if suffix else f"bytes={start}-{end}"
    last: Exception | None = None
    for attempt in range(3):
        for base in DATA_BASES:
            try:
                r = _session().get(base + key, headers={"Range": rng}, timeout=60)
                if r.status_code in (200, 206):
                    return r.content
                last = RuntimeError(f"HTTP {r.status_code} for {key}")
            except requests.RequestException as e:  # try the other mirror
                last = e
        time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"could not read {key}: {last}")


# ---------------------------------------------------------------- search

def _parse_ewkb_polygon(hexstr: str) -> list[tuple[float, float]]:
    """Corner (ra, dec) pairs of a footprint stored as PostGIS EWKB hex."""
    b = bytes.fromhex(hexstr)
    fmt = "<" if b[0] == 1 else ">"
    (gtype,) = struct.unpack_from(fmt + "I", b, 1)
    off = 5 + (4 if gtype & 0x20000000 else 0)
    _nrings, npts = struct.unpack_from(fmt + "II", b, off)
    off += 8
    pts = [struct.unpack_from(fmt + "dd", b, off + 16 * i) for i in range(npts)]
    return [(float(x) % 360.0, float(y)) for x, y in pts[:4]]


def _tangent(ra, dec, ra0, dec0):
    """Gnomonic projection of (ra, dec) about (ra0, dec0); all in degrees."""
    ra, dec, ra0, dec0 = map(np.radians, (ra, dec, ra0, dec0))
    cosc = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    xi = np.cos(dec) * np.sin(ra - ra0) / cosc
    eta = (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / cosc
    return np.degrees(xi), np.degrees(eta)


def _pixel_from_corners(corners, ra, dec) -> tuple[float, float]:
    """Approximate detector pixel of a sky position from the footprint corners.

    The archive lists the corners in pixel order (0,0), (N,0), (N,N), (0,N),
    so an affine fit through them places any position to within a few pixels.
    That is enough to tell which wavelength an exposure samples there without
    opening the file.
    """
    n = DETECTOR_SIZE - 1
    pix = np.array([[0, 0], [n, 0], [n, n], [0, n]], float)
    cra = np.array([c[0] for c in corners])
    cdec = np.array([c[1] for c in corners])
    xi, eta = _tangent(cra, cdec, ra, dec)
    A = np.column_stack([xi, eta, np.ones(4)])
    coef, *_ = np.linalg.lstsq(A, pix, rcond=None)
    x, y = coef[2]  # the target sits at the tangent point (0, 0)
    return float(x), float(y)


def search(ra: float, dec: float) -> dict:
    """All exposures whose footprint contains (ra, dec), grouped into sky passes."""
    key = f"v3:{ra:.4f}:{dec:.4f}"
    path = _cache_path("search", key, ".json")
    with _lock(str(path)):
        if path.exists():
            return json.loads(path.read_text())

        adql = (
            "SELECT p.obs_publisher_did,p.time_bounds_lower,p.time_exposure,"
            "p.energy_bandpassname,p.poly,a.uri "
            "FROM spherex.plane p JOIN spherex.artifact a ON a.planeid=p.planeid "
            "WHERE a.producttype='science' AND "
            f"CONTAINS(POINT('ICRS',{ra:.6f},{dec:.6f}),p.poly)=1 "
            "ORDER BY p.time_bounds_lower"
        )
        r = _session().get(TAP_URL, params={"QUERY": adql, "FORMAT": "csv"}, timeout=180)
        r.raise_for_status()
        if r.text.lstrip().startswith("<"):
            raise RuntimeError("the archive rejected the search query")

        exposures = []
        for row in csv.DictReader(io.StringIO(r.text)):
            uri = row["uri"]
            if not uri.startswith(URI_PREFIX):
                continue
            did = row["obs_publisher_did"]
            det = int(row["energy_bandpassname"].rsplit("D", 1)[1])
            try:
                x, y = _pixel_from_corners(_parse_ewkb_polygon(row["poly"]), ra, dec)
            except Exception:
                continue
            lam, dlam = wavelength_at(det, x, y)
            mjd = float(row["time_bounds_lower"])
            exposures.append({
                "id": did.split("?", 1)[1],
                "key": uri[len(URI_PREFIX):],
                "det": det,
                "mjd": round(mjd, 6),
                "date": Time(mjd, format="mjd").isot[:19],
                "exptime": float(row["time_exposure"] or 0),
                "release": did.split("?", 1)[0].rsplit("_", 1)[-1],
                "x": round(x, 1),
                "y": round(y, 1),
                "lam": round(lam, 4),
                "dlam": round(dlam, 4),
            })

        # Reprocessed duplicates of the same exposure: keep the newest release.
        best: dict[str, dict] = {}
        for e in exposures:
            if e["id"] not in best or e["release"] > best[e["id"]]["release"]:
                best[e["id"]] = e
        exposures = sorted(best.values(), key=lambda e: e["mjd"])

        epochs: list[dict] = []
        for e in exposures:
            if not epochs or e["mjd"] - epochs[-1]["mjd1"] > EPOCH_GAP_DAYS:
                epochs.append({"index": len(epochs), "mjd0": e["mjd"], "mjd1": e["mjd"], "n": 0})
            ep = epochs[-1]
            ep["mjd1"] = e["mjd"]
            ep["n"] += 1
            e["epoch"] = ep["index"]
        for ep in epochs:
            mid = Time((ep["mjd0"] + ep["mjd1"]) / 2, format="mjd").datetime
            ep["label"] = mid.strftime("%b %Y")
            ep["date0"] = Time(ep["mjd0"], format="mjd").isot[:10]
            ep["date1"] = Time(ep["mjd1"], format="mjd").isot[:10]

        out = {"ra": ra, "dec": dec, "exposures": exposures, "epochs": epochs}
        if exposures:
            path.write_text(json.dumps(out))
        return out


def find_exposure(ra: float, dec: float, exp_id: str) -> dict:
    for e in search(ra, dec)["exposures"]:
        if e["id"] == exp_id:
            return e
    raise KeyError(exp_id)


# ---------------------------------------------------------------- wavelength

_wave_tables: dict[int, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
_WAVE_FILE = Path(__file__).resolve().parent / "data" / "wave_tables.json"


def _load_wave_tables() -> None:
    raw = json.loads(_WAVE_FILE.read_text())
    for det, t in raw["detectors"].items():
        _wave_tables[int(det)] = (
            np.array(t["x"], float), np.array(t["y"], float), np.array(t["values"], float)
        )


def wavelength_at(det: int, x: float, y: float) -> tuple[float, float]:
    """Central wavelength and bandwidth (microns) seen by 0-based pixel (x, y).

    Every SPHEREx detector sits behind a filter whose colour changes smoothly
    from one edge to the other, so wavelength is a function of pixel position.
    The mission publishes that function as a coarse lookup grid per detector.
    """
    if not _wave_tables:
        _load_wave_tables()
    gx, gy, vals = _wave_tables[det]          # vals[iy, ix, (wavelength, width)]
    px = min(max(x + 1.0, gx[0]), gx[-1])     # grid is in 1-based pixels
    py = min(max(y + 1.0, gy[0]), gy[-1])
    ix = int(min(max(np.searchsorted(gx, px) - 1, 0), len(gx) - 2))
    iy = int(min(max(np.searchsorted(gy, py) - 1, 0), len(gy) - 2))
    fx = (px - gx[ix]) / (gx[ix + 1] - gx[ix])
    fy = (py - gy[iy]) / (gy[iy + 1] - gy[iy])
    v = (vals[iy, ix] * (1 - fx) * (1 - fy) + vals[iy, ix + 1] * fx * (1 - fy)
         + vals[iy + 1, ix] * (1 - fx) * fy + vals[iy + 1, ix + 1] * fx * fy)
    return float(v[0]), float(v[1])


def fetch_wave_table(key: str) -> dict:
    """Read the wavelength lookup grid stored at the end of an image file."""
    tail = _get_range(key, 0, None, suffix=2 * BLOCK)
    hdu = fits.BinTableHDU.fromstring(tail)
    row = hdu.data[0]
    return {
        "x": [int(v) for v in row["X"]],
        "y": [int(v) for v in row["Y"]],
        "values": np.asarray(row["VALUES"], float).round(6).tolist(),
        "source": next((str(h) for h in hdu.header.get("HISTORY", []) if "Calibration" in str(h)), ""),
    }


# ---------------------------------------------------------------- pixels

class Exposure:
    """Header, sky geometry and pixel access for one image file."""

    def __init__(self, key: str, header: fits.Header, data_offset: int):
        self.key = key
        self.header = header
        self.data_offset = data_offset
        self.wcs = WCS(header)                 # primary WCS: sky, with distortion
        self.nx = int(header["NAXIS1"])
        self.ny = int(header["NAXIS2"])
        self.det = int(header["DETECTOR"])
        self.mjd = float(header.get("MJD-AVG", header.get("MJD-OBS", 0)))

    def world_to_pixel(self, ra, dec):
        return self.wcs.all_world2pix(ra, dec, 0)

    def read_rows(self, y0: int, y1: int) -> np.ndarray:
        """Rows y0..y1 inclusive as a float32 array of shape (rows, nx)."""
        start = self.data_offset + y0 * self.nx * 4
        end = self.data_offset + (y1 + 1) * self.nx * 4 - 1
        raw = _get_range(self.key, start, end)
        return np.frombuffer(raw, dtype=">f4").reshape(y1 - y0 + 1, self.nx).astype(np.float32)


def _parse_headers(buf: bytes) -> tuple[fits.Header, int] | None:
    """Return the image header and the byte offset of its pixels, if complete."""
    ends = []
    for off in range(0, len(buf) - BLOCK + 1, BLOCK):
        block = buf[off:off + BLOCK]
        if any(block[i:i + 80].rstrip() == b"END" for i in range(0, BLOCK, 80)):
            ends.append(off + BLOCK)
            if len(ends) == 2:
                break
    if len(ends) < 2:
        return None
    header = fits.Header.fromstring(buf[ends[0]:ends[1]].decode("ascii", "replace"))
    return header, ends[1]


# Parsed headers are large (hundreds of cards plus a sky projection), so keep
# only the few most recently used; the raw bytes stay cached on disk.
_exposures: "OrderedDict[str, Exposure]" = OrderedDict()
_MAX_OPEN = 24


def load_exposure(key: str) -> Exposure:
    with _locks_guard:
        if key in _exposures:
            _exposures.move_to_end(key)
            return _exposures[key]
    path = _cache_path("header", key, ".bin")
    with _lock(str(path)):
        buf = path.read_bytes() if path.exists() else b""
        parsed = _parse_headers(buf) if buf else None
        size = HEADER_GUESS
        while parsed is None:
            buf = _get_range(key, 0, size - 1)
            parsed = _parse_headers(buf)
            if parsed is None:
                if size > 40 * BLOCK:
                    raise RuntimeError(f"no image header found in {key}")
                size *= 2
            else:
                path.write_bytes(buf[:parsed[1]])
        exp = Exposure(key, *parsed)
        with _locks_guard:
            _exposures[key] = exp
            while len(_exposures) > _MAX_OPEN:
                _exposures.popitem(last=False)
        return exp
