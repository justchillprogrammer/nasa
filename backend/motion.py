"""One description of a star's motion, used everywhere on the site.

A moving star is reported as a single rate with its uncertainty and a
direction (position angle, degrees east of north) with its uncertainty,
fitted through its position in every sweep. Earlier versions quoted the
end-to-end shift, a rate and a "shift in N years" side by side, which read
as three different numbers.
"""

from __future__ import annotations

import math

# 16 points, so a direction near a boundary (160 degrees) reads as
# "south-south-east" rather than flipping between "south" and "south-east".
COMPASS = ["north", "north-north-east", "north-east", "east-north-east", "east", "east-south-east",
           "south-east", "south-south-east", "south", "south-south-west", "south-west", "west-south-west",
           "west", "west-north-west", "north-west", "north-north-west"]


def compass(pa_deg: float) -> str:
    return COMPASS[int(((pa_deg % 360) + 11.25) // 22.5) % 16]


def fit(track: list[dict], mjds: list[float], arcsec_px: float,
        shift_arcsec: float, significance: float) -> dict:
    """Rate and direction from the star's pixel position in each sweep.

    Image x grows west and y grows south (north up, east left). The
    uncertainty comes from the detection itself: the end-to-end shift was
    found at `significance` times its positional error.
    """
    years = [(m - mjds[0]) / 365.25 for m in mjds]
    east = [-(p["x"] - track[0]["x"]) * arcsec_px for p in track]
    north = [-(p["y"] - track[0]["y"]) * arcsec_px for p in track]
    tb = sum(years) / len(years)
    var = sum((t - tb) ** 2 for t in years) or 1e-9
    ve = sum((t - tb) * (e - sum(east) / len(east)) for t, e in zip(years, east)) / var
    vn = sum((t - tb) * (n - sum(north) / len(north)) for t, n in zip(years, north)) / var
    rate = math.hypot(ve, vn)
    pa = (math.degrees(math.atan2(ve, vn)) + 360) % 360
    span = years[-1] - years[0] or 1e-9
    pos_err = shift_arcsec / significance if significance else shift_arcsec
    rate_err = pos_err / span
    pa_err = math.degrees(math.atan2(pos_err, max(shift_arcsec, 1e-9)))
    return {
        "rate_arcsec_per_year": round(rate, 1),
        "rate_err_arcsec_per_year": round(rate_err, 1),
        "pa_deg": round(pa),
        "pa_err_deg": round(pa_err),
        "direction": compass(pa),
        "years": round(span, 2),
    }


def compare(m: dict, pm_ra_mas: float, pm_dec_mas: float, source: str) -> dict:
    """How a measured motion compares with a catalogue proper motion."""
    rate = math.hypot(pm_ra_mas, pm_dec_mas) / 1000.0
    pa = (math.degrees(math.atan2(pm_ra_mas, pm_dec_mas)) + 360) % 360
    n_rate = abs(m["rate_arcsec_per_year"] - rate) / max(m["rate_err_arcsec_per_year"], 0.05)
    dpa = abs((m["pa_deg"] - pa + 180) % 360 - 180)
    n_pa = dpa / max(m["pa_err_deg"], 1)
    worst = max(n_rate, n_pa)
    return {
        "rate_arcsec_per_year": round(rate, 2), "pa_deg": round(pa), "source": source,
        "rate_sigma": round(n_rate, 1), "pa_sigma": round(n_pa, 1),
        "agrees": worst <= 3.0,
        "verdict": ("agrees within its uncertainty" if worst <= 2.0 else
                    "agrees within 3 times its uncertainty" if worst <= 3.0 else
                    "does not agree"),
    }
