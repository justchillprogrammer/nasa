"""Access to SPHEREx Level-2 spectral images in the NASA/IPAC IRSA archive.

Three things live here:

* ``search``      - which exposures cover a sky position (IRSA image search, SIA v2)
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
from astropy.wcs import WCS, NoConvergence

# The archive's image search (IVOA SIA v2) answers a position query in about
# a second; the TAP join used before took up to a minute and sometimes
# returned exposures from elsewhere in the sky.
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
# Public mirrors of the same files. The cloud bucket answers range requests
# fastest; the archive itself is the fallback.
DATA_BASES = [
    "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/",
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/",
]
URI_PREFIX = "ibe/data/spherex/"

DETECTOR_SIZE = 2040          # active pixels per side
BLOCK = 2880                  # FITS block size in bytes
HEADER_GUESS = 24 * BLOCK     # enough for primary + SIP image headers in 1 request
EPOCH_GAP_DAYS = 45           # a longer pause than this starts a new sky pass

CACHE = Path(os.environ.get("SPHEREX_CACHE", Path(__file__).resolve().parent.parent / ".cache"))

_local = threading.local()
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def valid_key(key: str) -> bool:
    """Ensure an exposure key is a safe relative FITS path inside the archive."""
    return (
        bool(key)
        and ".." not in key
        and not key.startswith(("/", "\\"))
        and key.endswith(".fits")
        and all(c.isalnum() or c in "/_.-" for c in key)
    )


def _mjd_to_isot(mjd: float) -> str:
    """Fast MJD to ISO-8601 UTC string (avoids slow per-row astropy Time init)."""
    from datetime import datetime, timezone
    ts = (mjd - 40587.0) * 86400.0
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _session() -> requests.Session:
    if not hasattr(_local, "s"):
        s = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=2)
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


def write_cache(path: Path, data: str | bytes) -> None:
    """Write a cache file atomically, so a concurrent reader never sees half a file.

    Failures are ignored: the cache is an optimisation, never a requirement.
    """
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        if isinstance(data, bytes):
            tmp.write_bytes(data)
        else:
            tmp.write_text(data)
        os.replace(tmp, path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def _get_range(key: str, start: int, end: int | None, suffix: int | None = None) -> bytes:
    """Fetch bytes [start, end] of an archive file (or the last ``suffix`` bytes)."""
    rng = f"bytes=-{suffix}" if suffix else f"bytes={start}-{end}"
    last: Exception | None = None
    for attempt in range(3):
        for base in DATA_BASES:
            try:
                r = _session().get(base + key, headers={"Range": rng}, timeout=(6, 25))
                if r.status_code in (200, 206):
                    return r.content
                last = RuntimeError(f"HTTP {r.status_code} for {key}")
            except requests.RequestException as e:  # try the other mirror
                last = e
        time.sleep(0.3 * (attempt + 1))
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
    # A detector spans about 3.5 degrees (5 corner to corner). A footprint whose corners are far
    # from the position cannot contain it (and the projection below would
    # give a mirrored, meaningless answer), so refuse it.
    r1, d1, r2, d2 = map(np.radians, (cra, cdec, ra, dec))
    sep = np.degrees(np.arccos(np.clip(np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(r1 - r2), -1, 1)))
    if len(corners) < 4 or np.max(sep) > 6.0:
        raise ValueError("footprint does not contain the position")
    xi, eta = _tangent(cra, cdec, ra, dec)
    A = np.column_stack([xi, eta, np.ones(4)])
    coef, *_ = np.linalg.lstsq(A, pix, rcond=None)
    x, y = coef[2]  # the target sits at the tangent point (0, 0)
    return float(x), float(y)


# Results shipped with the site (tools/build_spots.py), checked before the
# archive so popular spots open instantly even on a fresh server.
BUNDLED = Path(__file__).resolve().parent / "data"


def search_key(ra: float, dec: float) -> str:
    return f"v3:{ra:.4f}:{dec:.4f}"


def bundled_path(kind: str, key: str) -> Path:
    return BUNDLED / kind / (hashlib.sha1(key.encode()).hexdigest()[:20] + ".json.gz")


def _parse_sregion(text: str) -> list[tuple[float, float]]:
    """Corner (ra, dec) pairs of an 'POLYGON ICRS ra dec ra dec ...' footprint."""
    parts = text.split()
    i = 2 if parts[1].upper() in ("ICRS", "FK5", "J2000") else 1
    v = [float(t) for t in parts[i:]]
    pts = [(v[k] % 360.0, v[k + 1]) for k in range(0, len(v) - 1, 2)]
    return pts[:4]


def _query_sia(ra: float, dec: float, mjd_range: tuple[float, float] | None = None) -> list[dict]:
    """SPHEREx science exposures whose footprint contains (ra, dec),
    optionally only those taken between two MJDs."""
    params = {"POS": f"CIRCLE {ra:.6f} {dec:.6f} 0.001", "FACILITY": "SPHEREx",
              "RESPONSEFORMAT": "CSV", "MAXREC": "20000"}
    if mjd_range:
        params["TIME"] = f"{mjd_range[0]:.5f} {mjd_range[1]:.5f}"
    # The archive's front end sometimes answers 502 for a moment; retry.
    last: Exception | None = None
    for attempt in range(6):
        try:
            r = _session().get(SIA_URL, params=params, timeout=(6, 40))
            if r.status_code in (502, 503, 504):
                raise requests.HTTPError(f"archive answered {r.status_code}", response=r)
            r.raise_for_status()
            break
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            last = e
            time.sleep(0.5 + 0.5 * attempt)
    else:
        raise RuntimeError(f"the NASA archive's image search did not answer ({last})")
    if r.text.lstrip().startswith("<"):
        raise RuntimeError("the archive rejected the image search")
    rows = []
    for row in csv.DictReader(io.StringIO(r.text)):
        url = row.get("access_url", "")
        if row.get("dataproduct_subtype") != "science" or "cube" in row.get("obs_collection", ""):
            continue
        if URI_PREFIX not in url or not url.endswith(".fits"):
            continue
        try:
            rows.append({
                "did": row["obs_publisher_did"],
                "key": url.split(URI_PREFIX, 1)[1],
                "band": row["energy_bandpassname"],
                "mjd": float(row["t_min"]),
                "exptime": float(row["t_exptime"] or 0),
                "corners": _parse_sregion(row["s_region"]),
            })
        except (KeyError, ValueError, IndexError):
            continue
    return rows


def search(ra: float, dec: float, use_saved: bool = True) -> dict:
    """All exposures whose footprint contains (ra, dec), grouped into sky passes.

    use_saved=False asks the archive even when a bundled or cached answer
    exists (tools/build_spots.py uses it to rebuild the bundle).
    """
    key = search_key(ra, dec)
    shipped = bundled_path("search", key)
    if use_saved and shipped.exists():
        import gzip
        with gzip.open(shipped, "rt") as f:
            return json.load(f)
    path = _cache_path("search", key, ".json")
    with _lock(str(path)):
        if use_saved and path.exists():
            return json.loads(path.read_text())

        # (The archive's TAP service was tried as a fallback, but it is slow
        # and returned exposures from elsewhere in the sky, so it is not used.)
        rows = _query_sia(ra, dec)

        # One row per exposure: prefer a data release (dr*) over a quick
        # release (qr*), and the newest of each kind.
        def rank(release: str) -> tuple:
            return (release.startswith("dr"), release)

        best: dict[str, tuple[str, dict]] = {}
        for row in rows:
            did = row["did"]
            if "?" not in did:
                continue
            prefix, exp_id = did.split("?", 1)
            release = prefix.rsplit("_", 1)[-1]
            if exp_id not in best or rank(release) > rank(best[exp_id][0]):
                best[exp_id] = (release, row)

        exposures = []
        for exp_id, (release, row) in best.items():
            det = int(row["band"].rsplit("D", 1)[1])
            try:
                x, y = _pixel_from_corners(row["corners"], ra, dec)
            except Exception:
                continue
            if not (0 <= x < DETECTOR_SIZE and 0 <= y < DETECTOR_SIZE):
                continue
            lam, dlam = wavelength_at(det, x, y)
            mjd = row["mjd"]
            exposures.append({
                "id": exp_id,
                "key": row["key"],
                "det": det,
                "mjd": round(mjd, 6),
                "date": _mjd_to_isot(mjd),
                "exptime": row["exptime"],
                "release": release,
                "x": round(x, 1),
                "y": round(y, 1),
                "lam": round(lam, 4),
                "dlam": round(dlam, 4),
            })

        exposures = sorted(exposures, key=lambda e: e["mjd"])

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
            ep["date0"] = _mjd_to_isot(ep["mjd0"])[:10]
            ep["date1"] = _mjd_to_isot(ep["mjd1"])[:10]

        out = {"ra": ra, "dec": dec, "exposures": exposures, "epochs": epochs}
        if exposures:
            write_cache(path, json.dumps(out))
        return out


def find_exposure(ra: float, dec: float, exp_id: str) -> dict:
    for e in search(ra, dec)["exposures"]:
        if e["id"] == exp_id:
            return e
    raise KeyError(exp_id)


def resolve_name(name: str) -> dict:
    """Resolve an astronomical object name (star, brown dwarf, nebula, cluster, galaxy)
    to ICRS (ra, dec) via the CDS Sesame service (SIMBAD + NED + VizieR)."""
    import re
    import urllib.parse
    q = name.strip()
    if not q or len(q) > 120:
        raise ValueError("empty or invalid target name")
    path = _cache_path("resolve", f"v1:{q.lower()}", ".json")
    with _lock(str(path)):
        if path.exists():
            return json.loads(path.read_text())
        url = f"https://cds.unistra.fr/cgi-bin/nph-sesame/-ox/SNV?{urllib.parse.quote(q)}"
        r = _session().get(url, timeout=12)
        r.raise_for_status()
        text = r.text
        m_ra = re.search(r"<jradeg>\s*([0-9.+\-eE]+)\s*</jradeg>", text)
        m_dec = re.search(r"<jdedeg>\s*([0-9.+\-eE]+)\s*</jdedeg>", text)
        if not (m_ra and m_dec):
            raise KeyError(f"object '{q}' not found in astronomical catalogs (SIMBAD/NED)")
        m_oname = re.search(r"<oname>\s*([^<]+?)\s*</oname>", text)
        m_otype = re.search(r"<otype>\s*([^<]+?)\s*</otype>", text)
        out = {
            "name": m_oname.group(1).strip() if m_oname else q,
            "otype": m_otype.group(1).strip() if m_otype else "",
            "ra": round(float(m_ra.group(1)) % 360.0, 5),
            "dec": round(float(m_dec.group(1)), 5),
        }
        write_cache(path, json.dumps(out))
        return out


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
        """Detector pixel of sky positions, distortion included.

        Far off the detector the distortion polynomial can fail to invert
        (bright-star fields such as Vega's hit this). Those points are
        off-detector anyway, so they get the plain linear answer instead of
        failing the whole image.
        """
        ra_a, dec_a = np.asarray(ra, float), np.asarray(dec, float)
        pts = np.column_stack([ra_a.ravel(), dec_a.ravel()])
        try:
            out = self.wcs.all_world2pix(pts, 0)
        except NoConvergence as err:
            out = np.array(err.best_solution, float)
            bad = np.zeros(len(out), bool)
            for idx in (err.divergent, err.slow_conv):
                if idx is not None:
                    bad[np.asarray(idx, int)] = True
            bad |= ~np.isfinite(out).all(axis=1)
            if bad.any():
                out[bad] = self.wcs.wcs_world2pix(pts[bad], 0)
        x, y = out[:, 0].reshape(ra_a.shape), out[:, 1].reshape(ra_a.shape)
        return (float(x), float(y)) if ra_a.ndim == 0 else (x, y)

    # Detector defects, filled for display and left out of photometry:
    # SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD. TRANSIENT and OUTLIER are
    # deliberately NOT used: they mark anything absent from other exposures,
    # which includes the comets and asteroids Sky Blink follows.
    BAD_FLAGS = (1 << 2) | (1 << 6) | (1 << 9) | (1 << 10) | (1 << 11)

    def _flags_layout(self) -> dict | None:
        """Where the compressed FLAGS extension sits (read once per file)."""
        if hasattr(self, "_flags"):
            return self._flags
        self._flags = None
        try:
            start = -(-(self.data_offset + self.nx * self.ny * 4) // BLOCK) * BLOCK
            buf = _get_range(self.key, start, start + 12 * BLOCK - 1)
            cards, end = {}, None
            for i in range(0, len(buf) - 79, 80):
                card = buf[i:i + 80].decode("latin1")
                if card.startswith("END"):
                    end = i + 80
                    break
                if "=" in card[:10]:
                    k, v = card[:8].strip(), card[10:].split("/")[0].strip().strip("'").strip()
                    cards[k] = v
            if end is None or cards.get("EXTNAME") != "FLAGS" or cards.get("ZCMPTYPE") != "RICE_1":
                return None
            hdr_len = -(-end // BLOCK) * BLOCK
            table = start + hdr_len
            self._flags = {
                "table": table, "row_bytes": int(cards["NAXIS1"]),
                "heap": table + int(cards.get("THEAP", int(cards["NAXIS1"]) * int(cards["NAXIS2"]))),
                "block": int(cards.get("ZVAL1", 32)), "bytepix": int(cards.get("ZVAL2", 4)),
                "width": int(cards["ZNAXIS1"]),
            }
        except Exception:
            self._flags = None
        return self._flags

    def read_flag_rows(self, y0: int, y1: int) -> np.ndarray | None:
        """FLAGS rows y0..y1 (int32), or None when they cannot be read."""
        lay = self._flags_layout()
        if not lay:
            return None
        try:
            from astropy.io.fits.hdu.compressed._codecs import Rice1
            desc = _get_range(self.key, lay["table"] + y0 * lay["row_bytes"],
                              lay["table"] + (y1 + 1) * lay["row_bytes"] - 1)
            d = np.frombuffer(desc, dtype=">i4").reshape(-1, 2)        # (length, offset)
            lo, hi = int(d[:, 1].min()), int((d[:, 1] + d[:, 0]).max())
            heap = _get_range(self.key, lay["heap"] + lo, lay["heap"] + hi - 1)
            codec = Rice1(blocksize=lay["block"], bytepix=lay["bytepix"], tilesize=lay["width"])
            raw = np.frombuffer(heap, dtype=np.uint8)
            rows = [np.frombuffer(codec.decode(raw[o - lo:o - lo + n]), dtype=np.int32)[:lay["width"]]
                    for n, o in d]
            return np.stack(rows)
        except Exception:
            return None

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
                write_cache(path, buf[:parsed[1]])
        exp = Exposure(key, *parsed)
        with _locks_guard:
            _exposures[key] = exp
            while len(_exposures) > _MAX_OPEN:
                _exposures.popitem(last=False)
        return exp
