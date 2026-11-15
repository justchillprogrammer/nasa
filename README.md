# Sky Blink

A public web tool for seeing how the sky changes between passes of NASA's
SPHEREx mission. Pick a spot, and it lines up the images SPHEREx took of that
spot months apart so you can flip between them. Anything that moved or changed
brightness jumps out, the same way Pluto was found with a blink comparator.

## What it does

- **Changes feed (home page).** Fourteen pre-computed targets, grouped into
  moving objects (the interstellar comet 3I/ATLAS and the asteroids Psyche,
  Eros and Vesta), stars on the move, changing brightness, and steady skies.
  Each card softly blinks between its first and last image while hovered.
- **Time machine.** A date slider over the real sweeps (smooth blends only on
  request, and labelled as not observed), motion trails, zoom, a blink mode,
  a swipe mode and a "show only what changed" mode that colours real
  differences (teal brighter, pink fainter) above the leftover every star
  leaves.
- **Change detection.** For every sweep, 30 to 40 exposures between 1 and
  2 µm are stacked into one complete image. Sources are matched between
  sweeps; stars that moved in a straight line and sources whose brightness
  changed are reported with their significance. A moving star is reported
  once, as a rate with its uncertainty and a direction in degrees
  (`backend/motion.py`).
- **Checks against false alarms.** Brightness changes are re-measured in the
  single exposures at matching wavelengths and compared with nearby stars.
  Sources near very bright stars, in nebulae, fuzzy sources, and changes that
  follow the telescope's orientation (likely reflections) are rejected or
  labelled as candidates.
- **Plain-language report.** Gemini rewrites the measurements as short text.
  It sees only the numbers, and every number it writes is checked against
  them; otherwise the site falls back to sentences built from the numbers.
- **Name search** for well-known objects, any name SIMBAD/NED knows
  (`/api/resolve`), plus coordinates.
- **Scroll story (home page)**: a full-screen sky made of real SPHEREx pixels
  that the reader's scroll drives, with passages appearing and vanishing over
  it. It turns into a glass-plate negative for the blink comparator that
  found Pluto, then scrubs through the dates as Barnard's Star moves.
  A small scroll, swipe or arrow key glides to the next scene (each flip of
  the plate, each SPHEREx pass of the star); the scrollbar is hidden and a
  thin line on the right shows progress. Nothing plays on its own
  (`web/story.js`, `web/story.css`).
- **Swipe mode**: drag a divider between the first and last image.
- **How it works** page (`how.html`) explaining what is measured and what is blended.
- **Explorer** (`explore.html`) for any position: blink, spectrum, and a
  "Find what changed" button that runs change detection live. Its
  "On the home page" list (★) holds every home-page target, read from
  `web/showcase/index.json`; comets such as 3I/ATLAS open in the time machine,
  which follows them along their path.

Every moving star is reported once, as a rate with its uncertainty and a
direction in degrees, fitted through all sweeps (`backend/motion.py`). For
the six showcase stars these agree with the Gaia proper motions in SIMBAD
within their uncertainties (for example Barnard's Star: 9.2 ± 1.2″/yr
measured, 10.4″/yr catalogued). "How it works" shows the full table, read
from the same files the site uses.

## Run it

```bash
pip install -r backend/requirements.txt
```

```bash
uvicorn app:app --app-dir backend --port 8000
```

Then open http://localhost:8000. The server needs outbound HTTPS access to
`irsa.ipac.caltech.edu` (image search) and
`nasa-irsa-spherex.s3.us-east-1.amazonaws.com` (image pixels). No account or
key is needed; the data is public.

A new position is found in 2 to 3 seconds with IRSA's image search (SIA v2),
preferring SPHEREx Data Release 1 over the quick release. Results are cached
in `.cache/`.

## Tests

```bash
pip install -r backend/requirements.txt httpx
```

```bash
python -m unittest discover -s tests -v
```

The tests run offline (no archive access) and also run on GitHub Actions
for every push (`.github/workflows/tests.yml`).

## Pre-searched presets

To make the explorer's presets open with no archive request at all, `tools/build_spots.py` searches every
preset and named object once and stores the results (gzipped, about 2 MB) in
`backend/data/search/`. `spherex.search()` reads those before asking the
archive. Re-run it after adding presets:

```bash
python tools/build_spots.py --force
```

## Rebuild the showcase

The home page reads pre-computed files in `web/showcase/`. To rebuild them
(about 2 minutes per target, needs archive access):

```bash
python tools/build_showcase.py
```

Targets are listed in `tools/targets.json`. Other modes:
`python tools/build_showcase.py barnard` rebuilds one target,
`--refresh` redoes only the text and preview pictures, and `--index-only`
rebuilds the list. Set `GEMINI_API_KEY` to have the text written by Gemini;
without it the text is built from the measurements.

The brightness-by-wavelength charts are measured from every exposure with
`python tools/build_spectra.py` (run it after rebuilding targets), and the
link-preview picture is `node tools/make_og.js`.

## How it works

| Part | File | Job |
|---|---|---|
| Archive access | `backend/spherex.py` | Searches the archive, reads image headers and pixel rows with HTTP range requests (kilobytes instead of 65 MB files), and works out the wavelength each image samples at a position |
| Image processing | `backend/imaging.py` | Resamples each image onto a shared sky grid, fills pixels the pipeline flags as defective (read from each file's compressed FLAGS layer), and measures brightness at a point |
| Motion | `backend/motion.py` | One rate with uncertainty and one direction per moving star; comparison with catalogue proper motions |
| Web server | `backend/app.py` | `/api/search`, `/api/cutout`, `/api/spectrum`, and the static page |
| Change detection | `backend/detect.py` | Stacks sweeps, finds sources, reports motion and brightness changes, and confirms them |
| Text | `backend/narrate.py` | Gemini or rule-based descriptions of the measurements, with number checking |
| Showcase build | `tools/build_showcase.py` | Pre-computes targets into `web/showcase/` |
| Pages | `web/` | `index.html` + `story.js` (scroll story) + `showcase.js` (feed and time machine), `explore.html` + `app.js` (any position) |

`backend/data/wave_tables.json` holds the mission's per-detector wavelength
lookup grids, copied from the image files.

## Deploy (Render)

`render.yaml` describes the service. In Render choose New, then Blueprint,
connect this GitHub repo, and apply. Every push to `main` redeploys
automatically. The free plan sleeps after about 15 minutes without traffic and
wipes the `.cache/` folder on each deploy, so the first visit afterwards is
slow.

## Deploy (Vercel)

`vercel.json` and `api/index.py` run the same server as a Vercel Python
function. In Vercel choose Add New, then Project, import this GitHub repo, and
deploy with the default settings. Pushes to `main` redeploy automatically.
The cache lives in `/tmp` there, so it is lost whenever the function restarts.

## Known limits of this first version

- Only the time machine follows comets and asteroids along their path; the
  Explorer stays on a fixed patch of sky.
- "Find what changed" runs at most `CHANGES_SLOTS` (default 2) jobs at once;
  further visitors are asked to try again in a minute.
- Motions below about 4 arcseconds (1.2 stacked pixels) are not detected,
  and very bright stars that saturate badly (such as 61 Cygni) cannot be
  measured.
- Very bright stars overload the detector at their centre, so their
  positions are less precise (larger uncertainties) and many of their
  exposures cannot be measured for brightness.
- Brightness measurements are quick-look values with no correction for light
  outside the measuring circle; they are not calibrated science values.
- Findings flagged by visitors are shared by opening a pre-filled GitHub
  issue; there is no account system or database.

## Data credit

SPHEREx Level 2 spectral images, NASA/JPL-Caltech, served by the NASA/IPAC
Infrared Science Archive (IRSA).
