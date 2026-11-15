"""Plain-language descriptions of what changed in a patch of sky.

Two writers produce the same shape of output:

* ``rule_text``   - sentences built directly from the measurements. Always
                    available, never wrong about the numbers.
* ``ai_text``     - Gemini (through its OpenAI-compatible API) rewrites the
                    same measurements in friendlier language. It is given the
                    facts only, never the images, and told not to add any.

``describe`` tries the AI and falls back to the rules.
"""

from __future__ import annotations

import json
import os
import re

import requests

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
# Google retires model names often; the first one that answers is used.
MODELS = [m.strip() for m in os.environ.get(
    "GEMINI_MODELS", "gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-flash-latest").split(",") if m.strip()]

KIND_WORDS = {
    "moved": "moved",
    "brightened": "got brighter",
    "faded": "got fainter",
    "appeared": "appeared",
    "vanished": "disappeared",
}


def facts(target: dict, sweeps: list[dict], result: dict) -> dict:
    """The compact, numbers-only description handed to either writer."""
    items = []
    for c in result["changes"]:
        f = {"rank": c["rank"], "kind": c["kind"], "significance_sigma": c["significance"],
             "distance_from_centre_arcmin": c.get("offset_arcmin"),
             "is_the_target_itself": (c.get("offset_arcmin") or 99) < 0.5,
             "status": ("measured" if c["kind"] == "moved" else
                        "confirmed" if c.get("verified") else "candidate")}
        if c["kind"] == "moved":
            # One number for the motion: the rate, with its uncertainty.
            rate = c["rate_arcsec_per_year"]
            moon = round(1865 / rate) if rate else None
            f.update(rate_arcsec_per_year=rate, rate_uncertainty=c.get("rate_err_arcsec_per_year"),
                     direction=c["direction"], saturated_star=c.get("saturated", False),
                     yearly_shift_as_fraction_of_full_moon_width=f"1/{moon}" if moon else None)
            if c.get("catalogue"):
                f.update(catalogue_rate_arcsec_per_year=c["catalogue"]["rate_arcsec_per_year"],
                         matches_catalogue=c["catalogue"]["agrees"])
        else:
            f.update(brightness_ratio=c["ratio"], magnitudes=c["magnitudes"],
                     brightest_in=c["brightest_sweep"], faintest_in=c["faintest_sweep"],
                     confirmed_like_for_like=c.get("verified"),
                     caution=c.get("check"))
        items.append(f)
    return {
        "target": target.get("name"),
        "target_note": target.get("note", ""),
        "sweeps": [{"label": s["label"], "exposures_stacked": s["n"]} for s in sweeps],
        "sources_measured": result.get("n_sources"),
        "changes": items,
    }


def _span(f: dict) -> str:
    labels = [s["label"] for s in f["sweeps"]]
    return f"{labels[0]} and {labels[-1]}" if len(labels) > 1 else labels[0]


def rule_text(f: dict) -> dict:
    out = []
    for c in f["changes"]:
        where = ("at the centre" if (c.get("distance_from_centre_arcmin") or 0) < 0.5
                 else f"{c['distance_from_centre_arcmin']:.1f} arcminutes from the centre")
        if c["kind"] == "moved":
            err = f" ± {c['rate_uncertainty']}" if c.get("rate_uncertainty") else ""
            t = (f"A star {where} is moving {c['rate_arcsec_per_year']}{err} arcseconds a year "
                 f"toward the {c['direction']}, measured between {_span(f)}.")
            if c.get("catalogue_rate_arcsec_per_year"):
                t += (f" Star catalogues give {c['catalogue_rate_arcsec_per_year']} arcseconds a year"
                      + (", which agrees." if c.get("matches_catalogue") else ", which does not agree."))
        else:
            t = (f"A source {where} {KIND_WORDS[c['kind']]}: it was {c['brightness_ratio']} times brighter "
                 f"in {c['brightest_in']} than in {c['faintest_in']}.")
            if c.get("caution") and "reflection" in c["caution"]:
                t += " It was seen only when the telescope faced the other way, so it may be a reflection inside the instrument."
            elif c.get("confirmed_like_for_like") is False:
                t += " This could not yet be double-checked in single images, so treat it as a candidate."
        out.append({"rank": c["rank"], "text": t})
    n = len(f["changes"])
    if n == 0:
        summary = (f"Nothing measurable changed here between {_span(f)}. "
                   f"{f['sources_measured']} sources were compared across the sweeps.")
    else:
        counts = {}
        for c in f["changes"]:
            counts[KIND_WORDS[c["kind"]]] = counts.get(KIND_WORDS[c["kind"]], 0) + 1
        summary = (f"Sky Blink compared {f['sources_measured']} sources in images from {_span(f)}. "
                   f"{'One source' if n == 1 else str(n) + ' sources'} changed: "
                   + ", ".join(f"{v} {k}" for k, v in counts.items()) + ".")
    return {"summary": summary, "items": out, "writer": "rules"}


PROMPT = """You write short captions for a public website that shows how the sky
changed between images from NASA's SPHEREx space telescope. Readers are
curious members of the public, not astronomers.

Use only the facts in the JSON below. Do not name objects, guess what they
are, or add numbers that are not given, except the target name. Never do
arithmetic or unit conversions: copy numbers exactly as given. Give a
star's motion only as rate_arcsec_per_year with its rate_uncertainty
(for example "9.2 ± 1.2 arcseconds a year"), never as a total shift. To make
a tiny angle feel real, use yearly_shift_as_fraction_of_full_moon_width if
present. If catalogue_rate_arcsec_per_year is given, say whether the
measurement matches it (matches_catalogue).
Only say the target itself changed when is_the_target_itself is true;
otherwise call it "another star in the view" or "a source in the view".
A change with status "candidate" is only possible: never present it as a
discovery, and say it still needs checking; if it has a caution, give it in
plain words. Lead the summary with measured or confirmed changes; mention
candidates after them, briefly. Never write "like-for-like" or
"significance". Only a brightness change with status "confirmed" may be
described as "double-checked against nearby stars at matching colours";
never say that about a star that moved. Do not exaggerate the target note. Prefer plain
words. No exclamation marks.

Return JSON with this shape:
{"summary": "2 sentences. The first says plainly what was found here, with
             its key number (or that nothing measurable changed). The second
             gives context from the target note. Do not start with 'These
             images' or 'This image'.",
 "items": [{"rank": <rank from the facts>, "text": "one sentence"}]}
Include one item for every change in the facts, in the same order.

Facts:
"""


_NUM = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)*(?:/\d+)?")


def _numbers_ok(out: dict, f: dict) -> bool:
    """Every number the AI wrote must appear somewhere in the facts."""
    allowed = set(_NUM.findall(json.dumps(f)))
    allowed |= {"1", "2", "3"}          # "one of two", "2 sweeps" and the like
    text = out.get("summary", "") + " " + " ".join(str(i.get("text", "")) for i in out.get("items", []))
    for n in _NUM.findall(text):
        if n.replace(",", "") not in allowed and n not in allowed:
            return False
    return True


def ai_text(f: dict, timeout: float = 30) -> dict | None:
    """Ask Gemini for friendlier wording. None if no key or no answer."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return None
    body_base = {
        "messages": [{"role": "user", "content": PROMPT + json.dumps(f)}],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
    }
    for model in MODELS:
        try:
            r = requests.post(GEMINI_URL, json={**body_base, "model": model},
                              headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
            data = r.json()
            if isinstance(data, list):
                data = data[0] if data else {}
            if "choices" not in data:
                continue
            text = data["choices"][0]["message"]["content"].strip()
            if text.startswith("```"):
                text = text.strip("`").split("\n", 1)[1] if "\n" in text else text
            out = json.loads(text)
            if not isinstance(out.get("summary"), str):
                continue
            if not _numbers_ok(out, f):
                continue  # a number that is not in the facts: do not trust it
            ranks = {c["rank"] for c in f["changes"]}
            items = [i for i in out.get("items", []) if isinstance(i, dict) and i.get("rank") in ranks]
            if len(items) != len(ranks):
                continue  # the model skipped or invented an item: do not trust it
            return {"summary": out["summary"], "items": items, "writer": f"AI ({model})"}
        except Exception:
            continue
    return None


def describe(target: dict, sweeps: list[dict], result: dict) -> dict:
    f = facts(target, sweeps, result)
    return ai_text(f) or rule_text(f)


TRACK_PROMPT = """You write short captions for a public website that follows a
comet or asteroid through images from NASA's SPHEREx space telescope.
Readers are curious members of the public, not astronomers.

Use only the facts in the JSON below. Never do arithmetic or unit
conversions: copy numbers exactly as given. Do not exaggerate the target
note. Distances describe when the images were taken: write "was about ...",
never "is" or "currently". Explain that stacking all the images on the object makes the stars
smear away while the object adds up. If visible_when_stacked is false, say
it stays too faint even when stacked and the circle shows where its orbit
puts it.
Prefer plain words. No exclamation marks.

Return JSON: {"summary": "2 or 3 sentences. The first says what the viewer
is watching (how many real images, over which dates); then the stacking
point; then context from the target note or the distance."}

Facts:
"""


def describe_track(target: dict, f: dict) -> dict:
    """Text for a followed comet or asteroid."""
    key = os.environ.get("GEMINI_API_KEY")
    facts = {"target": target.get("name"), "target_note": target.get("note", ""), **f}
    if key:
        for model in MODELS:
            try:
                r = requests.post(GEMINI_URL, json={
                    "model": model, "temperature": 0.3, "response_format": {"type": "json_object"},
                    "messages": [{"role": "user", "content": TRACK_PROMPT + json.dumps(facts)}],
                }, headers={"Authorization": f"Bearer {key}"}, timeout=30)
                data = r.json()
                if isinstance(data, list):
                    data = data[0] if data else {}
                if "choices" not in data:
                    continue
                text = data["choices"][0]["message"]["content"].strip().strip("`")
                if text.startswith("json"):
                    text = text[4:]
                out = json.loads(text)
                if isinstance(out.get("summary"), str) and _numbers_ok({"summary": out["summary"], "items": []}, facts):
                    return {"summary": out["summary"], "items": [], "writer": f"AI ({model})"}
            except Exception:
                continue
    s = (f"SPHEREx caught {target.get('name')} in {f['n_images']} images between {f['first_date']} "
         f"and {f['last_date']}; the view follows it, so the stars stream past.")
    if f.get("distance_million_km"):
        s += f" It was about {f['distance_million_km']} million km from Earth."
    if f.get("visible_when_stacked"):
        s += " Stacking all the images on it smears the stars away and makes it stand out."
    else:
        s += " It stays faint even when the images are stacked; the circle shows where its orbit puts it."
    return {"summary": s, "items": [], "writer": "rules"}
