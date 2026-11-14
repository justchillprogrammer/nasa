"""Follow a comet or asteroid through SPHEREx exposures.

1. ``ephemeris``      Where NASA JPL Horizons says the object was, day by day.
2. ``find_exposures`` Which SPHEREx exposures caught it. SPHEREx scans the
                      sky roughly at right angles to the Sun, so only days
                      when the object was 50-130 degrees from the Sun are
                      searched, each with a quick time-limited archive query.
3. ``follow``         For each exposure, the object's exact position at that
                      moment, a cutout centred on it, and its brightness.

Positions are for a geocentric observer. SPHEREx orbits about 700 km up,
which shifts a main-belt asteroid by well under one pixel.
"""

from __future__ import annotations

import csv
import io
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from astropy.time import Time

import detect
import imaging
import spherex as sx

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
MISSION_START = "2025-04-25"


# ---------------------------------------------------------------- ephemeris


def ephemeris(command: str, start: str, stop: str, step: str) -> list[dict]:
    """Rows of time (MJD), RA, Dec, magnitude, distance (au), solar elongation."""
    key = f"eph:v1:{command}:{start}:{stop}:{step}"
    cache = sx._cache_path("track", key, ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    params = {
        "format": "json", "COMMAND": f"'{command}'", "EPHEM_TYPE": "OBSERVER",
        "CENTER": "'500@399'", "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": f"'{step}'", "QUANTITIES": "'1,3,9,20,23'", "ANG_FORMAT": "'DEG'",
        "CSV_FORMAT": "'YES'", "OBJ_DATA": "'NO'", "CAL_FORMAT": "'JD'",
    }
    r = sx._session().get(HORIZONS, params=params, timeout=120)
    r.raise_for_status()
    text = r.json().get("result", "")
    if "$$SOE" not in text:
        raise ValueError(text.strip().splitlines()[-1] if text.strip() else "no answer from Horizons")
    head = text.split("$$SOE")[0].strip().splitlines()
    cols = [c.strip() for c in head[-2].split(",")] if "," in head[-2] else [c.strip() for c in head[-1].split(",")]
    body = text.split("$$SOE")[1].split("$$EOE")[0].strip()
    rows = []
    for rec in csv.reader(io.StringIO(body)):
        rec = [x.strip() for x in rec]
        d = dict(zip(cols, rec))
        try:
            jd = float(d.get("Date_________JDUT") or rec[0])
            ra = float(d.get("R.A._____(ICRF)_____") or d.get("R.A.___(ICRF)___") or rec[3])
            dec = float(d.get("DEC______(ICRF)_____") or d.get("DEC____(ICRF)____") or rec[4])
        except (ValueError, IndexError):
            continue

        def num(*names):
            for n in names:
                v = d.get(n)
                if v not in (None, "", "n.a."):
                    try:
                        return float(v)
                    except ValueError:
                        pass
            return None
        rows.append({
            "mjd": jd - 2400000.5, "ra": ra, "dec": dec,
            "mag": num("APmag", "T-mag"),
            "delta": num("delta"),
            "elong": num("S-O-T"),
            "rate_ra": num("dRA*cosD"), "rate_dec": num("d(DEC)/dt"),
        })
    cache.write_text(json.dumps(rows))
    return rows


def _interp(rows: list[dict], mjd: float) -> tuple[float, float]:
    t = np.array([r["mjd"] for r in rows])
    i = int(np.clip(np.searchsorted(t, mjd) - 1, 0, len(t) - 2))
    f = (mjd - t[i]) / (t[i + 1] - t[i])
    ra0, ra1 = rows[i]["ra"], rows[i + 1]["ra"]
    if ra1 - ra0 > 180:
        ra1 -= 360
    elif ra0 - ra1 > 180:
        ra1 += 360
    return (ra0 + f * (ra1 - ra0)) % 360, rows[i]["dec"] + f * (rows[i + 1]["dec"] - rows[i]["dec"])


# ---------------------------------------------------------------- exposures


def _query_day(mjd: float, ra: float, dec: float, half: float = 1.0) -> list[dict]:
    adql = (
        "SELECT p.obs_publisher_did,p.time_bounds_lower,p.time_exposure,p.energy_bandpassname,a.uri "
        "FROM spherex.plane p JOIN spherex.artifact a ON a.planeid=p.planeid "
        "WHERE a.producttype='science' AND "
        f"p.time_bounds_lower BETWEEN {mjd - half:.4f} AND {mjd + half:.4f} AND "
        f"CONTAINS(POINT('ICRS',{ra:.5f},{dec:.5f}),p.poly)=1"
    )
    key = f"trkq:v1:{adql}"
    cache = sx._cache_path("track", key, ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    # The archive sometimes answers 502 when busy: retry, then skip the day
    # rather than abandon the whole search (finished days stay cached).
    text = None
    for attempt in range(4):
        try:
            r = sx._session().get(sx.TAP_URL, params={"QUERY": adql, "FORMAT": "csv"}, timeout=180)
            if r.status_code == 200 and not r.text.lstrip().startswith("<"):
                text = r.text
                break
        except Exception:
            pass
        time.sleep(5 * (attempt + 1))
    if text is None:
        return []          # not cached, so a later run tries this day again
    r_text = text
    out = []
    for row in csv.DictReader(io.StringIO(r_text)):
        if not row["uri"].startswith(sx.URI_PREFIX):
            continue
        did = row["obs_publisher_did"]
        out.append({
            "id": did.split("?", 1)[1], "key": row["uri"][len(sx.URI_PREFIX):],
            "mjd0": float(row["time_bounds_lower"]), "exptime": float(row["time_exposure"] or 0),
            "release": did.split("?", 1)[0].rsplit("_", 1)[-1],
        })
    cache.write_text(json.dumps(out))
    return out


def find_exposures(command: str, start: str = MISSION_START, stop: str | None = None,
                   log=print) -> tuple[list[dict], list[dict]]:
    stop = stop or Time.now().isot[:10]
    daily = ephemeris(command, start, stop, "1 d")
    days = [r for r in daily if r["elong"] is not None and 50 <= r["elong"] <= 130]
    log(f"  {len(daily)} days in the ephemeris, {len(days)} at a usable angle from the Sun")
    # Query every second usable day with a two-day window.
    picks = days[::2]
    with ThreadPoolExecutor(2) as pool:
        found = list(pool.map(lambda r: _query_day(r["mjd"], r["ra"], r["dec"]), picks))
    best: dict[str, dict] = {}
    for lst in found:
        for e in lst:
            if e["id"] not in best or e["release"] > best[e["id"]]["release"]:
                best[e["id"]] = e
    exps = sorted(best.values(), key=lambda e: e["mjd0"])
    log(f"  {len(exps)} exposures may contain it")
    return exps, daily


# ---------------------------------------------------------------- follow


def follow(command: str, size: float = 0.12, npix: int = 160, max_frames: int = 90,
           start: str = MISSION_START, stop: str | None = None, log=print) -> dict:
    exps, daily = find_exposures(command, start, stop, log=log)
    if not exps:
        return {"frames": [], "daily": daily}

    # Precise positions: a 30-minute ephemeris over each stretch of exposures.
    spans, cur = [], [exps[0]["mjd0"], exps[0]["mjd0"]]
    for e in exps[1:]:
        if e["mjd0"] - cur[1] > 2:
            spans.append(cur)
            cur = [e["mjd0"], e["mjd0"]]
        cur[1] = e["mjd0"]
    spans.append(cur)
    fine = []
    for a, b in spans:
        t0 = Time(a - 0.1, format="mjd").isot[:16].replace("T", " ")
        t1 = Time(b + 0.2, format="mjd").isot[:16].replace("T", " ")
        fine += ephemeris(command, t0, t1, "30 m")
    fine.sort(key=lambda r: r["mjd"])

    def place(e):
        mid = e["mjd0"] + e["exptime"] / 86400 / 2
        ra, dec = _interp(fine, mid)
        try:
            exp = sx.load_exposure(e["key"])
            x, y = (float(v) for v in exp.world_to_pixel(ra, dec))
        except Exception:
            return None
        margin = 20
        if not (margin <= x < exp.nx - margin and margin <= y < exp.ny - margin):
            return None
        lam, dlam = sx.wavelength_at(exp.det, x, y)
        return {**e, "mjd": mid, "ra": ra, "dec": dec, "det": exp.det, "lam": lam, "dlam": dlam}

    with ThreadPoolExecutor(8) as pool:
        placed = [p for p in pool.map(place, exps) if p]
    log(f"  {len(placed)} exposures really contain it")
    if len(placed) > max_frames:   # keep an even spread in time
        idx = np.linspace(0, len(placed) - 1, max_frames).round().astype(int)
        placed = [placed[i] for i in sorted(set(idx))]

    def shoot(p):
        try:
            img, meta = imaging.cutout(p["key"], p["ra"], p["dec"], size, npix)
        except Exception:
            return None
        if meta["coverage"] < 0.5:
            return None
        img = img - detect._block_background(img, 20)
        sig = detect._robust_sigma(img)
        if not sig or not math.isfinite(sig) or sig <= 0:
            return None
        try:
            ph = imaging.photometry(p["key"], p["ra"], p["dec"])
        except Exception:
            ph = None
        return {**p, "image": (img / sig).astype(np.float32), "sigma": sig,
                "flux": ph["flux"] if ph else None, "err": ph["err"] if ph else None}

    with ThreadPoolExecutor(8) as pool:
        frames = [f for f in pool.map(shoot, placed) if f]
    frames.sort(key=lambda f: f["mjd"])
    log(f"  {len(frames)} frames made")
    return {"frames": frames, "daily": daily, "size": size, "npix": npix}
