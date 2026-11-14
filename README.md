# Sky Blink

A public web tool for seeing how the sky changes between passes of NASA's
SPHEREx mission. Pick a spot, and it lines up the images SPHEREx took of that
spot months apart so you can flip between them. Anything that moved or changed
brightness jumps out, the same way Pluto was found with a blink comparator.

## What it does

- **Finds every SPHEREx image of a position** in the public NASA/IPAC archive
  and groups them into the mission's six-monthly sweeps of the sky.
- **Aligns them pixel for pixel**, north up, so they can be compared directly.
- **Blink, play, or subtract.** Flip between two dates, play all of them, or
  show only what changed.
- **Draws a spectrum of the centre point.** Each SPHEREx image sees a spot at
  a different infrared wavelength, so the measurements from all images
  together form a spectrum. Selecting a wavelength in the chart shows the sky
  in that wavelength.
- **Shareable links.** The address bar always holds the current position,
  view width and wavelength.

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

## How it works

| Part | File | Job |
|---|---|---|
| Archive access | `backend/spherex.py` | Searches the archive, reads image headers and pixel rows with HTTP range requests (kilobytes instead of 65 MB files), and works out the wavelength each image samples at a position |
| Image processing | `backend/imaging.py` | Resamples each image onto a shared sky grid; measures brightness at a point |
| Web server | `backend/app.py` | `/api/search`, `/api/cutout`, `/api/spectrum`, and the static page |
| Page | `web/` | Plain HTML, CSS and JavaScript. Receives raw brightness values and does all stretching, blinking and subtracting in the browser |

`backend/data/wave_tables.json` holds the mission's per-detector wavelength
lookup grids, copied from the image files.

## Deploy (Render)

`render.yaml` describes the service. In Render choose New, then Blueprint,
connect this GitHub repo, and apply. Every push to `main` redeploys
automatically. The free plan sleeps after about 15 minutes without traffic and
wipes the `.cache/` folder on each deploy, so the first visit afterwards is
slow.

## Known limits of this first version

- Positions are entered as coordinates or chosen from presets. There is no
  search by object name yet.
- The view stays on a fixed patch of sky. It does not yet follow a comet or
  asteroid along its path.
- The "what changed" view subtracts pixels. SPHEREx pixels are coarse (6
  arcseconds), so ordinary stars leave small smudges; changes should be
  confirmed by blinking.
- Brightness measurements are quick-look values: no correction for light
  outside the measuring circle, and flagged pixels are not masked.

## Data credit

SPHEREx Level 2 spectral images, NASA/JPL-Caltech, served by the NASA/IPAC
Infrared Science Archive (IRSA).
