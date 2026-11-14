"""Find what changed in one patch of sky between SPHEREx sweeps.

Pipeline, for one position:

1. ``stack_sweeps``  For every six-monthly sweep, take all exposures in a
   wavelength window, put them on one shared grid, and median-combine them.
   Each single exposure covers the view only partly and at one wavelength;
   the stack is complete and much less noisy.
2. ``find_sources``  Peaks in each stack, with positions and brightness.
3. ``find_changes``  Match sources between sweeps. Report sources that moved
   in a straight line over time, and sources whose brightness changed.

Everything here is measurement. Nothing is guessed: each reported change
carries the numbers it was based on and how significant it is.
Only numpy is needed.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import imaging
import spherex as sx

# ---------------------------------------------------------------- helpers


def _robust_sigma(a: np.ndarray) -> float:
    a = a[np.isfinite(a)]
    if a.size < 20:
        return float("nan")
    med = np.median(a)
    return float(1.4826 * np.median(np.abs(a - med)))


def _block_background(img: np.ndarray, box: int = 24) -> np.ndarray:
    """Smooth background: medians of coarse boxes, interpolated back."""
    h, w = img.shape
    ny, nx = max(1, h // box), max(1, w // box)
    grid = np.full((ny, nx), np.nan, np.float32)
    for j in range(ny):
        for i in range(nx):
            blk = img[j * h // ny:(j + 1) * h // ny, i * w // nx:(i + 1) * w // nx]
            blk = blk[np.isfinite(blk)]
            if blk.size > box:  # clip bright stars before the median
                lo = np.percentile(blk, 70)
                grid[j, i] = np.median(blk[blk <= lo])
    if np.all(np.isnan(grid)):
        return np.zeros_like(img)
    fill = np.nanmedian(grid)
    grid = np.where(np.isfinite(grid), grid, fill)
    yc = (np.arange(ny) + 0.5) * h / ny - 0.5
    xc = (np.arange(nx) + 0.5) * w / nx - 0.5
    rows = np.array([np.interp(np.arange(w), xc, grid[j]) for j in range(ny)])
    return np.array([np.interp(np.arange(h), yc, rows[:, i]) for i in range(w)]).T.astype(np.float32)


def _smooth(img: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur that ignores missing pixels."""
    r = max(1, int(math.ceil(3 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    valid = np.isfinite(img).astype(np.float32)
    data = np.where(valid > 0, img, 0).astype(np.float32)

    def conv(a, axis):
        return np.apply_along_axis(lambda m: np.convolve(m, k, mode="full")[r:r + len(m)], axis, a)

    num = conv(conv(data, 0), 1)
    den = conv(conv(valid, 0), 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[valid == 0] = np.nan
    return out.astype(np.float32)


def _local_max(img: np.ndarray, r: int = 2) -> np.ndarray:
    """True where a pixel is the largest in its (2r+1)^2 neighbourhood."""
    h, w = img.shape
    pad = np.pad(np.nan_to_num(img, nan=-np.inf), r, constant_values=-np.inf)
    out = np.ones((h, w), bool)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx or dy:
                out &= img >= pad[r + dy:r + dy + h, r + dx:r + dx + w]
    return out & np.isfinite(img)


# ---------------------------------------------------------------- stacking


def stack_sweeps(ra: float, dec: float, size: float, npix: int,
                 lam_lo: float = 1.0, lam_hi: float = 2.0,
                 max_per_sweep: int = 40, workers: int = 8, log=print) -> dict:
    """One complete, aligned, background-subtracted image per sweep."""
    res = sx.search(ra, dec)
    epochs = res["epochs"]
    out = []
    for ep in epochs:
        exps = [e for e in res["exposures"]
                if e["epoch"] == ep["index"] and lam_lo <= e["lam"] <= lam_hi]
        exps = exps[:max_per_sweep]
        if len(exps) < 3:
            log(f"  sweep {ep['label']}: only {len(exps)} exposures in the window, skipped")
            continue

        def grab(e):
            try:
                img, meta = imaging.cutout(e["key"], ra, dec, size, npix)
                return e, img, meta
            except Exception as err:  # one bad file should not stop the sweep
                log(f"  skip {e['id']}: {err}")
                return e, None, None

        with ThreadPoolExecutor(workers) as pool:
            got = [g for g in pool.map(grab, exps) if g[1] is not None and g[2]["coverage"] > 0.15]
        if len(got) < 3:
            continue

        frames, used = [], []
        for e, img, meta in got:
            img = img - _block_background(img)
            frames.append(img)
            used.append({"id": e["id"], "date": e["date"], "mjd": e["mjd"], "lam": e["lam"]})
        cube = np.stack(frames)

        # Each exposure is at a different wavelength, so stars are a little
        # brighter or fainter in each. Scale every frame to the median frame.
        ref = np.nanmedian(cube, axis=0)
        sig = _robust_sigma(ref)
        bright = np.isfinite(ref) & (ref > 15 * sig)
        for i in range(len(cube)):
            ok = bright & np.isfinite(cube[i])
            if ok.sum() > 30:
                g = np.median(cube[i][ok] / ref[ok])
                if 0.2 < g < 5:
                    cube[i] /= g
        count = np.isfinite(cube).sum(axis=0)
        with np.errstate(all="ignore"):
            stack = np.nanmedian(cube, axis=0).astype(np.float32)
        stack[count < 2] = np.nan

        mjds = [u["mjd"] for u in used]
        out.append({
            "index": ep["index"], "label": ep["label"],
            "mjd": float(np.median(mjds)), "mjd0": min(mjds), "mjd1": max(mjds),
            "n": len(used), "exposures": used, "image": stack, "count": count.astype(np.int16),
        })
        log(f"  sweep {ep['label']}: stacked {len(used)} exposures")

    # Put all sweeps on one brightness scale, using the stars they share.
    if len(out) > 1:
        ref = out[0]["image"]
        sig = _robust_sigma(ref)
        for s in out[1:]:
            ok = np.isfinite(ref) & np.isfinite(s["image"]) & (ref > 15 * sig)
            if ok.sum() > 30:
                g = np.median(s["image"][ok] / ref[ok])
                if 0.2 < g < 5:
                    s["image"] = s["image"] / g
    return {"ra": ra, "dec": dec, "size": size, "npix": npix,
            "lam_lo": lam_lo, "lam_hi": lam_hi, "sweeps": out}


# ---------------------------------------------------------------- sources


def find_sources(img: np.ndarray, fwhm_px: float, nsigma: float = 6.0) -> dict:
    """Peaks in an image with centroid, brightness and its uncertainty."""
    sig_pix = _robust_sigma(img)
    # Saturated star cores are missing pixels. Fill them with a high value for
    # finding peaks only, so each saturated star is one peak, not a ring.
    hole = np.isnan(img)
    work = np.where(hole, np.nanmax(img) if np.isfinite(img).any() else 0, img)
    sm = _smooth(work, fwhm_px / 2.355)
    sig_sm = _robust_sigma(sm)
    peaks = _local_max(sm, 2) & (sm > nsigma * sig_sm)
    ys, xs = np.nonzero(peaks)
    h, w = img.shape
    r_ap = max(1.5, 0.9 * fwhm_px)
    half = int(math.ceil(r_ap)) + 1
    yy, xx = np.mgrid[-half:half + 1, -half:half + 1]
    ap = (xx ** 2 + yy ** 2) <= r_ap ** 2
    n_ap = int(ap.sum())

    rows = []
    for y, x in zip(ys, xs):
        if y < half or x < half or y >= h - half or x >= w - half:
            continue
        cut = img[y - half:y + half + 1, x - half:x + half + 1]
        if np.all(np.isfinite(cut[ap])):
            wgt = np.clip(cut, 0, None) * ap
            tot = wgt.sum()
            if tot <= 0:
                continue
            cx = x + float((wgt * xx).sum() / tot)
            cy = y + float((wgt * yy).sum() / tot)
            flux = float(cut[ap].sum())
            err = sig_pix * math.sqrt(n_ap) * 1.5  # stacked pixels are correlated
            snr = flux / err if err > 0 else 0
            pos_err = max(0.05, fwhm_px / max(snr, 1e-3))
            sat = 0.0
        else:
            # Saturated: locate the star from the symmetric ring of light
            # around the missing core. Position only; brightness unknown.
            R = int(math.ceil(3 * fwhm_px)) + 4
            if y < R or x < R or y >= h - R or x >= w - R:
                continue
            big = img[y - R:y + R + 1, x - R:x + R + 1]
            gy, gx = np.mgrid[-R:R + 1, -R:R + 1]
            hole_c = np.isnan(big)
            if hole_c.sum() > 0.5 * (math.pi * (R - 3) ** 2):
                continue  # edge of the data, not a star
            ring = np.isfinite(big) & (np.hypot(gx, gy) <= R - 1)
            wgt = np.where(ring, np.clip(np.nan_to_num(big), 0, None), 0.0)
            wgt = wgt ** 2              # favour the bright inner wings
            tot = wgt.sum()
            if tot <= 0:
                continue
            cx = x + float((wgt * gx).sum() / tot)
            cy = y + float((wgt * gy).sum() / tot)
            flux, err, snr, pos_err, sat = float("nan"), float("nan"), 999.0, 0.25, 1.0
        rows.append((cx, cy, flux, err, snr, pos_err, float(sm[y, x]), sat))
    a = np.array(rows, float).reshape(-1, 8)
    return {"x": a[:, 0], "y": a[:, 1], "flux": a[:, 2], "err": a[:, 3],
            "snr": a[:, 4], "pos_err": a[:, 5], "peak": a[:, 6], "sat": a[:, 7] > 0,
            "sigma": sig_pix}


def _nearest(ax, ay, bx, by):
    """Index and distance of the nearest b for every a (brute force)."""
    if len(bx) == 0:
        return np.full(len(ax), -1), np.full(len(ax), np.inf)
    d = np.hypot(ax[:, None] - bx[None, :], ay[:, None] - by[None, :])
    j = np.argmin(d, axis=1)
    return j, d[np.arange(len(ax)), j]


# ---------------------------------------------------------------- changes


def find_changes(stacks: dict, max_items: int = 12) -> dict:
    """Moving and brightness-changing sources across the sweeps."""
    sweeps = stacks["sweeps"]
    if len(sweeps) < 2:
        return {"changes": [], "n_sources": 0, "note": "fewer than two sweeps"}
    size, npix = stacks["size"], stacks["npix"]
    arcsec_px = size * 3600 / npix
    fwhm_px = 9.0 / arcsec_px          # SPHEREx PSF at 1-2 um is about 9 arcsec
    cats = [find_sources(s["image"], fwhm_px) for s in sweeps]
    years = [(s["mjd"] - sweeps[0]["mjd"]) / 365.25 for s in sweeps]
    first, last = cats[0], cats[-1]
    span = years[-1] - years[0]

    def isolated(cat, i, r):
        d = np.hypot(cat["x"] - cat["x"][i], cat["y"] - cat["y"][i])
        return np.sum(d < r) == 1

    changes = []

    # --- moved: in the first and last sweep, a nearby source on each side
    # with no static counterpart, consistent with steady motion.
    static_r = max(1.0, 0.6 * fwhm_px)
    move_r = max(6.0, 25.0 / arcsec_px)          # up to ~25 arcsec in a year
    SYS = 0.12                                    # px: astrometric floor between stacks

    # Remove any small overall shift between sweeps, measured on bright stars.
    for k in range(1, len(cats)):
        jj, dd = _nearest(first["x"], first["y"], cats[k]["x"], cats[k]["y"])
        good = (dd < static_r) & (first["snr"] > 30) & ~first["sat"]
        if good.sum() >= 10:
            cats[k]["x"] = cats[k]["x"] - np.median(cats[k]["x"][jj[good]] - first["x"][good])
            cats[k]["y"] = cats[k]["y"] - np.median(cats[k]["y"][jj[good]] - first["y"][good])
    last = cats[-1]

    j_fl, d_fl = _nearest(first["x"], first["y"], last["x"], last["y"])
    j_lf, d_lf = _nearest(last["x"], last["y"], first["x"], first["y"])
    for i in range(len(first["x"])):
        j = j_fl[i]
        if j < 0 or d_fl[i] > move_r or j_lf[j] != i:
            continue
        err0 = math.hypot(math.hypot(first["pos_err"][i], SYS), math.hypot(last["pos_err"][j], SYS))
        # 5 sigma, and the middle sweeps must also sit on the straight track
        # (checked below), which is strong extra evidence of real motion.
        if d_fl[i] < max(1.2, 5 * err0):   # 1.2 px floor: nebulae shift centroids by ~1 px
            continue                    # within measurement error: not moving
        if first["snr"][i] < 15 or last["snr"][j] < 15:
            continue
        if not (isolated(first, i, 2.5 * fwhm_px) and isolated(last, j, 2.5 * fwhm_px)):
            continue
        if first["sat"][i] != last["sat"][j]:
            continue                    # one saturated, one not: different objects
        if not first["sat"][i]:
            ratio = last["flux"][j] / first["flux"][i]
            if not (0.5 < ratio < 2.0):
                continue                # different objects, not one that moved
        sig = d_fl[i] / err0
        # Middle sweeps must sit on the line between the two ends.
        track = []
        ok = True
        for k, cat in enumerate(cats):
            f = (years[k] - years[0]) / span if span else 0
            px = first["x"][i] + f * (last["x"][j] - first["x"][i])
            py = first["y"][i] + f * (last["y"][j] - first["y"][i])
            jj, dd = _nearest(np.array([px]), np.array([py]), cat["x"], cat["y"])
            if jj[0] < 0 or dd[0] > max(0.6, 4 * err0):
                ok = False
                break
            track.append({"x": float(cat["x"][jj[0]]), "y": float(cat["y"][jj[0]])})
        if not ok:
            continue
        dx_as = (last["x"][j] - first["x"][i]) * arcsec_px
        dy_as = (last["y"][j] - first["y"][i]) * arcsec_px
        changes.append({
            "kind": "moved", "significance": round(float(sig), 1),
            "track": track,
            "x": float(first["x"][i]), "y": float(first["y"][i]),
            "shift_arcsec": round(math.hypot(dx_as, dy_as), 1),
            "rate_arcsec_per_year": round(math.hypot(dx_as, dy_as) / span, 1) if span else None,
            "direction": _compass(-dx_as, -dy_as),   # image x grows west, y grows south
            "snr": round(float(min(first["snr"][i], last["snr"][j])), 1),
            "saturated": bool(first["sat"][i]),
        })

    # --- brightness: measure every source at the same spot in every stack
    # (so a source that appeared or vanished is caught too), keep the ones
    # whose brightness swings well beyond the measurement noise.
    moved_xy = [(t["x"], t["y"]) for c in changes for t in c["track"]]
    r_ap = max(1.5, 0.9 * fwhm_px)
    allx = np.concatenate([c["x"] for c in cats])
    ally = np.concatenate([c["y"] for c in cats])
    alls = np.concatenate([c["snr"] for c in cats])
    allsat = np.concatenate([c["sat"] for c in cats])
    order = np.argsort(-alls)
    seeds = []
    for i in order:
        if allsat[i] or alls[i] < 15:
            continue
        if any(math.hypot(allx[i] - x, ally[i] - y) < 2 * fwhm_px for x, y in seeds):
            continue
        if any(math.hypot(allx[i] - x, ally[i] - y) < 3 * fwhm_px for x, y in moved_xy):
            continue
        seeds.append((float(allx[i]), float(ally[i])))

    def forced(img, sigma, x, y):
        h, w = img.shape
        R = int(math.ceil(3 * fwhm_px)) + 2
        xi, yi = int(round(x)), int(round(y))
        if xi < R or yi < R or xi >= w - R or yi >= h - R:
            return None
        cut = img[yi - R:yi + R + 1, xi - R:xi + R + 1]
        gy, gx = np.mgrid[-R:R + 1, -R:R + 1]
        rr = np.hypot(gx - (x - xi), gy - (y - yi))
        ap, ann = rr <= r_ap, (rr > 2 * fwhm_px) & (rr <= R)
        if not np.all(np.isfinite(cut[ap])):
            return None
        sky = np.nanmedian(cut[ann])
        return float(np.sum(cut[ap] - sky)), sigma * math.sqrt(ap.sum()) * 1.5

    sat_xy = [(float(cats[0]["x"][k]), float(cats[0]["y"][k])) for k in np.nonzero(cats[0]["sat"])[0]]
    rough_r = int(math.ceil(6 * fwhm_px))

    def bg_change(x, y):
        """How much the background around (x, y) changes between sweeps, in
        units of the noise. Steady crowded fields stay low; nebulae, whose
        brightness depends on the wavelength mix of each stack, do not."""
        xi, yi = int(round(x)), int(round(y))
        y0, x0 = max(0, yi - rough_r), max(0, xi - rough_r)
        sms = [_smooth(s["image"][y0:yi + rough_r + 1, x0:xi + rough_r + 1], 1.5 * fwhm_px) for s in sweeps]
        gy, gx = np.mgrid[y0:y0 + sms[0].shape[0], x0:x0 + sms[0].shape[1]]
        ring = np.hypot(gx - x, gy - y) > 3 * fwhm_px      # leave out the source itself
        worst = 0.0
        for k in range(1, len(sms)):
            d = (sms[k] - sms[0])[ring]
            d = d[np.isfinite(d)]
            if d.size < 50:
                return 99.0
            q25, q75 = np.percentile(d, [25, 75])
            worst = max(worst, float((q75 - q25) / cats[0]["sigma"]))
        return worst

    def concentration(img, x, y):
        """Share of light inside the aperture versus twice its radius. Point
        sources (stars) all share one value; fuzzy blobs (ghosts, glints,
        galaxies) score lower."""
        h, w = img.shape
        R = int(math.ceil(2 * r_ap)) + 2
        xi, yi = int(round(x)), int(round(y))
        if xi < R or yi < R or xi >= w - R or yi >= h - R:
            return float("nan")
        cut = img[yi - R:yi + R + 1, xi - R:xi + R + 1]
        gy, gx = np.mgrid[-R:R + 1, -R:R + 1]
        rr = np.hypot(gx - (x - xi), gy - (y - yi))
        sky = np.nanmedian(cut[rr > 2 * r_ap])
        inner = np.nansum(cut[rr <= r_ap] - sky)
        outer = np.nansum(cut[rr <= 2 * r_ap] - sky)
        return float(inner / outer) if outer > 0 else float("nan")

    ref_img = sweeps[0]["image"]
    star_conc = [concentration(ref_img, cats[0]["x"][k], cats[0]["y"][k])
                 for k in range(len(cats[0]["x"]))
                 if not cats[0]["sat"][k] and 30 < cats[0]["snr"][k] < 3000]
    star_conc = [v for v in star_conc if v == v]
    conc_ref = float(np.median(star_conc)) if len(star_conc) >= 10 else None

    for x, y in seeds:
        others = [math.hypot(cx - x, cy - y) for cx, cy in seeds if (cx, cy) != (x, y)]
        if others and min(others) < 3 * fwhm_px:
            continue                                    # blended with a neighbour
        if any(math.hypot(sx_ - x, sy_ - y) < 45.0 / arcsec_px for sx_, sy_ in sat_xy):
            continue                                    # glare and ghosts near a very bright star
        if bg_change(x, y) > 0.6:
            continue                                    # nebula: background differs between sweeps
        m = [forced(s["image"], c["sigma"], x, y) for s, c in zip(sweeps, cats)]
        if any(v is None for v in m):
            continue
        fl = np.array([v[0] for v in m]); er = np.array([v[1] for v in m])
        hi, lo = int(np.argmax(fl)), int(np.argmin(fl))
        if fl[hi] <= 0 or fl[hi] / er[hi] < 15:
            continue
        if conc_ref is not None:
            cc = concentration(sweeps[hi]["image"], x, y)
            if not (cc == cc) or cc < 0.85 * conc_ref:
                continue                                # fuzzy, not a star: likely a ghost or glint
        floor = max(fl[lo], 3 * er[lo])               # an undetected source counts as 3 sigma
        ratio = fl[hi] / floor
        e = math.hypot(math.hypot(er[hi], 0.05 * fl[hi]), math.hypot(er[lo], 0.05 * abs(fl[lo])))
        sig = (fl[hi] - fl[lo]) / e
        if ratio < 1.3 or sig < 5:
            continue
        # SPHEREx faces the same way in sweeps a year apart and the opposite
        # way six months apart. A change seen only in the opposite-facing
        # sweep, with the same-facing ones agreeing, fits a reflection inside
        # the instrument better than a real change in the sky.
        season = False
        if len(fl) == 3:
            same = abs(fl[0] - fl[2]) < 3 * math.hypot(er[0], er[2]) + 0.1 * max(abs(fl[0]), abs(fl[2]))
            season = bool(same and (hi == 1 or lo == 1))
        if fl[lo] < 3 * er[lo]:
            kind = "appeared" if hi > lo else "vanished"
        else:
            kind = "brightened" if hi > lo else "faded"
        changes.append({
            "kind": kind, "significance": round(float(sig), 1),
            "track": [{"x": x, "y": y} for _ in sweeps], "x": x, "y": y,
            "flux": [round(float(v), 4) for v in fl],
            "ratio": round(float(ratio), 2),
            "magnitudes": round(2.5 * math.log10(ratio), 2),
            "brightest_sweep": sweeps[hi]["label"], "faintest_sweep": sweeps[lo]["label"],
            "snr": round(float(fl[hi] / er[hi]), 1), "verified": None,
            "season_pattern": season,
        })

    changes.sort(key=lambda c: -c["significance"])
    changes = changes[:max_items]
    for n, c in enumerate(changes, 1):
        c["rank"] = n
        cx = (c["x"] - (npix - 1) / 2) * arcsec_px
        cy = (c["y"] - (npix - 1) / 2) * arcsec_px
        c["offset_arcmin"] = round(math.hypot(cx, cy) / 60, 2)
        c["ra"], c["dec"] = _pix_to_sky(stacks["ra"], stacks["dec"], size, npix, c["x"], c["y"])
    return {"changes": changes, "n_sources": int(len(first["x"])), "fwhm_px": round(fwhm_px, 2)}


def _compass(east: float, north: float) -> str:
    ang = (math.degrees(math.atan2(east, north)) + 360) % 360
    names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
    return names[int((ang + 22.5) // 45) % 8]


def _pix_to_sky(ra0, dec0, size, npix, x, y):
    """Inverse of the north-up tangent grid used in imaging._sky_grid."""
    step = math.radians(size) / npix
    xi = -(x - (npix - 1) / 2) * step
    eta = -(y - (npix - 1) / 2) * step
    a0, d0 = math.radians(ra0), math.radians(dec0)
    rho = math.hypot(xi, eta)
    if rho == 0:
        return round(ra0, 5), round(dec0, 5)
    c = math.atan(rho)
    dec = math.asin(math.cos(c) * math.sin(d0) + eta * math.sin(c) * math.cos(d0) / rho)
    ra = a0 + math.atan2(xi * math.sin(c), rho * math.cos(d0) * math.cos(c) - eta * math.sin(d0) * math.sin(c))
    return round(math.degrees(ra) % 360, 5), round(math.degrees(dec), 5)


# ---------------------------------------------------------------- verification


def verify_brightness(ra: float, dec: float, workers: int = 8, exposures: list | None = None) -> dict | None:
    """Re-measure one source in every exposure and compare like with like.

    The sweep stacks mix different wavelengths, so an unusually coloured star
    can look brighter in one stack only because that stack leaned redder.
    Here each exposure is paired with an exposure from another sweep taken at
    nearly the same wavelength, and only those pairs are compared.
    Returns per-sweep relative brightness (first sweep = 1) and the pairs.
    """
    # A nearby field's exposure list can be reused: photometry() skips any
    # exposure that does not actually contain the position.
    exps = exposures if exposures is not None else sx.search(ra, dec)["exposures"]

    def phot(e):
        try:
            p = imaging.photometry(e["key"], ra, dec)
        except Exception:
            p = None
        return (e, p) if p and p["flux"] > 0 else None

    with ThreadPoolExecutor(workers) as pool:
        pts = [r for r in pool.map(phot, exps) if r]
    by_sweep: dict[int, list] = {}
    for e, p in pts:
        by_sweep.setdefault(e["epoch"], []).append((p["lam"], p["dlam"], p["flux"], p["err"]))
    sweeps = sorted(by_sweep)
    if len(sweeps) < 2:
        return None
    base = by_sweep[sweeps[0]]
    out = {"sweeps": [], "pairs": {}}
    for s in sweeps:
        ratios = []
        for lam, dlam, f, er in by_sweep[s]:
            best = min(base, key=lambda b: abs(b[0] - lam))
            if abs(best[0] - lam) <= 0.5 * min(dlam, best[1]) and best[2] > 0:
                ratios.append((lam, f / best[2]))
        if len(ratios) < 5:
            out["sweeps"].append({"epoch": s, "ratio": None, "n": len(ratios)})
            continue
        r = np.array([x[1] for x in ratios])
        med = float(np.median(r))
        # spread of the ratios gives an honest error, including colour effects
        err = float(1.4826 * np.median(np.abs(r - med)) / math.sqrt(len(r)) * 1.25)
        out["sweeps"].append({"epoch": s, "ratio": round(med, 3), "err": round(err, 3), "n": len(r)})
        out["pairs"][s] = [(round(l, 3), round(v, 3)) for l, v in ratios]
    return out


def confirm_changes(result: dict, stacks: dict, n_check: int = 6, n_comp: int = 6, log=print) -> dict:
    """Keep only brightness changes that survive a like-for-like check.

    For each candidate, compare it at matching wavelengths across sweeps and
    divide by the same measurement for nearby ordinary stars. Anything the
    comparison stars also show is a measurement effect, not the star.
    """
    exps = sx.search(stacks["ra"], stacks["dec"])["exposures"]
    sweeps = stacks["sweeps"]
    size, npix = stacks["size"], stacks["npix"]
    fwhm_px = result.get("fwhm_px", 3.0)
    cat0 = find_sources(sweeps[0]["image"], fwhm_px)
    epoch_order = [s["index"] for s in sweeps]
    kept, checked = [], 0
    for c in result["changes"]:
        if c["kind"] == "moved":
            kept.append(c)
            continue
        if c.get("season_pattern"):
            c["verified"] = False
            c["check"] = "seen only when the telescope faced the other way; could be a reflection inside the instrument"
            kept.append(c)
            continue
        if checked >= n_check:
            continue
        checked += 1
        d = np.hypot(cat0["x"] - c["x"], cat0["y"] - c["y"])
        comps = [i for i in np.argsort(d) if 4 * fwhm_px < d[i] < npix / 2 and not cat0["sat"][i]
                 and 30 < cat0["snr"][i] < 2000][:n_comp]

        def ratios(ra, dec):
            v = verify_brightness(ra, dec, exposures=exps)
            if not v:
                return None
            by = {s["epoch"]: s for s in v["sweeps"]}
            return [by.get(ep, {}).get("ratio") for ep in epoch_order], v

        got = ratios(c["ra"], c["dec"])
        comp_r = []
        for i in comps:
            ra, dec = _pix_to_sky(stacks["ra"], stacks["dec"], size, npix, cat0["x"][i], cat0["y"][i])
            r = ratios(ra, dec)
            if r and all(v is not None for v in r[0]):
                comp_r.append(r[0])
        if not got or any(v is None for v in got[0]) or len(comp_r) < 3:
            # Too faint in single exposures to check (appeared/vanished often
            # are). Keep it, clearly marked as unconfirmed.
            c["verified"] = False
            c["check"] = "too faint to re-measure in single exposures"
            kept.append(c)
            continue
        comp = np.array(comp_r)
        comp_med = np.median(comp, axis=0)
        comp_sig = np.maximum(1.4826 * np.median(np.abs(comp - comp_med), axis=0), 0.03)
        norm = np.array(got[0]) / comp_med
        hi, lo = int(np.argmax(norm)), int(np.argmin(norm))
        swing = norm[hi] / norm[lo]
        sig = (norm[hi] - norm[lo]) / math.hypot(comp_sig[hi], comp_sig[lo])
        c["relative"] = [round(float(v), 3) for v in norm]
        c["comparison_scatter"] = [round(float(v), 3) for v in comp_sig]
        c["n_comparison"] = len(comp_r)
        if swing >= 1.15 and sig >= 4:
            c["verified"] = True
            c["significance"] = round(float(sig), 1)
            c["ratio"] = round(float(swing), 2)
            c["magnitudes"] = round(2.5 * math.log10(swing), 2)
            c["brightest_sweep"] = sweeps[hi]["label"]
            c["faintest_sweep"] = sweeps[lo]["label"]
            if c["kind"] in ("brightened", "faded"):
                c["kind"] = "brightened" if hi > lo else "faded"
            kept.append(c)
            log(f"  confirmed {c['kind']} x{swing:.2f} ({sig:.1f} sigma)")
        else:
            log(f"  rejected {c['kind']}: like-for-like swing x{swing:.2f}, {sig:.1f} sigma")
    kept.sort(key=lambda c: (c["kind"] != "moved", not c.get("verified", True), -c["significance"]))
    for n, c in enumerate(kept, 1):
        c["rank"] = n
    result["changes"] = kept
    return result


def analyze_field(ra: float, dec: float, size: float = 0.25, npix: int = 300, log=print) -> tuple[dict, dict]:
    stacks = stack_sweeps(ra, dec, size, npix, log=log)
    result = find_changes(stacks)
    result = confirm_changes(result, stacks, log=log)
    return stacks, result
