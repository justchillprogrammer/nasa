# Sky Blink

A public web tool for seeing how the sky changes between passes of NASA's
SPHEREx mission. Pick a spot, and it lines up the images SPHEREx took of that
spot months apart so you can flip between them. Anything that moved or changed
brightness jumps out, the same way Pluto was found with a blink comparator.

## What it does

- **Changes feed (home page).** Pre-computed showcase targets, grouped into
  stars on the move, changing brightness, and steady skies. Each card shows
  the change and a one-sentence summary.
- **Time machine.** A date slider that blends smoothly between sweeps (and
  says when you are looking at a blend rather than an observation), motion
  trails, one-click zoom onto each change, a blink mode and a "show only what
  changed" mode.
- **Change detection.** For every sweep, 30 to 40 exposures between 1 and
  2 µm are stacked into one complete image. Sources are matched between
  sweeps; stars that moved in a straight line and sources whose brightness
  changed are reported with their significance.
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
  found Pluto, then scrubs through the dates as Barnard's Star moves 9.1″.
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

Detected motions match published values for the showcase stars (for example
Barnard's Star: 9.1 arcseconds north in a year; Teegarden's Star: 5.1
arcseconds south-east).

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

The first search of a new position takes 15 to 60 seconds because the archive
query is slow. Results are cached in `.cache/`, so repeat visits are instant.

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

The first archive search for a new position takes up to a minute. To make
the explorer's presets open instantly, `tools/build_spots.py` searches every
preset and named object once and stores the results (gzipped, about 2 MB) in
`backend/data/search/`. `spherex.search()` reads those before asking the
archive. Re-run it after adding presets:

```bash
python tools/build_spots.py
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

## How it works

| Part | File | Job |
|---|---|---|
| Archive access | `backend/spherex.py` | Searches the archive, reads image headers and pixel rows with HTTP range requests (kilobytes instead of 65 MB files), and works out the wavelength each image samples at a position |
| Image processing | `backend/imaging.py` | Resamples each image onto a shared sky grid; measures brightness at a point |
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

- Only the time machine follows a comet along its path (3I/ATLAS); the
  Explorer stays on a fixed patch of sky.
- "Find what changed" runs at most `CHANGES_SLOTS` (default 2) jobs at once;
  further visitors are asked to try again in a minute.
- Motions below about 4 arcseconds (1.2 stacked pixels) are not detected,
  and very bright stars that saturate badly (such as 61 Cygni) cannot be
  measured.
- The "what changed" view subtracts pixels. SPHEREx pixels are coarse (6
  arcseconds), so ordinary stars leave small smudges; changes should be
  confirmed by blinking.
- Brightness measurements are quick-look values: no correction for light
  outside the measuring circle, and flagged pixels are not masked.

## Data credit

SPHEREx Level 2 spectral images, NASA/JPL-Caltech, served by the NASA/IPAC
Infrared Science Archive (IRSA).
