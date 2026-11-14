"""Turn raw detector pixels into aligned sky cutouts and brightness measurements."""

from __future__ import annotations

import math

import numpy as np

import spherex as sx

PIXEL_ARCSEC = 6.15  # native SPHEREx pixel


def _sky_grid(ra0: float, dec0: float, size_deg: float, npix: int):
    """RA/Dec of every pixel of a north-up, east-left tangent-plane grid."""
    step = math.radians(size_deg) / npix
    c = (np.arange(npix) - (npix - 1) / 2) * step
    xi, eta = np.meshgrid(-c, -c)            # row 0 is north, column 0 is east
    a0, d0 = math.radians(ra0), math.radians(dec0)
    rho = np.hypot(xi, eta)
    cc = np.arctan(rho)
    cosc, sinc = np.cos(cc), np.sin(cc)
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.arcsin(cosc * math.sin(d0) + np.where(rho > 0, eta * sinc * math.cos(d0) / rho, 0.0))
        ra = a0 + np.arctan2(xi * sinc, rho * math.cos(d0) * cosc - eta * math.sin(d0) * sinc)
    return np.degrees(ra) % 360.0, np.degrees(dec)


def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Sample img at fractional (x, y); positions off the image become NaN."""
    h, w = img.shape
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    ok = (x0 >= 0) & (y0 >= 0) & (x0 < w - 1) & (y0 < h - 1)
    x0c, y0c = np.clip(x0, 0, w - 2), np.clip(y0, 0, h - 2)
    fx, fy = x - x0c, y - y0c
    out = (img[y0c, x0c] * (1 - fx) * (1 - fy) + img[y0c, x0c + 1] * fx * (1 - fy)
           + img[y0c + 1, x0c] * (1 - fx) * fy + img[y0c + 1, x0c + 1] * fx * fy)
    out = out.astype(np.float32)
    out[~ok] = np.nan
    return out


def cutout(key: str, ra: float, dec: float, size_deg: float, npix: int) -> tuple[np.ndarray, dict]:
    """A north-up patch of sky from one exposure, resampled to npix x npix.

    Every exposure is put on the same grid, so frames taken months apart line
    up pixel for pixel and can be blinked or subtracted directly.
    """
    exp = sx.load_exposure(key)
    gra, gdec = _sky_grid(ra, dec, size_deg, npix)
    x, y = exp.world_to_pixel(gra, gdec)

    y_lo = max(int(np.floor(np.nanmin(y))) - 1, 0)
    y_hi = min(int(np.ceil(np.nanmax(y))) + 1, exp.ny - 1)
    if y_hi <= y_lo or np.nanmax(x) < 0 or np.nanmin(x) > exp.nx - 1:
        img = np.full((npix, npix), np.nan, np.float32)
    else:
        rows = exp.read_rows(y_lo, y_hi)
        img = _bilinear(rows, x, y - y_lo)

    tx, ty = (float(v) for v in exp.world_to_pixel(ra, dec))
    lam, dlam = sx.wavelength_at(exp.det, tx, ty)
    meta = {
        "lam": round(lam, 4), "dlam": round(dlam, 4), "det": exp.det,
        "mjd": round(exp.mjd, 6), "x": round(tx, 1), "y": round(ty, 1),
        "coverage": round(float(np.isfinite(img).mean()), 3),
    }
    return img, meta


def photometry(key: str, ra: float, dec: float) -> dict | None:
    """Brightness of whatever sits at (ra, dec) in one exposure.

    Sums the light inside a small circle and subtracts the surrounding sky,
    measured in a ring further out. Returns flux density in millijansky.
    This is a quick-look measurement: no correction for light outside the
    circle and no masking of flagged pixels.
    """
    R_AP, R_IN, R_OUT, HALF, OVER = 2.5, 6.0, 9.0, 11, 4
    exp = sx.load_exposure(key)
    tx, ty = (float(v) for v in exp.world_to_pixel(ra, dec))
    if not (HALF <= tx < exp.nx - HALF and HALF <= ty < exp.ny - HALF):
        return None
    y0 = int(round(ty)) - HALF
    rows = exp.read_rows(y0, y0 + 2 * HALF)

    n = int(2 * R_OUT * OVER) + 1
    off = (np.arange(n) - (n - 1) / 2) / OVER
    dx, dy = np.meshgrid(off, off)
    stamp = _bilinear(rows, tx + dx, ty + dy - y0)
    r = np.hypot(dx, dy)

    ring = stamp[(r >= R_IN) & (r <= R_OUT)]
    ring = ring[np.isfinite(ring)]
    ap = stamp[r <= R_AP]
    if ring.size < 50 or not np.all(np.isfinite(ap)):
        return None
    sky = float(np.median(ring))
    sky_sigma = 1.4826 * float(np.median(np.abs(ring - sky)))

    pix_sr = (math.radians(PIXEL_ARCSEC / 3600.0)) ** 2
    to_mjy = pix_sr * 1e9 / (OVER * OVER)     # MJy/sr per fine pixel -> mJy
    flux = float(np.sum(ap - sky)) * to_mjy
    npix_native = math.pi * R_AP ** 2
    err = sky_sigma * math.sqrt(npix_native) * pix_sr * 1e9

    lam, dlam = sx.wavelength_at(exp.det, tx, ty)
    return {
        "lam": round(lam, 4), "dlam": round(dlam, 4),
        "flux": round(flux, 4), "err": round(err, 4), "sky": round(sky, 4),
        "mjd": round(exp.mjd, 6), "det": exp.det,
    }
