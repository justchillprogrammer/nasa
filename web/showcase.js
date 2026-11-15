"use strict";

/* Sky Blink home: a feed of pre-computed changes, and a time machine for
   each target. Everything here reads static files from /showcase, so it is
   instant and works on any static host. */

const KIND = {
  moved:      { label: "moved",           color: "#ffb347", noun: "Moved" },
  brightened: { label: "got brighter",    color: "#62d2c3", noun: "Brightened" },
  faded:      { label: "got fainter",     color: "#f2849e", noun: "Faded" },
  appeared:   { label: "appeared",        color: "#62d2c3", noun: "Appeared" },
  vanished:   { label: "disappeared",     color: "#f2849e", noun: "Disappeared" },
  tracked:    { label: "images followed", color: "#a9b8ff", noun: "Followed" },
};
const TRACK_STEP_MS = 420;    // follow mode: time per real exposure
const HOLD_MS = 900;          // pause on each real sweep while playing
const TRAVEL_MS = 2200;       // time to travel from one sweep to the next
const NODATA = [58, 42, 85];

const $ = (id) => document.getElementById(id);
const el = {
  feedView: $("feed-view"), targetView: $("target-view"), feed: $("feed"), status: $("status"),
  search: $("search"), q: $("q"), suggest: $("suggest"),
  name: $("t-name"), note: $("t-note"), view: $("view"), tag: $("tag"), zoomTag: $("zoom-tag"),
  empty: $("t-empty"), play: $("play"), time: $("time"), ticks: $("ticks"), when: $("when"),
  marks: $("marks"), stretch: $("stretch"), modeHelp: $("mode-help"),
  summary: $("summary"), writer: $("writer"), changes: $("changes"), zoomOut: $("zoom-out"),
  tourbar: $("tourbar"), tourStep: $("tour-step"), tourText: $("tour-text"),
  tourPause: $("tour-pause"), tourNext: $("tour-next"), tourEnd: $("tour-end"), tourStart: $("tour-start"),
  shareLink: $("share-link"), savePicture: $("save-picture"), saveVideo: $("save-video"), shareMsg: $("share-msg"),
  // New UI controls
  blendToggle: $("blend-toggle"),
  flagBtn: $("flag-btn"), flagModal: $("flag-modal"),
  flagTarget: $("flag-target"), flagRaDec: $("flag-ra-dec"), flagObsDate: $("flag-obs-date"),
  flagMatchAlert: $("flag-match-alert"), flagType: $("flag-type"), flagNotes: $("flag-notes"),
  flagSave: $("flag-save"), flagCancel: $("flag-cancel"),
  reviewBtn: $("review-candidates-btn"), reviewCount: $("review-count"),
  reviewModal: $("review-modal"), reviewClose: $("review-close"),
  reviewVoteReal: $("review-vote-real"), reviewVoteArtifact: $("review-vote-artifact"), reviewVoteUnsure: $("review-vote-unsure"),
  reviewCvsBefore: $("review-cvs-before"), reviewCvsAfter: $("review-cvs-after"),
  reviewLblBefore: $("review-lbl-before"), reviewLblAfter: $("review-lbl-after"), reviewMeta: $("review-meta"),
  openFindings: $("open-findings"), findingsCount: $("findings-count"),
  findingsModal: $("findings-modal"), findingsList: $("findings-list"),
  findingsCloseX: $("findings-close-x"), findingsDone: $("findings-done"),
  exportCsv: $("export-csv"), exportJson: $("export-json"), clearFindings: $("clear-findings"),
  spectrumCard: $("spectrum-card"), targetSpectrumView: $("target-spectrum-view"), spectrumCaption: $("spectrum-caption"),
};
const vctx = el.view.getContext("2d");

// SPHEREx detector wavelength ranges (µm), used to label the spectrum chart.
const DETECTORS = [
  { id: 1, lam0: 0.75, lam1: 1.11, color: "#7088ff" },
  { id: 2, lam0: 1.11, lam1: 1.64, color: "#4ee2ec" },
  { id: 3, lam0: 1.64, lam1: 2.42, color: "#6fe870" },
  { id: 4, lam0: 2.42, lam1: 3.82, color: "#ffbe40" },
  { id: 5, lam0: 3.82, lam1: 4.42, color: "#ff6250" },
  { id: 6, lam0: 4.42, lam1: 5.00, color: "#ff255b" },
];

const S = {
  swipe: 0.3,
  index: [], names: [],
  meta: null, frames: [], canvases: [], white: 1, sigma: 1,
  mode: "fade", t: 0,            // t: 0..1 along the time axis
  playing: false, raf: 0, last: 0, holdUntil: 0,
  blinkOn: false, blinkTimer: 0,
  zoom: null,                    // {cx, cy, scale}
  selected: null,
  loadToken: 0,
  blendMode: "steps",          // real images only, unless the viewer asks for blends
  flagArmed: false,
  flagPending: null,
  findings: [],
  reviewQueue: [],
  reviewIdx: 0,
};

/* ---------------------------------------------------------- small helpers */

function setStatus(msg, error = false) {
  el.status.textContent = msg || "";
  el.status.className = "status" + (error ? " error" : "");
}

function mjdToDate(mjd) {
  return new Date(Date.UTC(1858, 10, 17) + mjd * 86400000);
}
const fmtDay = (mjd) => mjdToDate(mjd).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// float16 -> float32 lookup table, built once
const F16 = (() => {
  const t = new Float32Array(65536);
  for (let u = 0; u < 65536; u++) {
    const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff;
    t[u] = e === 0 ? s * Math.pow(2, -14) * (f / 1024)
      : e === 31 ? (f ? NaN : s * Infinity)
      : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return t;
})();

function decodeF16(buf) {
  const u = new Uint16Array(buf), out = new Float32Array(u.length);
  for (let i = 0; i < u.length; i++) out[i] = F16[u[i]];
  return out;
}

function quantile(arr, p) {
  const s = [];
  const step = Math.max(1, Math.floor(arr.length / 30000));
  for (let i = 0; i < arr.length; i += step) if (arr[i] === arr[i]) s.push(arr[i]);
  s.sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}

function icon(kind) {
  const c = KIND[kind].color;
  const shapes = {
    moved: `<circle cx="9" cy="15" r="4" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="2 2"/><circle cx="22" cy="15" r="4.5" fill="${c}"/><path d="M13 15h5" stroke="${c}" stroke-width="2"/>`,
    brightened: `<circle cx="15" cy="15" r="5" fill="${c}"/><path d="M15 3v4M15 23v4M3 15h4M23 15h4M6.5 6.5l2.8 2.8M20.7 20.7l2.8 2.8M6.5 23.5l2.8-2.8M20.7 9.3l2.8-2.8" stroke="${c}" stroke-width="2"/>`,
    faded: `<circle cx="15" cy="15" r="9" fill="none" stroke="${c}" stroke-width="2"/><circle cx="15" cy="15" r="3.5" fill="${c}"/>`,
    appeared: `<circle cx="15" cy="15" r="9" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="3 3"/><path d="M15 10v10M10 15h10" stroke="${c}" stroke-width="2.4"/>`,
    vanished: `<circle cx="15" cy="15" r="9" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="3 3"/><path d="M10 15h10" stroke="${c}" stroke-width="2.4"/>`,
  };
  return `<svg viewBox="0 0 30 30" aria-hidden="true">${shapes[kind] || ""}</svg>`;
}

// Plain-language explanations of the jargon, shown on hover or focus.
const TERMS = {
  sigma: "σ (sigma) says how far a change stands above the measurement noise. At 5σ or more, noise alone would almost never produce it.",
  arcsec: "An arcsecond (″) is a tiny angle: 1/3600 of a degree. The full Moon is about 1,865 arcseconds wide.",
  pa: "Direction on the sky in degrees: 0° is north, 90° east, 180° south, 270° west.",
  mjy: "mJy (millijansky) is a unit of brightness used in radio and infrared astronomy. Bigger means brighter.",
  saturated: "Saturated: the star is so bright that the centre of its image overloads the detector, so those pixels hold no measurement.",
  au: "au (astronomical unit) is the Earth-Sun distance, about 150 million km.",
  catalogue: "The star's motion as published from the Gaia space telescope, looked up in the SIMBAD database.",
};
function term(text, key) {
  return `<span class="term" tabindex="0" data-tip="${TERMS[key].replace(/"/g, "&quot;")}">${text}</span>`;
}

function sureness(c) {
  // σ above 5 is near-certain by any standard; wording follows that.
  if (c.kind === "moved") return c.significance >= 5 ? ["Near-certain", "high"] : c.significance >= 3 ? ["Likely", "mid"] : ["Candidate", "low"];
  if (c.verified === true) return c.significance >= 5 ? ["Near-certain, confirmed", "high"] : ["Confirmed", "mid"];
  if (c.season_pattern) return ["Candidate, may be an instrument reflection", "low"];
  if (c.verified === false) return ["Candidate, not yet confirmed", "low"];
  return ["Candidate", "low"];
}

// One number per measurement: a moving star's rate with its uncertainty.
const f1 = (v) => Number(v).toFixed(1);

function changeNumbers(c) {
  if (c.kind === "moved") {
    if (c.rate_err_arcsec_per_year == null) return `${f1(c.rate_arcsec_per_year)}${term("″", "arcsec")} per year toward the ${c.direction}`;
    return `${f1(c.rate_arcsec_per_year)} ± ${f1(c.rate_err_arcsec_per_year)}${term("″", "arcsec")} per year toward the ${c.direction} `
      + `(${term(`${c.pa_deg}° ± ${c.pa_err_deg}°`, "pa")})`;
  }
  return `${c.ratio}× brighter in ${c.brightest_sweep} than in ${c.faintest_sweep}`;
}

function catalogueLine(c) {
  const k = c.catalogue;
  if (!k) return "";
  return `<p class="c-check ${k.agrees ? "ok" : "bad"}">${term("Catalogue", "catalogue")}: ${f1(k.rate_arcsec_per_year)}″ per year toward ${k.pa_deg}°. `
    + `Our measurement ${k.verdict} (speed ${k.rate_sigma}σ, direction ${k.pa_sigma}σ apart).</p>`;
}

/* ---------------------------------------------------------- feed */

async function loadIndex() {
  try {
    const [idx, names] = await Promise.all([
      fetch("showcase/index.json").then((r) => r.json()),
      fetch("names.json").then((r) => r.json()).catch(() => ({ objects: [] })),
    ]);
    S.index = idx.targets;
    S.names = names.objects;
  } catch (e) {
    setStatus("The list of changes could not be loaded. Reload the page to try again.", true);
  }
}

function renderFeed() {
  el.feed.replaceChildren();
  const groups = [];
  for (const t of S.index) {   // every target, all measured from real images
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push(g = { name: t.group, items: [] });
    g.items.push(t);
  }
  const blurbs = {
    "Moving objects": "Comets and asteroids cross the sky in hours. Sky Blink asks NASA's orbit service where each one was, finds every SPHEREx image that caught it, and follows it.",
    "Stars on the move": "Nearby stars drift across the sky year by year. SPHEREx images taken a year apart are enough to catch them moving.",
    "Changing brightness": "Some stars swell and shrink, or flicker. Sky Blink compares each star with its neighbours to catch real changes.",
    "Steady skies": "Places where Sky Blink found nothing measurable. Knowing what did not change matters as much as what did.",
  };
  for (const g of groups) {
    const sec = document.createElement("section");
    sec.className = "group";
    sec.innerHTML = `<div class="group-head"><h2>${g.name}</h2>`
      + `<a class="group-more" href="explore.html?homecat=${encodeURIComponent(g.name)}">Find more in the Explorer</a></div>`
      + (blurbs[g.name] ? `<p>${blurbs[g.name]}</p>` : "");
    const grid = document.createElement("div");
    grid.className = "cards" + (g.items.length === 1 ? " single" : "");
    for (const t of g.items) grid.append(card(t));
    sec.append(grid);
    el.feed.append(sec);
  }
}

// Badge wording: whole phrases, not "1 moved".
function badgeText(kind, n) {
  const one = n === 1;
  return {
    moved: one ? "1 star moved" : `${n} stars moved`,
    brightened: one ? "1 star got brighter" : `${n} stars got brighter`,
    faded: one ? "1 star got fainter" : `${n} stars got fainter`,
    appeared: one ? "1 new source" : `${n} new sources`,
    vanished: one ? "1 source disappeared" : `${n} sources disappeared`,
    tracked: `Followed in ${n} images`,
  }[kind] || `${n} ${KIND[kind].label}`;
}

function card(t) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "card";
  // A still picture; on hover or focus it fades slowly to the last image, so
  // the change shows without anything flashing on the page.
  const thumbs = t.thumbs || [];
  const first = thumbs[0], last = thumbs.length > 1 ? thumbs[thumbs.length - 1] : null;
  const alt = (lbl) => `${t.name}: SPHEREx image, ${lbl}`;
  const pics = (first ? `<img src="showcase/${first}" alt="${alt(t.labels[0])}" loading="lazy">` : "")
    + (last ? `<img class="later" src="showcase/${last}" alt="${alt(t.labels[t.labels.length - 1])}" loading="lazy">` : "");
  let badges = Object.entries(t.kinds || {}).map(([k, v]) =>
    `<span class="badge"><i style="background:${KIND[k].color}"></i>${badgeText(k, v)}</span>`).join("");
  if (t.candidates) badges += `<span class="badge quiet">${t.candidates} unconfirmed candidate${t.candidates > 1 ? "s" : ""}</span>`;
  if (!badges) badges = `<span class="badge quiet">Nothing changed</span>`;
  b.innerHTML = `<div class="card-pics${last ? " has-later" : ""}">${pics}<span class="card-date">${t.labels[0]} to ${t.labels[t.labels.length - 1]}</span></div>
    <div class="card-body"><h3>${t.name}</h3><div class="badges">${badges}</div><p>${t.summary}</p></div>`;
  b.setAttribute("aria-label", `${t.name}. ${t.summary} Open the time machine.`);
  b.addEventListener("click", () => { location.hash = `#/${t.slug}`; });
  return b;
}

/* ---------------------------------------------------------- target */

async function openTarget(slug, opts = {}) {
  const token = ++S.loadToken;
  stop();
  S.meta = null; S.frames = []; S.canvases = []; S.zoom = null; S.selected = null; S.t = 0;
  el.feedView.hidden = true;
  el.targetView.hidden = false;
  el.empty.hidden = false;
  el.empty.textContent = "Loading images…";
  el.changes.replaceChildren();
  el.summary.textContent = "";
  el.writer.textContent = "";
  vctx.clearRect(0, 0, el.view.width, el.view.height);
  window.scrollTo(0, 0);

  let meta;
  try {
    meta = await fetch(`showcase/${slug}/meta.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  } catch (e) {
    el.empty.textContent = "This target could not be loaded.";
    setStatus("That target was not found. Go back to all changes and pick another.", true);
    return;
  }
  if (token !== S.loadToken) return;
  S.track = meta.type === "track";
  if (S.track) {
    meta.sweeps = meta.frames.map((f) => ({ ...f, label: fmtDay(f.mjd), n: 1, mjd0: f.mjd, mjd1: f.mjd }));
    meta.changes = [];
  }
  S.meta = meta;
  document.querySelector(".report h2").textContent = S.track ? "What you are seeing" : "What changed here";
  el.marks.parentElement.lastChild.textContent = S.track ? " Mark the object" : " Mark changes";
  document.querySelector('input[value="fade"]').parentElement.lastChild.textContent = S.track ? " Follow it" : " Time machine";
  document.title = `${meta.name}: Sky Blink`;
  el.name.textContent = meta.name;
  el.note.textContent = meta.note;
  buildTicks();
  buildReport();

  document.getElementById("mode-stack").hidden = !S.track;
  document.getElementById("mode-diff").hidden = S.track;
  if (!S.track && S.mode === "stack") setMode("fade");
  if (S.track && S.mode === "diff") setMode("fade");
  const files = meta.sweeps.map((s) => s.frame).concat(S.track && meta.stack ? [meta.stack] : []);
  const bufs = await Promise.all(files.map((f) =>
    fetch(`showcase/${slug}/${f}`).then((r) => r.arrayBuffer())));
  if (token !== S.loadToken) return;
  S.frames = bufs.slice(0, meta.sweeps.length).map(decodeF16);
  S.stackFrame = S.track && meta.stack ? decodeF16(bufs[bufs.length - 1]) : null;
  const first = S.frames[0];
  const med = quantile(first, 0.5);
  S.sigma = Math.max(med - quantile(first, 0.16), 1e-4);
  const whites = S.frames.map((f) => quantile(f, 0.997) - med).sort((a, b) => a - b);
  S.white = Math.max(whites[Math.floor(whites.length / 2)], 10 * S.sigma);
  S.floor = med - 1.5 * S.sigma;
  renderSweepCanvases();
  renderTargetSpectrum();
  updateCandidateReviewButton();
  el.empty.hidden = true;
  setStatus("");
  draw();
  if (S.tour) { tourStop(); return; }
  el.tourbar.hidden = true;
  if (opts.mode && opts.mode !== S.mode) setMode(opts.mode);
  // a shared link to a still view (stack, swipe) opens on that view, not playing
  if (opts.mode === "stack" || opts.mode === "swipe") { draw(); return; }
  const pick = opts.change && S.meta.changes.find((c) => c.rank === +opts.change);
  if (pick) { focusChange(pick); return; }
  // Open magnified on the main change: a moving star shifts only a few
  // pixels, too little to see in the whole view.
  const top = !S.track && S.meta.changes.find((c) => c.kind === "moved" || c.verified);
  if (top) { focusChange(top); return; }
  play();          // start the journey straight away
}

// Is this empty pixel the centre of a saturated star? Look for bright
// starlight within a few pixels.
function saturatedHole(d, n, i, bright) {
  const x0 = i % n, y0 = (i / n) | 0;
  for (let r = 1; r <= 4; r++) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const v = d[y * n + x];
      if (v === v) return v > 0.25 * bright;
    }
  }
  return false;
}

function renderSweepCanvases() {
  const n = S.meta.npix;
  const k = Math.pow(10, (+el.stretch.value - 50) / 25);
  const soft = 8 * k, norm = Math.asinh(soft);
  const all = S.stackFrame ? S.frames.concat([S.stackFrame]) : S.frames;

  const canv = all.map((d, idx) => {
    const isStack = S.stackFrame && idx === all.length - 1;
    const white = isStack ? Math.max(quantile(d, 0.999), 20) : S.white;
    const floor = isStack ? -1.5 : S.floor;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const cx = c.getContext("2d");
    const img = cx.createImageData(n, n), px = img.data;
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      const v = d[i];
      // No data: a saturated star centre (bright all around) is drawn white,
      // as a camera would; anything else (off the detector) as dark "no data".
      if (v !== v) {
        const sat = saturatedHole(d, n, i, white + floor);
        px[j] = sat ? 255 : 30; px[j + 1] = sat ? 255 : 34; px[j + 2] = sat ? 255 : 52; px[j + 3] = 255;
        continue;
      }

      let s = Math.asinh(soft * (v - floor) / white) / norm;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      px[j] = 255 * s;
      px[j + 1] = 255 * Math.pow(s, 1.08);
      px[j + 2] = 255 * Math.pow(s, 1.22);
      px[j + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    return c;
  });
  S.stackCanvas = S.stackFrame ? canv.pop() : null;
  S.canvases = canv;
}

/* time axis: real dates, so the gap between sweeps is shown truthfully */
function axis() {
  const sw = S.meta.sweeps;
  return { t0: sw[0].mjd, t1: sw[sw.length - 1].mjd };
}
function mjdAt(t) {
  if (S.track) { const { k, w } = segment(t), sw = S.meta.sweeps; return sw[k].mjd + w * ((sw[k + 1] || sw[k]).mjd - sw[k].mjd); }
  const a = axis(); return a.t0 + t * (a.t1 - a.t0);
}
function tOf(mjd) {
  if (S.track) { const sw = S.meta.sweeps; const i = sw.findIndex((s) => s.mjd >= mjd - 1e-9); return (i < 0 ? sw.length - 1 : i) / Math.max(1, sw.length - 1); }
  const a = axis(); return a.t1 > a.t0 ? (mjd - a.t0) / (a.t1 - a.t0) : 0;
}

function segment(t) {
  if (S.track) {   // follow mode: evenly spaced real exposures
    const n = S.meta.sweeps.length, f = Math.min(Math.max(t, 0), 1) * (n - 1);
    if (S.blendMode === "steps") return { k: Math.min(n - 1, Math.round(f)), w: 0 };
    const k = Math.min(n - 2, Math.floor(f));
    return { k: Math.max(0, k), w: n > 1 ? f - Math.max(0, k) : 0 };
  }
  const sw = S.meta.sweeps;
  if (S.blendMode === "steps") {
    const k = Math.min(sw.length - 1, Math.max(0, Math.round(t * (sw.length - 1))));
    return { k, w: 0 };
  }
  const mjd = mjdAt(t);
  for (let k = 0; k < sw.length - 1; k++) {
    if (mjd <= sw[k + 1].mjd + 1e-6) {
      const w = (mjd - sw[k].mjd) / (sw[k + 1].mjd - sw[k].mjd);
      return { k, w: Math.min(1, Math.max(0, w)) };
    }
  }
  return { k: Math.max(0, sw.length - 2), w: 1 };
}

function buildTicks() {
  el.ticks.replaceChildren();
  const minSpacing = 0.22; // Wider date-label spacing so dates never collide
  if (S.track) {
    // One tick per visit, plus the very last image, so the axis ends on the
    // real last date. Labels that would overlap are dropped, never the ends.
    const sw = S.meta.sweeps, n = sw.length;
    const ticks = [];
    sw.forEach((s, i) => { if (!i || s.mjd - sw[i - 1].mjd >= 3) ticks.push(i); });
    if (ticks[ticks.length - 1] !== n - 1) ticks.push(n - 1);
    const pos = (i) => i / Math.max(1, n - 1);
    const keep = [ticks[0]];
    for (const i of ticks.slice(1, -1)) {
      if (pos(i) - pos(keep[keep.length - 1]) >= minSpacing && pos(ticks[ticks.length - 1]) - pos(i) >= minSpacing) keep.push(i);
    }
    if (ticks.length > 1) keep.push(ticks[ticks.length - 1]);
    for (const i of keep) {
      const span = document.createElement("span");
      span.style.left = `${pos(i) * 100}%`;
      span.textContent = fmtDay(sw[i].mjd);
      el.ticks.append(span);
    }
    return;
  }
  let lastT = -1;
  const sw = S.meta.sweeps;
  for (let i = 0; i < sw.length; i++) {
    const s = sw[i];
    const t = tOf(s.mjd);
    if (lastT >= 0 && (t - lastT) < minSpacing && i < sw.length - 1) continue;
    lastT = t;
    const span = document.createElement("span");
    span.style.left = `${t * 100}%`;
    span.textContent = s.label;
    el.ticks.append(span);
  }
}

function viewRect() {
  const n = S.meta.npix;
  if (!S.zoom) return { sx: 0, sy: 0, sw: n, sh: n };
  const sw = n / S.zoom.scale;
  let sx = S.zoom.cx - sw / 2, sy = S.zoom.cy - sw / 2;
  sx = Math.max(0, Math.min(n - sw, sx));
  sy = Math.max(0, Math.min(n - sw, sy));
  return { sx, sy, sw, sh: sw };
}

function draw() {
  const m = S.meta;
  if (!m || !S.canvases.length) return;
  const W = el.view.width;
  const r = viewRect();
  const { k, w } = segment(S.t);
  vctx.imageSmoothingEnabled = true;
  vctx.imageSmoothingQuality = "high";
  vctx.globalAlpha = 1;
  vctx.fillStyle = "#05070d";
  vctx.fillRect(0, 0, W, W);

  let shown;
  if (S.mode !== "swipe") swipeLabels(null);
  if (S.mode === "stack" && S.stackCanvas) {
    vctx.drawImage(S.stackCanvas, r.sx, r.sy, r.sw, r.sh, 0, 0, W, W);
    if (el.marks.checked) drawMarks(r);
    el.tag.innerHTML = `<strong>All ${m.sweeps.length} images stacked on ${m.name}</strong> stars smear away, the object adds up`;
    if (S.burn) burnIn();
    return;
  } else if (S.mode === "blink") {
    const i = S.blinkOn ? m.sweeps.length - 1 : 0;
    vctx.drawImage(S.canvases[i], r.sx, r.sy, r.sw, r.sh, 0, 0, W, W);
    shown = { k: i, w: 0, exact: true };
  } else if (S.mode === "swipe") {
    // first image on the left of the divider, last image on the right
    const last = m.sweeps.length - 1, x = Math.round(S.swipe * W);
    vctx.drawImage(S.canvases[0], r.sx, r.sy, r.sw, r.sh, 0, 0, W, W);
    vctx.save();
    vctx.beginPath(); vctx.rect(x, 0, W - x, W); vctx.clip();
    vctx.drawImage(S.canvases[last], r.sx, r.sy, r.sw, r.sh, 0, 0, W, W);
    vctx.restore();
    vctx.fillStyle = "#ffb347"; vctx.fillRect(x - 1.5, 0, 3, W);
    vctx.beginPath(); vctx.arc(x, W / 2, 16, 0, 7); vctx.fill();
    vctx.fillStyle = "#2a1a00"; vctx.font = "700 16px 'Public Sans', sans-serif";
    vctx.textAlign = "center"; vctx.fillText("↔", x, W / 2 + 6); vctx.textAlign = "start";
    swipeLabels(m.sweeps[0].label, m.sweeps[last].label);
    if (el.marks.checked) drawMarks(r);
    el.tag.innerHTML = `<strong>${m.sweeps[0].label} on the left, ${m.sweeps[last].label} on the right</strong> drag the divider across the picture`;
    if (S.burn) burnIn();
    return;
  } else if (S.mode === "diff") {
    drawDiff(k, w, r);
    shown = { k, w, exact: w < 0.01 || w > 0.99 };
  } else {
    vctx.drawImage(S.canvases[k], r.sx, r.sy, r.sw, r.sh, 0, 0, W, W);
    if (w > 0 && S.canvases[k + 1]) {
      vctx.globalAlpha = w;
      vctx.drawImage(S.canvases[k + 1], r.sx, r.sy, r.sw, r.sh, 0, 0, W, W);
      vctx.globalAlpha = 1;
    }
    shown = { k, w, exact: w < 0.01 || w > 0.99 };
  }
  if (el.marks.checked) drawMarks(r);
  caption(shown);
  // describe the picture for screen readers
  el.view.setAttribute("aria-label", `${m.name}, SPHEREx image. ${el.tag.textContent.replace(/\s+/g, " ").trim()}`);
  if (S.burn) burnIn();
  if (S.mode !== "blink") el.time.value = Math.round(S.t * 1000);
}

/* "Show only what changed". The passes line up to within about 0.1 pixel,
   but SPHEREx's coarse pixels and the telescope's different orientation each
   pass make every star's image a little different, so a plain subtraction
   leaves a small leftover at every star. Differences are therefore coloured
   by how far they stand above that expected leftover (noise plus a fifth of
   the star's brightness): teal = brighter now, pink = fainter now. Places
   away from the changes that passed the checks are dimmed. */
const LEFTOVER = 0.2;
function diffPixel(px, j, v, mx, noise, dim) {
  const z = v / Math.sqrt(noise * noise + (LEFTOVER * mx) * (LEFTOVER * mx));
  let a = Math.min(1, Math.abs(z) / 6);
  if (Math.abs(z) < 3) a *= 0.25;           // within the expected leftover
  a *= dim;
  const c = v > 0 ? [98, 210, 195] : [242, 132, 158];
  px[j] = 5 + (c[0] - 5) * a; px[j + 1] = 7 + (c[1] - 7) * a; px[j + 2] = 13 + (c[2] - 13) * a; px[j + 3] = 255;
}

function spotlight(n, changes, radius) {
  const m = new Float32Array(n * n).fill(changes.length ? 0.3 : 0.55);
  for (const c of changes) {
    for (const p of (c.track && c.track.length ? c.track : [{ x: c.x, y: c.y }])) {
      const x0 = Math.round(p.x), y0 = Math.round(p.y), r = radius;
      for (let y = Math.max(0, y0 - r); y <= Math.min(n - 1, y0 + r); y++)
        for (let x = Math.max(0, x0 - r); x <= Math.min(n - 1, x0 + r); x++)
          if ((x - p.x) ** 2 + (y - p.y) ** 2 <= r * r) m[y * n + x] = 1;
    }
  }
  return m;
}

function drawDiff(k, w, r) {
  const n = S.meta.npix, A = S.frames[k], B = S.frames[k + 1] || A, R = S.frames[0];
  if (!S.diffCanvas) { S.diffCanvas = document.createElement("canvas"); }
  if (!S.spot || S.spot.meta !== S.meta) S.spot = { meta: S.meta, mask: spotlight(n, S.meta.changes, 7) };
  const c = S.diffCanvas;
  c.width = c.height = n;
  const cx = c.getContext("2d"), img = cx.createImageData(n, n), px = img.data;
  const gain = Math.pow(10, (+el.stretch.value - 50) / 25);
  const noise = 2 * S.sigma / gain;
  const mask = S.spot.mask;
  for (let i = 0, j = 0; i < A.length; i++, j += 4) {
    const now = (1 - w) * A[i] + w * B[i];
    const v = now - R[i];
    if (v !== v) { px[j] = px[j + 1] = px[j + 2] = 40; px[j + 3] = 255; continue; }   // no data
    diffPixel(px, j, v, Math.max(Math.abs(now), Math.abs(R[i])), noise, mask[i]);
  }
  cx.putImageData(img, 0, 0);
  vctx.drawImage(c, r.sx, r.sy, r.sw, r.sh, 0, 0, el.view.width, el.view.width);
}

function trackAt(c, t) {
  const sw = S.meta.sweeps, tr = c.track;
  if (!tr || tr.length !== sw.length) return { x: c.x, y: c.y };
  const { k, w } = segment(t);
  return { x: tr[k].x + w * (tr[k + 1 || k].x - tr[k].x), y: tr[k].y + w * (tr[k + 1 || k].y - tr[k].y) };
}

function drawMarks(r) {
  const W = el.view.width, sc = W / r.sw;
  const toX = (x) => (x - r.sx + 0.5) * sc, toY = (y) => (y - r.sy + 0.5) * sc;
  if (S.track) {
    const c = (S.meta.npix - 1) / 2, rad = Math.max(14, 7 * sc);
    vctx.save();
    vctx.strokeStyle = KIND.tracked.color; vctx.lineWidth = 2;
    vctx.beginPath(); vctx.arc(toX(c), toY(c), rad, 0, 7); vctx.stroke();
    vctx.font = "700 15px 'Public Sans', sans-serif"; vctx.fillStyle = KIND.tracked.color;
    vctx.fillText(S.meta.name, toX(c) + rad + 6, toY(c) - rad * 0.4);
    vctx.restore();
    return;
  }
  for (const c of S.meta.changes) {
    const col = KIND[c.kind].color;
    const sel = S.selected === c.rank;
    const rad = Math.max(10, Math.min(46, 9 * sc));
    vctx.save();
    if (c.kind === "moved" && c.track) {
      vctx.strokeStyle = col; vctx.globalAlpha = 0.75; vctx.lineWidth = 1.5;
      vctx.beginPath();
      c.track.forEach((p, i) => { i ? vctx.lineTo(toX(p.x), toY(p.y)) : vctx.moveTo(toX(p.x), toY(p.y)); });
      vctx.stroke();
      vctx.fillStyle = col;
      for (const p of c.track) { vctx.beginPath(); vctx.arc(toX(p.x), toY(p.y), 2.5, 0, 7); vctx.fill(); }
    }
    const p = S.mode === "blink" ? c.track[S.blinkOn ? c.track.length - 1 : 0]
      : S.mode === "swipe" ? c.track[(toX(c.track[0].x) < S.swipe * W) ? 0 : c.track.length - 1]
      : trackAt(c, S.t);
    vctx.globalAlpha = sel ? 1 : 0.85;
    vctx.strokeStyle = col;
    vctx.lineWidth = sel ? 3 : 2;
    vctx.setLineDash(c.verified === false || (c.kind !== "moved" && c.verified == null) ? [5, 4] : []);
    vctx.beginPath(); vctx.arc(toX(p.x), toY(p.y), rad, 0, 7); vctx.stroke();
    vctx.setLineDash([]);
    vctx.font = "700 15px 'Public Sans', sans-serif";
    vctx.fillStyle = col;
    vctx.fillText(String(c.rank), toX(p.x) + rad * 0.75, toY(p.y) - rad * 0.75);
    vctx.restore();
  }

  // Draw pinned citizen-science findings for this target
  const targetFindings = (S.findings || []).filter((f) => f.slug === S.meta.slug && f.x != null);
  for (const f of targetFindings) {
    vctx.save();
    const px = toX(f.x), py = toY(f.y);
    vctx.fillStyle = "#ffb347";
    vctx.strokeStyle = "#ffffff";
    vctx.lineWidth = 2;
    vctx.beginPath();
    vctx.arc(px, py, 6, 0, 7);
    vctx.fill();
    vctx.stroke();
    vctx.font = "700 13px 'Public Sans', sans-serif";
    vctx.fillStyle = "#ffffff";
    vctx.fillText(f.type, px + 9, py - 6);
    vctx.restore();
  }
}

function fmtTime(mjd) {
  return mjdToDate(mjd).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}
function gapText(days) {
  const h = days * 24;
  return h < 1.5 ? `${Math.round(h * 60)} minutes` : h < 48 ? `${Math.round(h)} hours` : `${Math.round(days)} days`;
}

function caption(shown) {
  const sw = S.meta.sweeps;
  if (S.track) {
    const n = sw.length;
    if (shown.exact || S.blendMode === "steps") {
      const i = shown.w > 0.5 ? shown.k + 1 : shown.k, f = sw[i] || sw[shown.k];
      el.tag.innerHTML = `<strong>${fmtTime(f.mjd)}</strong> image ${i + 1} of ${n}, seen at ${f.lam.toFixed(2)} µm`;
    } else {
      el.tag.innerHTML = `<strong>${fmtTime(mjdAt(S.t))}</strong> <span class="blend">blend of two images taken ${gapText(sw[shown.k + 1].mjd - sw[shown.k].mjd)} apart (not observed)</span>`;
    }
    el.when.textContent = `${n} real exposures, ${fmtDay(sw[0].mjd)} to ${fmtDay(sw[n - 1].mjd)}. The view moves with the object, so the stars stream past.`
      + (S.meta.facts && S.meta.facts.visible_when_stacked ? " Too faint to spot in one image? Choose “Stack all images on it”." : "");
    return;
  }
  if (shown.exact || S.blendMode === "steps") {
    const s = sw[shown.w > 0.5 ? shown.k + 1 : shown.k] || sw[shown.k];
    const extra = S.mode === "diff" && s !== sw[0] ? ` minus ${sw[0].label}` : "";
    const stepLabel = S.blendMode === "steps" ? ", a real observation" : "";
    el.tag.innerHTML = `<strong>${s.label}${extra}</strong> ${s.n} exposures stacked, ${fmtDay(s.mjd0)} to ${fmtDay(s.mjd1)}${stepLabel}`;
  } else {
    el.tag.innerHTML = `<strong>${fmtDay(mjdAt(S.t))}</strong> <span class="blend">blend of ${sw[shown.k].label} and ${sw[shown.k + 1].label} (not observed)</span>`;
  }
  el.when.textContent = S.zoom ? "" : `${sw.length} sweeps, ${Math.round((axis().t1 - axis().t0) / 30.4)} months apart in total`;
}

/* ---------------------------------------------------------- share */

// Text drawn into saved pictures and videos, so they explain themselves.
function burnIn() {
  const W = el.view.width;
  const tag = el.tag.textContent.replace(/\s+/g, " ").trim();
  vctx.save();
  vctx.fillStyle = "rgba(8, 11, 22, 0.8)";
  vctx.fillRect(0, W - 62, W, 62);
  vctx.fillRect(0, 0, W, 36);
  vctx.fillStyle = "#ffb347";
  vctx.font = "700 22px 'Bricolage Grotesque', 'Public Sans', sans-serif";
  vctx.fillText(S.meta.name, 14, W - 34);
  vctx.fillStyle = "#ece7da";
  vctx.font = "15px 'Public Sans', sans-serif";
  vctx.fillText(tag.slice(0, 90), 14, W - 12);
  vctx.fillStyle = "#a0a9c2";
  vctx.fillText("NASA SPHEREx images, via Sky Blink", 14, 23);
  vctx.restore();
}

function shareMsg(t) {
  el.shareMsg.textContent = t;
  clearTimeout(shareMsg.timer);
  shareMsg.timer = setTimeout(() => { el.shareMsg.textContent = ""; }, 6000);
}

function viewLink() {
  const q = new URLSearchParams();
  if (S.selected) q.set("c", S.selected);
  if (S.mode !== "fade") q.set("m", S.mode);
  const qs = q.toString();
  return `${location.origin}${location.pathname}#/${S.meta.slug}${qs ? "?" + qs : ""}`;
}

async function copyLink() {
  const url = viewLink();
  try {
    await navigator.clipboard.writeText(url);
    shareMsg("Link copied. Anyone who opens it sees this view.");
  } catch (e) {
    prompt("Copy this link:", url);
  }
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function savePicture() {
  S.burn = true; draw(); S.burn = false;
  el.view.toBlob((b) => { download(b, `${S.meta.slug}-sky-blink.png`); draw(); shareMsg("Picture saved."); }, "image/png");
}

function saveVideo() {
  if (!window.MediaRecorder || !el.view.captureStream) {
    shareMsg("This browser cannot record video. Try Chrome, Edge or Firefox, or save a picture instead.");
    return;
  }
  const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
  const type = types.find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(el.view.captureStream(30), type ? { mimeType: type, videoBitsPerSecond: 4e6 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    S.burn = false;
    el.saveVideo.disabled = false;
    const mime = rec.mimeType || "video/webm";
    download(new Blob(chunks, { type: mime }), `${S.meta.slug}-sky-blink.${mime.includes("mp4") ? "mp4" : "webm"}`);
    shareMsg("Video saved.");
    draw();
  };
  el.saveVideo.disabled = true;
  shareMsg("Recording one trip through time…");
  S.burn = true;
  if (S.mode === "blink") setMode("fade");
  stop();
  S.t = 0;
  S.onLoop = () => { S.onLoop = null; setTimeout(() => rec.state === "recording" && rec.stop(), 300); };
  rec.start(250);
  play();
  setTimeout(() => rec.state === "recording" && rec.stop(), 30000);   // safety stop
}

/* ---------------------------------------------------------- tour */

const TOUR_HOLD_MS = 2500;   // extra time on each stop after one full trip

// Five stops, one of each kind of result, each with a short line of its own
// (the side panel already carries the full text).
const TOUR = [
  ["3i-atlas", "A visitor from another star. Every image is centred on the comet, then all are stacked: the stars smear away and the comet appears."],
  ["barnard", "The fastest star in our sky. Watch it step north between SPHEREx passes a year apart."],
  ["psyche", "A metal-rich asteroid that a NASA spacecraft is on its way to. Sky Blink follows it from image to image across the sky."],
  ["wise-j184125", "A star that faded. Sky Blink measured it getting fainter and checked it against its neighbours."],
  ["orion", "And sometimes nothing changes. In a busy star-forming cloud, Sky Blink raised no false alarms."],
];
function tourList() {
  const have = new Set(S.index.map((t) => t.slug));
  const list = TOUR.filter(([slug]) => have.has(slug)).map(([slug]) => slug);
  for (const t of S.index) if (list.length < 5 && !list.includes(t.slug)) list.push(t.slug);
  return list.slice(0, 5);
}
const tourLine = (slug, meta) => (TOUR.find(([s]) => s === slug) || [])[1] || meta.note || "";

function startTour() {
  S.tour = { list: tourList(), i: 0, paused: false };
  location.hash = `#/${S.tour.list[0]}`;
}

function endTour() {
  clearTimeout(S.tourTimer);
  S.tour = null;
  el.tourbar.hidden = true;
}

function tourNext() {
  if (!S.tour) return;
  clearTimeout(S.tourTimer);
  S.tour.i += 1;
  if (S.tour.i >= S.tour.list.length) {
    endTour();
    location.hash = "";
    setStatus("That was the tour. Pick any card to look closer, or search for a place in the sky.");
    return;
  }
  location.hash = `#/${S.tour.list[S.tour.i]}`;
}

// Called after a target has loaded while a tour is running.
function tourStop() {
  const T = S.tour;
  if (!T || !S.meta) {
    el.tourbar.hidden = true;
    return;
  }
  const currSlug = S.meta.slug;
  const listIdx = T.list.indexOf(currSlug);
  if (listIdx === -1) {
    endTour();
    return;
  }
  T.i = listIdx; // Guard: tour pill always matches the loaded target
  el.tourbar.hidden = false;
  el.tourStep.textContent = `Stop ${T.i + 1} of ${T.list.length}: ${S.meta.name}.`;
  el.tourText.textContent = tourLine(S.meta.slug, S.meta);
  el.tourPause.textContent = T.paused ? "Resume tour" : "Pause tour";
  if (S.track && S.stackCanvas) {
    // Faint comets and asteroids: show the stacked picture first, where the
    // object is actually visible, then follow it.
    stop(); setMode("stack");
    S.tourTimer = setTimeout(() => {
      if (!S.tour || S.tour.paused) return;
      setMode("fade"); S.t = 0; play();
      S.tourTimer = setTimeout(() => { if (S.tour && !S.tour.paused) tourNext(); }, 9000);
    }, TOUR_HOLD_MS + 3000);
    S.onLoop = null;
    return;
  } else {
    const top = S.meta.changes.find((c) => c.kind === "moved" || c.verified);
    if (top) focusChange(top); else { zoomOut(); S.t = 0; play(); }
  }
  S.onLoop = () => {
    S.onLoop = null;
    if (!S.tour || S.tour.paused) return;
    S.tourTimer = setTimeout(tourNext, TOUR_HOLD_MS);
  };
}

/* ---------------------------------------------------------- playback */

function play() {
  if (!S.meta || !S.canvases.length) return;
  if (S.mode === "stack" || S.mode === "swipe") setMode("fade");
  if (S.mode === "blink") { startBlink(); return; }
  if (S.t >= 0.999) S.t = 0;
  S.playing = true;
  S.last = performance.now();
  S.holdUntil = S.last + HOLD_MS;
  el.play.textContent = "Pause";
  cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(tick);
}

function stop() {
  S.playing = false;
  cancelAnimationFrame(S.raf);
  clearInterval(S.blinkTimer);
  S.blinkTimer = 0;
  el.play.textContent = "Play";
}

function tick(now) {
  if (!S.playing) return;
  const dt = now - S.last;
  S.last = now;
  if (S.track && now >= S.holdUntil) {
    const n = S.meta.sweeps.length;
    S.t = Math.min(1, S.t + dt / (TRACK_STEP_MS * Math.max(1, n - 1)));
    if (S.t >= 1) {
      draw();
      S.holdUntil = now + 1800;
      if (S.onLoop) { S.onLoop(); if (!S.playing) return; }
      S.t = 0;
    }
    draw();
    S.raf = requestAnimationFrame(tick);
    return;
  }
  if (now >= S.holdUntil) {
    const sw = S.meta.sweeps;
    const before = segment(S.t);
    const segLen = tOf(sw[before.k + 1].mjd) - tOf(sw[before.k].mjd);
    S.t = Math.min(1, S.t + (dt / TRAVEL_MS) * segLen);
    const after = segment(S.t);
    // arrived at a real sweep: pause there so it can be seen
    if (after.k !== before.k || S.t >= 1 || (after.w >= 1 && before.w < 1)) {
      const target = sw.findIndex((s) => tOf(s.mjd) >= S.t - 1e-6);
      if (target >= 0) S.t = tOf(sw[target].mjd);
      S.holdUntil = now + HOLD_MS * (S.t >= 1 ? 1.8 : 1);
      if (S.t >= 1) {
        draw();
        if (S.onLoop) { S.onLoop(); if (!S.playing) return; }
        S.t = 0; S.holdUntil = now + HOLD_MS * 1.8; S.raf = requestAnimationFrame(tick); return;
      }
    }
  }
  draw();
  S.raf = requestAnimationFrame(tick);
}

function startBlink() {
  stop();
  S.playing = true;
  el.play.textContent = "Pause";
  S.blinkTimer = setInterval(() => { S.blinkOn = !S.blinkOn; draw(); }, 650);
  draw();
}

/* ---------------------------------------------------------- report */

function buildReport() {
  const m = S.meta;
  document.getElementById("guide").textContent = guideText();
  el.summary.textContent = m.text.summary;
  if (S.track) { buildTrackReport(); return; }
  el.writer.textContent = m.text.writer.startsWith("AI")
    ? "Written by AI from the measurements below. Numbers are checked against them."
    : "Written automatically from the measurements.";
  el.changes.replaceChildren();
  const texts = Object.fromEntries((m.text.items || []).map((i) => [i.rank, i.text]));
  if (!m.changes.length) {
    const li = document.createElement("li");
    li.className = "nochange";
    li.textContent = `Sky Blink compared ${m.n_sources} sources across the sweeps and found no change larger than the measurement noise.`;
    el.changes.append(li);
  }
  for (const c of m.changes) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "change";
    b.setAttribute("aria-pressed", "false");
    const [sure, cls] = sureness(c);
    b.innerHTML = `${icon(c.kind)}<div><p class="c-text"><strong>${c.rank}. ${KIND[c.kind].noun}.</strong> ${texts[c.rank] || ""}</p>
      <p class="c-meta">${changeNumbers(c)}. <span class="sure ${cls}">${sure}</span> (${term(`${c.significance}σ`, "sigma")})${c.saturated ? `; ${term("saturated", "saturated")} star, so its position is less precise` : ""}</p>${catalogueLine(c)}</div>`;
    b.addEventListener("click", () => focusChange(c));
    li.append(b);
    el.changes.append(li);
  }
}

function buildTrackReport() {
  const m = S.meta, f = m.facts;
  el.writer.textContent = m.text.writer.startsWith("AI")
    ? "Written by AI from the facts below. Numbers are checked against them."
    : "Written automatically from the facts below.";
  el.changes.replaceChildren();
  const rows = [
    ["Real SPHEREx images", `${f.n_images}, over ${f.visits} visit${f.visits > 1 ? "s" : ""}`],
    ["Dates", `${f.first_date} to ${f.last_date}`],
    ["Distance from Earth", f.distance_au ? `${f.distance_au} ${term("au", "au")} (${f.distance_million_km} million km)` : "unknown"],
    ["Speed across the sky", f.sky_speed_arcsec_per_hour ? `${f.sky_speed_arcsec_per_hour}″ per hour` : "unknown"],
    ["Position from", "NASA JPL Horizons orbit"],
  ];
  const li = document.createElement("li");
  li.innerHTML = `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  el.changes.append(li);
  const pts = [];   // single-image brightness is too confused by passing stars to chart honestly
  if (pts.length >= 5) {
    const li2 = document.createElement("li");
    li2.innerHTML = `<h3 class="mini-h">Its brightness in each colour</h3>${spectrumSvg(pts)}
      <p class="c-meta">Each dot is one SPHEREx image; every image sees a different infrared colour. Quick-look measurements in a small circle around the predicted position.</p>`;
    el.changes.append(li2);
  }
}

function spectrumSvg(pts) {
  const W = 420, H = 190, L = 44, R = 8, T = 8, B = 30, x0 = 0.7, x1 = 5.1;
  const fl = pts.map((p) => p.flux).sort((a, b) => a - b);
  const hi = fl[Math.floor(fl.length * 0.97)] * 1.25 || 1;
  const X = (l) => L + (l - x0) / (x1 - x0) * (W - L - R), Y = (v) => T + (1 - Math.min(v, hi) / hi) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="mini-spec" role="img" aria-label="Brightness against infrared colour">`;
  s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#303b60"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#303b60"/>`;
  for (let l = 1; l <= 5; l++) s += `<text x="${X(l)}" y="${H - B + 15}" text-anchor="middle">${l}</text>`;
  s += `<text x="${(L + W) / 2}" y="${H - 2}" text-anchor="middle">wavelength, micrometres</text>`;
  s += `<text transform="translate(11 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">mJy</text>`;
  for (const p of pts) s += `<circle cx="${X(p.lam).toFixed(1)}" cy="${Y(p.flux).toFixed(1)}" r="3" fill="#a9b8ff" fill-opacity="0.85"/>`;
  return s + "</svg>";
}

function focusChange(c) {
  S.selected = c.rank;
  const p = c.track ? c.track[0] : c;
  const span = c.track ? Math.max(...c.track.map((q) => Math.hypot(q.x - p.x, q.y - p.y))) : 0;
  const scale = c.kind === "moved" ? Math.max(2.5, Math.min(6, S.meta.npix / (span * 6 + 40))) : 3;
  const mid = c.track ? c.track[Math.floor(c.track.length / 2)] : p;
  S.zoom = { cx: mid.x, cy: mid.y, scale };
  el.zoomTag.hidden = false;
  el.zoomTag.textContent = `Magnified ${scale.toFixed(1)}× around change ${c.rank}`;
  el.zoomOut.hidden = false;
  for (const b of el.changes.querySelectorAll(".change")) b.setAttribute("aria-pressed", String(b.textContent.trim().startsWith(c.rank + ".")));
  if (S.mode === "blink") setMode("fade");
  S.t = 0;
  draw();
  play();
  el.view.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function zoomOut() {
  S.zoom = null; S.selected = null;
  el.zoomTag.hidden = true; el.zoomOut.hidden = true;
  for (const b of el.changes.querySelectorAll(".change")) b.setAttribute("aria-pressed", "false");
  draw();
}

// Zoom by a factor around a point of the image (in image pixels).
function zoomBy(factor, cx, cy) {
  if (!S.meta) return;
  const n = S.meta.npix, r = viewRect();
  const scale = Math.min(12, Math.max(1, (S.zoom ? S.zoom.scale : 1) * factor));
  if (scale <= 1.001) { zoomOut(); return; }
  S.zoom = { cx: cx ?? r.sx + r.sw / 2, cy: cy ?? r.sy + r.sh / 2, scale };
  el.zoomTag.hidden = false;
  el.zoomTag.textContent = `Magnified ${scale.toFixed(1)}×: real pixels, enlarged`;
  el.zoomOut.hidden = false;
  if (n) draw();
}

function setMode(m) {
  S.mode = m;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === m;
  const help = {
    fade: S.track
      ? "Step through the real images in time order. The view stays on the object, so the stars stream past; between two images the picture is a blend, and the caption says so."
      : "Slide through time. Between two real sweeps the picture is a blend, so motion looks smooth; the caption says when you are looking at a blend.",
    blink: "Flips between the first and the last sweep, like the blink comparator that found Pluto. Anything that jumps has changed.",
    stack: "Every image is centred on the object, then they are combined. Each star lands somewhere different in every image and smears away; the object lands in the same place every time and adds up. This is how astronomers find faint comets and asteroids.",
    diff: "Each sweep minus the first. Teal: brighter than before. Pink: fainter than before. A star that moved shows pink where it was and teal where it is now. Every star leaves a faint leftover, because SPHEREx's star images differ slightly between passes; only differences well beyond that are coloured strongly, and places away from the checked changes are dimmed.",
    swipe: "The first image is on the left of the divider, the last on the right. Drag the divider (or use the arrow keys) and watch what jumps as it passes.",
  };
  el.modeHelp.textContent = help[m];
  const wasPlaying = S.playing;
  stop();
  if (m !== "stack" && m !== "swipe" && (wasPlaying || m === "blink")) play();
  else draw();
}

function swipeLabels(left, right) {
  const L = document.getElementById("swipe-left"), R = document.getElementById("swipe-right");
  L.hidden = R.hidden = !left;
  if (left) { L.textContent = left; R.textContent = right; }
}

/* One plain sentence above the picture: what this is and what to do. */
function guideText() {
  const m = S.meta;
  if (!m) return "";
  if (S.track) {
    return m.facts && m.facts.visible_when_stacked
      ? `These are real SPHEREx images, centred on ${m.name}, so the stars stream past. It is too faint to spot in one image: choose “Stack all images on it” to make it appear.`
      : `These are real SPHEREx images, centred on where the orbit puts ${m.name}, so the stars stream past.`;
  }
  const top = m.changes.find((c) => c.kind === "moved" || c.verified);
  if (!top) return `The same patch of sky, photographed ${m.sweeps.length} times months apart. Nothing measurable changed: press Play and the stars stay put. That is a result too.`;
  const what = top.kind === "moved" ? "creeps across the background stars"
    : top.kind === "faded" || top.kind === "vanished" ? "gets fainter" : "gets brighter";
  return `The same patch of sky, photographed months apart. Press Play: the circled object ${what}. Try “Swipe first and last” to compare the two ends side by side.`;
}

/* ---------------------------------------------------------- search */

function norm(s) { return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9+.\- ]/g, "").replace(/\s+/g, " ").trim(); }

function parseCoords(text) {
  const t = text.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const p = t.split(" ").map(Number);
  if (p.length === 2 && p.every(Number.isFinite) && p[0] >= 0 && p[0] < 360 && Math.abs(p[1]) <= 90) return { ra: p[0], dec: p[1] };
  const m = t.match(/^(\d{1,2})[:h ](\d{1,2})[:m ](\d{1,2}(?:\.\d+)?)s?\s+([+-]?\d{1,2})[:d° ](\d{1,2})[:m' ](\d{1,2}(?:\.\d+)?)/i);
  if (m) {
    const ra = (+m[1] + m[2] / 60 + m[3] / 3600) * 15;
    const sgn = m[4].startsWith("-") ? -1 : 1;
    const dec = sgn * (Math.abs(+m[4]) + m[5] / 60 + m[6] / 3600);
    if (ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
  }
  return null;
}

function matches(q) {
  const n = norm(q);
  if (n.length < 1) return [];
  const starts = [];
  const aliasStarts = [];
  const rest = [];
  for (const t of S.index) {
    const tn = norm(t.name);
    const item = { label: t.name, hint: "changes ready", slug: t.slug };
    if (tn.startsWith(n)) starts.push(item);
    else if (tn.includes(n)) rest.push(item);
  }
  for (const o of S.names) {
    if ([...starts, ...aliasStarts, ...rest].some((x) => x.label === o.name)) continue;
    const on = norm(o.name);
    const item = { label: o.name, hint: o.aka && o.aka.length ? o.aka[0] : "explore", ra: o.ra, dec: o.dec, size: o.size };
    if (on.startsWith(n)) starts.push(item);
    else if ((o.aka || []).some((a) => norm(a).startsWith(n))) aliasStarts.push(item);
    else if (n.length >= 2 && [o.name, ...(o.aka || [])].some((a) => norm(a).includes(n))) rest.push(item);
  }
  return [...starts, ...aliasStarts, ...rest].slice(0, 10);
}

function go(m) {
  el.suggest.hidden = true;
  if (m.slug) location.hash = `#/${m.slug}`;
  else location.href = `explore.html?ra=${m.ra}&dec=${m.dec}&size=${m.size || 0.25}&name=${encodeURIComponent(m.label)}`;
}

let sel = -1;
function showSuggest() {
  const list = matches(el.q.value);
  el.suggest.replaceChildren();
  sel = -1;
  if (!list.length) { el.suggest.hidden = true; return; }
  list.forEach((m, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.innerHTML = `${m.label}<small>${m.hint}</small>`;
    li.addEventListener("mousedown", (e) => { e.preventDefault(); go(m); });
    el.suggest.append(li);
  });
  el.suggest.hidden = false;
}

el.q.addEventListener("input", showSuggest);
el.q.addEventListener("blur", () => setTimeout(() => { el.suggest.hidden = true; }, 100));
el.q.addEventListener("keydown", (e) => {
  const items = [...el.suggest.children];
  if (!items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.setAttribute("aria-selected", String(i === sel)));
  }
});
el.search.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = el.q.value.trim();
  if (!raw) return;
  const list = matches(raw);
  if (sel >= 0 && list[sel]) return go(list[sel]);
  const c = parseCoords(raw);
  if (c) return go({ ...c, size: 0.25 });
  if (list.length) return go(list[0]);
  setStatus(`Looking up "${raw}" in astronomical catalogs (SIMBAD/NED)…`);
  try {
    const r = await fetch(`/api/resolve?name=${encodeURIComponent(raw)}`);
    if (!r.ok) throw new Error("not found");
    const obj = await r.json();
    return go({ ra: obj.ra, dec: obj.dec, size: 0.25 });
  } catch (_) {
    setStatus(`No match for "${raw}". Try a star, comet, nebula or galaxy name (e.g. Barnard's Star, TRAPPIST-1, M51), or coordinates such as 83.82 -5.39.`, true);
  }
});

/* ---------------------------------------------------------- wiring */

el.play.addEventListener("click", () => (S.playing ? stop() : play()));
el.time.addEventListener("input", () => {
  if (S.mode === "blink") setMode("fade");
  stop();
  S.t = +el.time.value / 1000;
  draw();
});
for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", () => setMode(r.value));
el.marks.addEventListener("change", draw);
el.stretch.addEventListener("input", () => { renderSweepCanvases(); draw(); });
el.zoomOut.addEventListener("click", zoomOut);
el.tourStart.addEventListener("click", startTour);
el.tourNext.addEventListener("click", tourNext);
el.tourEnd.addEventListener("click", () => { endTour(); });
el.tourPause.addEventListener("click", () => {
  if (!S.tour) return;
  S.tour.paused = !S.tour.paused;
  el.tourPause.textContent = S.tour.paused ? "Resume tour" : "Pause tour";
  if (S.tour.paused) { clearTimeout(S.tourTimer); stop(); }
  else { play(); S.onLoop = () => { S.onLoop = null; if (S.tour && !S.tour.paused) S.tourTimer = setTimeout(tourNext, TOUR_HOLD_MS); }; }
});
function swipeTo(ev) {
  const box = el.view.getBoundingClientRect();
  S.swipe = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
  draw();
}
el.view.addEventListener("pointerdown", (ev) => {
  if (S.mode !== "swipe") return;
  el.view.setPointerCapture(ev.pointerId);
  swipeTo(ev);
});
el.view.addEventListener("pointermove", (ev) => { if (S.mode === "swipe" && ev.buttons) swipeTo(ev); });
el.view.style.touchAction = "pan-y";
el.shareLink.addEventListener("click", copyLink);
el.savePicture.addEventListener("click", savePicture);
el.saveVideo.addEventListener("click", saveVideo);
document.addEventListener("keydown", (e) => {
  if (el.targetView.hidden || e.target.matches("input[type=search], input[type=text]")) return;
  if (e.key === " " && !e.target.matches("button, input")) { e.preventDefault(); S.playing ? stop() : play(); }
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && S.mode === "swipe") {
    if (e.target.matches("input[type=range]")) return;
    S.swipe = Math.min(1, Math.max(0, S.swipe + (e.key === "ArrowRight" ? 0.05 : -0.05)));
    draw();
    return;
  }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    if (e.target.matches("input[type=range]")) return;
    stop();
    const sw = S.meta.sweeps.map((s) => tOf(s.mjd));
    const cur = sw.reduce((b, v, i) => (Math.abs(v - S.t) < Math.abs(sw[b] - S.t) ? i : b), 0);
    S.t = sw[Math.max(0, Math.min(sw.length - 1, cur + (e.key === "ArrowRight" ? 1 : -1)))];
    draw();
  }
});

async function route() {
  const m = location.hash.match(/^#\/([\w-]+)(?:\?(.*))?/);
  if (m) {
    const q = new URLSearchParams(m[2] || "");
    if (S.tour && S.tour.list[S.tour.i] !== m[1]) endTour();   // left the tour by navigating
    await openTarget(m[1], { change: q.get("c"), mode: q.get("m") });
  } else {
    endTour();
    stop();
    S.loadToken++;
    document.title = "Sky Blink: what changed in the SPHEREx sky";
    el.targetView.hidden = true;
    el.feedView.hidden = false;
  }
}

/* ---------------------------------------------------------- offline spectrum chart */

function renderTargetSpectrum() {
  if (!el.targetSpectrumView || !S.meta) return;
  const pts = S.meta.spectrum || [];
  if (!pts.length) {
    el.targetSpectrumView.innerHTML = `<p style="color:var(--muted);font-size:0.85rem">No infrared spectrum data available for this field.</p>`;
    return;
  }
  const W = 380, H = 190, L = 42, R = 12, T = 14, B = 28;
  const x0 = 0.7, x1 = 5.1;
  const fl = pts.map((p) => p.flux).sort((a, b) => a - b);
  let lo = 0, hi = 1;
  if (fl.length) {
    const q = (p) => fl[Math.min(fl.length - 1, Math.floor(p * fl.length))];
    hi = q(0.98) * 1.25; lo = Math.min(0, q(0.02));
    if (!(hi > lo)) hi = lo + 1;
  }
  const X = (l) => L + ((l - x0) / (x1 - x0)) * (W - L - R);
  const Y = (f) => T + (1 - (Math.min(Math.max(f, lo), hi) - lo) / (hi - lo)) * (H - T - B);

  const s = [];
  s.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Brightness of ${S.meta.name} at each wavelength from 0.75 to 5 micrometres, one dot per exposure">`);

  // Which of SPHEREx's six detectors covers each wavelength range
  for (const d of DETECTORS) {
    const bx0 = X(d.lam0), bw = X(d.lam1) - bx0;
    s.push(`<rect x="${bx0.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}" fill="${d.color}" fill-opacity="0.07"><title>Detector ${d.id}: ${d.lam0}–${d.lam1} µm</title></rect>`);
    s.push(`<text x="${(bx0 + bw / 2).toFixed(1)}" y="${T + 10}" class="spec-text" text-anchor="middle" fill="${d.color}">${d.id}</text>`);
  }

  // Axes
  s.push(`<line class="spec-axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>`);
  s.push(`<line class="spec-axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>`);

  // X ticks
  for (let l = 1; l <= 5; l++) {
    s.push(`<line class="spec-axis" x1="${X(l)}" y1="${H - B}" x2="${X(l)}" y2="${H - B + 4}"/>`);
    s.push(`<text x="${X(l)}" y="${H - B + 14}" class="spec-text" text-anchor="middle">${l}µm</text>`);
  }

  // Y ticks (flux)
  const yTicks = [lo, (lo + hi) / 2, hi];
  for (const f of yTicks) {
    s.push(`<line class="spec-grid" x1="${L}" y1="${Y(f)}" x2="${W - R}" y2="${Y(f)}"/>`);
    s.push(`<text x="${L - 4}" y="${Y(f) + 3}" class="spec-text" text-anchor="end">${f < 10 ? f.toFixed(1) : Math.round(f)}</text>`);
  }
  s.push(`<text transform="translate(10 ${(T + H - B) / 2}) rotate(-90)" class="spec-text" text-anchor="middle">mJy</text>`);

  // Data points
  const epColors = ["#ffb347", "#62d2c3", "#f2849e", "#a9b8ff", "#d6e36b", "#ff8f5a"];
  for (const p of pts) {
    const px = X(p.lam), py = Y(p.flux);
    const col = epColors[(p.epoch || 0) % epColors.length];
    // error bar, then the point
    if (p.err > 0) s.push(`<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${Y(p.flux - p.err).toFixed(1)}" y2="${Y(p.flux + p.err).toFixed(1)}" stroke="${col}" stroke-opacity="0.5"/>`);
    s.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.4" fill="${col}" fill-opacity="0.9"><title>${p.lam.toFixed(3)} µm: ${p.flux.toFixed(1)} ± ${p.err.toFixed(1)} mJy</title></circle>`);
  }
  s.push(`</svg>`);

  const src = S.meta.spectrum_source;
  el.spectrumCaption.innerHTML = `Brightness in ${term("mJy", "mjy")}. ` + (src
    ? `Each dot is one real exposure (${src.measured} of ${src.exposures}); colour shows the sweep. ` +
      (src.skipped ? `${src.skipped} were left out because saturated or flagged pixels fell in the measuring circle. ` : "") +
      "Quick-look brightness, not calibrated science values."
    : "Each dot is one real exposure. Quick-look brightness, not calibrated science values.");
  el.targetSpectrumView.innerHTML = s.join("");
}

/* ---------------------------------------------------------- citizen science (flag & review) */

function loadFindings() {
  try {
    S.findings = JSON.parse(localStorage.getItem("skyblink_findings") || "[]");
  } catch (_) {
    S.findings = [];
  }
  updateFindingsBadge();
}

function saveFindings() {
  localStorage.setItem("skyblink_findings", JSON.stringify(S.findings));
  updateFindingsBadge();
  draw();
}

function updateFindingsBadge() {
  if (el.findingsCount) el.findingsCount.textContent = String(S.findings.length);
}

/* Sky position of an image point, inverting the tangent-plane grid the
   server builds (north up, east left, pixel centres at i + 0.5). */
function pixelToSky(ix, iy) {
  const n = S.meta.npix, step = (S.meta.size * Math.PI / 180) / n;
  const xi = -(ix - n / 2) * step, eta = -(iy - n / 2) * step;
  const a0 = S.meta.ra * Math.PI / 180, d0 = S.meta.dec * Math.PI / 180;
  const rho = Math.hypot(xi, eta), c = Math.atan(rho);
  const dec = rho ? Math.asin(Math.cos(c) * Math.sin(d0) + eta * Math.sin(c) * Math.cos(d0) / rho) : d0;
  const ra = a0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return { ra: ((ra * 180 / Math.PI) % 360 + 360) % 360, dec: dec * 180 / Math.PI };
}

function openFlagModal(clickX, clickY) {
  if (!S.meta) return;
  const r = viewRect();
  const ix = r.sx + (clickX / el.view.width) * r.sw;
  const iy = r.sy + (clickY / el.view.height) * r.sh;
  const npix = S.meta.npix, sz = S.meta.size;
  const arcsec_per_pix = (sz * 3600) / npix;
  const { ra, dec } = pixelToSky(ix, iy);
  const dateStr = fmtDay(mjdAt(S.t));

  // Check if click coordinates match any candidate in S.meta.changes within 15 arcseconds
  const match = S.meta.changes
    ? S.meta.changes.find((c) => Math.hypot(c.x - ix, c.y - iy) * arcsec_per_pix < 15)
    : null;

  S.flagPending = {
    target: S.meta.name, slug: S.meta.slug,
    ra: +ra.toFixed(5), dec: +dec.toFixed(5),
    x: Math.round(ix), y: Math.round(iy),
    date: dateStr, match: match ? match.rank : null, matchKind: match ? match.kind : null,
  };

  el.flagTarget.textContent = S.meta.name;
  el.flagRaDec.textContent = `RA ${ra.toFixed(4)}°, Dec ${dec.toFixed(4)}°`;
  el.flagObsDate.textContent = dateStr;
  if (match) {
    el.flagMatchAlert.hidden = false;
    el.flagMatchAlert.textContent = `This spot is where Sky Blink found change ${match.rank} (${match.kind || "candidate"}).`;
  } else {
    el.flagMatchAlert.hidden = true;
  }
  el.flagNotes.value = "";
  el.flagType.value = "";               // no answer chosen for the viewer
  el.flagType.setCustomValidity("");
  el.flagModal.hidden = false;
}

function saveFlagFinding() {
  if (!S.flagPending) return;
  if (!el.flagType.value) {
    el.flagType.setCustomValidity("Choose what you saw, or “Not sure”.");
    el.flagType.reportValidity();
    el.flagType.focus();
    return;
  }
  const finding = {
    id: Date.now(),
    target: S.flagPending.target,
    slug: S.flagPending.slug,
    ra: S.flagPending.ra,
    dec: S.flagPending.dec,
    x: S.flagPending.x,
    y: S.flagPending.y,
    date: S.flagPending.date,
    type: el.flagType.value,
    notes: el.flagNotes.value.trim(),
    match: S.flagPending.match,
    matchKind: S.flagPending.matchKind,
  };
  S.findings.unshift(finding);
  saveFindings();
  closeFlagModal();
  setStatus(`Saved to My Findings: ${finding.type}, RA ${finding.ra}°, Dec ${finding.dec}°. Open My Findings to send it to the shared review queue.`);
}

function closeFlagModal() {
  S.flagPending = null;
  el.flagModal.hidden = true;
}

/* Review queue: unconfirmed candidates */
function updateCandidateReviewButton() {
  if (!el.reviewBtn || !S.meta) return;
  const candidates = (S.meta.changes || []).filter((c) => c.kind !== "moved" && !c.verified);
  S.reviewQueue = candidates;
  S.reviewIdx = 0;
  if (candidates.length > 0) {
    el.reviewBtn.hidden = false;
    el.reviewCount.textContent = String(candidates.length);
  } else {
    el.reviewBtn.hidden = true;
  }
}

function openReviewModal() {
  if (!S.reviewQueue.length) return;
  renderReviewCandidate();
  el.reviewModal.hidden = false;
}

function closeReviewModal() {
  el.reviewModal.hidden = true;
}

function renderReviewCandidate() {
  const c = S.reviewQueue[S.reviewIdx];
  if (!c) { closeReviewModal(); return; }
  el.reviewTitle.textContent = `Review Candidate #${c.rank} (${S.reviewIdx + 1} of ${S.reviewQueue.length})`;
  el.reviewMeta.textContent = `Type: ${c.kind || "Brightness change"} | Significance: ${c.significance ? c.significance.toFixed(1) + 'σ' : 'N/A'}`;
  
  // Render before & after stamps
  const span = 40, n = S.meta.npix;
  const sx = Math.max(0, Math.min(n - span, c.x - span / 2));
  const sy = Math.max(0, Math.min(n - span, c.y - span / 2));
  
  if (S.canvases.length >= 2) {
    const c0 = S.canvases[0], cLast = S.canvases[S.canvases.length - 1];
    const ctxB = el.reviewCvsBefore.getContext("2d");
    const ctxA = el.reviewCvsAfter.getContext("2d");
    ctxB.imageSmoothingEnabled = false;
    ctxA.imageSmoothingEnabled = false;
    ctxB.drawImage(c0, sx, sy, span, span, 0, 0, el.reviewCvsBefore.width, el.reviewCvsBefore.height);
    ctxA.drawImage(cLast, sx, sy, span, span, 0, 0, el.reviewCvsAfter.width, el.reviewCvsAfter.height);
    el.reviewLblBefore.textContent = `Before: ${S.meta.sweeps[0].label}`;
    el.reviewLblAfter.textContent = `After: ${S.meta.sweeps[S.meta.sweeps.length - 1].label}`;
  }
}

function submitCandidateVote(vote) {
  const c = S.reviewQueue[S.reviewIdx];
  if (c) {
    S.findings.unshift({
      id: Date.now(),
      target: S.meta.name,
      slug: S.meta.slug,
      ra: c.ra || S.meta.ra,
      dec: c.dec || S.meta.dec,
      date: S.meta.sweeps[0].label,
      type: "Candidate Review",
      notes: `Citizen review of candidate #${c.rank} (${c.kind}): Voted "${vote}"`,
      match: c.rank,
      matchKind: c.kind,
    });
    saveFindings();
  }
  S.reviewIdx++;
  if (S.reviewIdx < S.reviewQueue.length) {
    renderReviewCandidate();
  } else {
    closeReviewModal();
    setStatus("Finished review queue for this field! Your reviews are saved in My Findings.");
  }
}

/* My Findings Modal */
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Shared review queue: a pre-filled public GitHub issue, so findings can be
   checked by the team and other visitors instead of staying in one browser. */
const REVIEW_REPO = "https://github.com/justchillprogrammer/nasa/issues/new";
function reviewLink(f) {
  const view = `${location.origin}/#/${f.slug}`;
  const body = [
    `**Target:** ${f.target}`,
    `**What I saw:** ${f.type}`,
    `**Sky position:** RA ${f.ra}°, Dec ${f.dec}°`,
    `**Image date:** ${f.date}`,
    f.match ? `**Matches Sky Blink's change:** ${f.match} (${f.matchKind || "candidate"})` : "**Matches Sky Blink's changes:** no",
    "", "**Note:**", f.notes || "(none)", "",
    `**View it:** ${view}`, "", "_Sent from Sky Blink's \"Flag a finding\" tool._",
  ].join("\n");
  const q = new URLSearchParams({ title: `Finding: ${f.type} near ${f.target} (RA ${f.ra}, Dec ${f.dec})`, body });
  return `${REVIEW_REPO}?${q}`;
}

function renderFindingsList() {
  if (!el.findingsList) return;
  if (!S.findings.length) {
    el.findingsList.innerHTML = `<div style="text-align:center;padding:30px;color:var(--muted)">No findings yet. In the time machine, press “Flag a finding”, then click the spot that caught your eye.</div>`;
    return;
  }
  el.findingsList.innerHTML = S.findings.map((f) => `
    <div class="finding-card">
      <div class="finding-head">
        <span class="finding-target">${esc(f.target)}</span>
        <span class="finding-badge">${esc(f.type)}</span>
      </div>
      <div class="finding-coords">RA ${esc(f.ra)}°, Dec ${esc(f.dec)}°, image of ${esc(f.date)}</div>
      ${f.match ? `<div style="color:var(--bright);font-size:0.85rem;font-weight:700">Matches detected change ${esc(f.match)} (${esc(f.matchKind || "candidate")})</div>` : ""}
      ${f.notes ? `<div class="finding-notes">${esc(f.notes)}</div>` : ""}
      <a class="review-link" href="${esc(reviewLink(f))}" target="_blank" rel="noopener">Send to the review queue</a>
    </div>
  `).join("");
}

function openFindingsModal() {
  renderFindingsList();
  el.findingsModal.hidden = false;
}

function closeFindingsModal() {
  el.findingsModal.hidden = true;
}

function exportFindingsCSV() {
  if (!S.findings.length) { alert("No findings to export yet."); return; }
  const headers = ["Finding_ID", "Target", "RA_deg", "Dec_deg", "Observation_Date", "Category", "Notes", "Matched_Candidate_Rank", "Matched_Kind"];
  const rows = S.findings.map((f) => [
    f.id,
    `"${(f.target || '').replace(/"/g, '""')}"`,
    f.ra,
    f.dec,
    `"${(f.date || '').replace(/"/g, '""')}"`,
    `"${(f.type || '').replace(/"/g, '""')}"`,
    `"${(f.notes || '').replace(/"/g, '""')}"`,
    f.match || "",
    f.matchKind || "",
  ]);
  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
  download(new Blob([csvContent], { type: "text/csv;charset=utf-8;" }), "skyblink_findings_report.csv");
}

function exportFindingsJSON() {
  if (!S.findings.length) { alert("No findings to export yet."); return; }
  const report = {
    title: "Sky Blink Citizen-Science Findings Report",
    description: "A report ready to share: observational notes and flags recorded from SPHEREx multi-epoch infrared surveys.",
    generated: new Date().toISOString(),
    findings_count: S.findings.length,
    findings: S.findings,
  };
  download(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), "skyblink_findings_report.json");
}

function clearAllFindings() {
  if (confirm("Clear all your saved findings?")) {
    S.findings = [];
    saveFindings();
    renderFindingsList();
  }
}

// Flagging is a deliberate step: press "Flag a finding", then click the spot.
function armFlag(on) {
  S.flagArmed = on;
  el.view.classList.toggle("aiming", on);
  if (el.flagBtn) {
    el.flagBtn.classList.toggle("on", on);
    el.flagBtn.textContent = on ? "Click the spot in the picture (Esc to cancel)" : "Flag a finding";
  }
}
el.view.addEventListener("click", (ev) => {
  if (!S.flagArmed || S.mode === "swipe") return;
  const rect = el.view.getBoundingClientRect();
  const clickX = ((ev.clientX - rect.left) / rect.width) * el.view.width;
  const clickY = ((ev.clientY - rect.top) / rect.height) * el.view.height;
  armFlag(false);
  openFlagModal(clickX, clickY);
});
el.view.addEventListener("dblclick", (ev) => {
  if (S.flagArmed || S.mode === "swipe" || !S.meta) return;
  const rect = el.view.getBoundingClientRect(), r = viewRect();
  zoomBy(2, r.sx + ((ev.clientX - rect.left) / rect.width) * r.sw, r.sy + ((ev.clientY - rect.top) / rect.height) * r.sh);
});
document.getElementById("zoom-in").addEventListener("click", () => zoomBy(2));
document.getElementById("zoom-less").addEventListener("click", () => zoomBy(0.5));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.flagArmed) armFlag(false); });

// Flag modal listeners
if (el.flagBtn) el.flagBtn.addEventListener("click", () => armFlag(!S.flagArmed));
if (el.flagSave) el.flagSave.addEventListener("click", saveFlagFinding);
if (el.flagType) el.flagType.addEventListener("change", () => el.flagType.setCustomValidity(""));
if (el.flagCancel) el.flagCancel.addEventListener("click", closeFlagModal);

// Blend / Real steps toggle listener
if (el.blendToggle) {
  el.blendToggle.addEventListener("change", (ev) => {
    if (ev.target.name === "blend-mode") {
      S.blendMode = ev.target.value;
      draw();
    }
  });
}

// Review Queue listeners
if (el.reviewBtn) el.reviewBtn.addEventListener("click", openReviewModal);
if (el.reviewClose) el.reviewClose.addEventListener("click", closeReviewModal);
if (el.reviewVoteReal) el.reviewVoteReal.addEventListener("click", () => submitCandidateVote("Real change"));
if (el.reviewVoteArtifact) el.reviewVoteArtifact.addEventListener("click", () => submitCandidateVote("Artifact / Reflection"));
if (el.reviewVoteUnsure) el.reviewVoteUnsure.addEventListener("click", () => submitCandidateVote("Not sure"));

// Findings modal listeners
if (el.openFindings) el.openFindings.addEventListener("click", openFindingsModal);
if (el.findingsCloseX) el.findingsCloseX.addEventListener("click", closeFindingsModal);
if (el.findingsDone) el.findingsDone.addEventListener("click", closeFindingsModal);
if (el.exportCsv) el.exportCsv.addEventListener("click", exportFindingsCSV);
if (el.exportJson) el.exportJson.addEventListener("click", exportFindingsJSON);
if (el.clearFindings) el.clearFindings.addEventListener("click", clearAllFindings);

window.addEventListener("hashchange", route);
setMode("fade");
loadFindings();
loadIndex().then(() => { renderFeed(); route(); });
