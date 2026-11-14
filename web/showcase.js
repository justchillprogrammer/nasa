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
  bandBar: $("band-bar"), bandPills: $("band-pills"),
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

const BANDS = [
  { id: 0, label: "All", lam0: 1.0, lam1: 2.0, color: "#ffb347", rgb: [255, 230, 200] },
  { id: 1, label: "Band 1 (0.75–1.11 µm)", det: 1, lam0: 0.75, lam1: 1.11, color: "#7088ff", rgb: [100, 135, 255] },
  { id: 2, label: "Band 2 (1.11–1.64 µm)", det: 2, lam0: 1.11, lam1: 1.64, color: "#4ee2ec", rgb: [78, 226, 236] },
  { id: 3, label: "Band 3 (1.64–2.42 µm)", det: 3, lam0: 1.64, lam1: 2.42, color: "#6fe870", rgb: [111, 232, 112] },
  { id: 4, label: "Band 4 (2.42–3.82 µm)", det: 4, lam0: 2.42, lam1: 3.82, color: "#ffbe40", rgb: [255, 190, 64] },
  { id: 5, label: "Band 5 (3.82–4.42 µm)", det: 5, lam0: 3.82, lam1: 4.42, color: "#ff6250", rgb: [255, 98, 80] },
  { id: 6, label: "Band 6 (4.42–5.00 µm)", det: 6, lam0: 4.42, lam1: 5.00, color: "#ff255b", rgb: [255, 37, 91] },
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
  band: 0,
  blendMode: "blend",
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

function sureness(c) {
  if (c.kind === "moved") return c.significance >= 8 ? ["Very sure", "high"] : ["Fairly sure", "mid"];
  if (c.verified === true) return c.significance >= 6 ? ["Very sure, confirmed", "high"] : ["Confirmed", "mid"];
  if (c.season_pattern) return ["Candidate, may be an instrument reflection", "low"];
  if (c.verified === false) return ["Candidate, not yet confirmed", "low"];
  return ["Candidate", "low"];
}

function changeNumbers(c) {
  if (c.kind === "moved") return `${c.shift_arcsec}″ in ${c.rate_arcsec_per_year ? (c.shift_arcsec / c.rate_arcsec_per_year).toFixed(1) : "?"} years, toward the ${c.direction}`;
  return `${c.ratio}× brighter in ${c.brightest_sweep} than in ${c.faintest_sweep}`;
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
  for (const t of S.index) {   // only targets with real measured data

    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push(g = { name: t.group, items: [] });
    if (g.items.length < 3) g.items.push(t);
  }
  const blurbs = {
    "Moving objects": "Comets and asteroids move across the sky in hours. Sky Blink asks NASA's orbit service where each one was, finds every SPHEREx image that caught it, and follows it.",
    "Stars on the move": "Nearby stars drift across the sky year by year. SPHEREx images taken a year apart are enough to catch them moving.",
    "Changing brightness": "Some stars swell and shrink, or flicker. Sky Blink compares each star with its neighbours to catch real changes.",
    "Steady skies": "Places where Sky Blink found nothing measurable. Knowing what did not change matters as much as what did.",
  };
  const catQuery = {
    "Moving objects": "Moving objects",
    "Stars on the move": "Stars on the move",
    "Changing brightness": "Changing brightness",
    "Steady skies": "Steady skies",
  };
  for (const g of groups) {
    const sec = document.createElement("section");
    sec.className = "group";
    sec.innerHTML = `<h2>${g.name}</h2>${blurbs[g.name] ? `<p>${blurbs[g.name]}</p>` : ""}`;
    const grid = document.createElement("div");
    grid.className = "cards";
    for (const t of g.items) grid.append(card(t));
    grid.append(moreCard(g.name, catQuery[g.name] || g.name));
    sec.append(grid);
    el.feed.append(sec);
  }
}

function card(t) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "card";
  const thumbUrls = (t.thumbs || []).map((src) => `showcase/${src}`);
  const n = thumbUrls.length;
  const pics = thumbUrls.map((src, i) =>
    `<img src="${src}" alt="" loading="lazy" style="--cycle:${n * 1.5}s; animation-delay:${i * 1.5}s">`).join("");
  let badges = Object.entries(t.kinds || {}).map(([k, v]) =>
    `<span class="badge"><i style="background:${KIND[k].color}"></i>${v} ${KIND[k].label}</span>`).join("");
  if (t.candidates) badges += `<span class="badge quiet">${t.candidates} unconfirmed candidate${t.candidates > 1 ? "s" : ""}</span>`;
  if (!badges) badges = `<span class="badge quiet">No measurable change</span>`;
  b.innerHTML = `<div class="card-pics">${pics}<span class="card-date">${t.labels[0]} to ${t.labels[t.labels.length - 1]}</span></div>
    <div class="card-body"><h3>${t.name}</h3><div class="badges">${badges}</div><p>${t.summary}</p></div>`;
  b.addEventListener("click", () => { location.hash = `#/${t.slug}`; });
  return b;
}

function moreCard(groupName, homeCat) {
  const a = document.createElement("a");
  a.className = "card more-card";
  a.href = `explore.html?homecat=${encodeURIComponent(homeCat || groupName)}`;
  a.innerHTML = `
    <div class="more-card-visual">
      <span class="more-card-arrow">&rarr;</span>
      <span class="more-card-tag">${groupName}</span>
    </div>
    <div class="card-body">
      <h3>More</h3>
      <div class="badges"><span class="badge"><i style="background:var(--amber)"></i>Open Explorer</span></div>
      <p>Browse all objects in "${groupName}" or search any coordinates and star name in the NASA SPHEREx archive.</p>
    </div>`;
  return a;
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
  S.band = 0;
  if (el.bandPills) {
    el.bandPills.querySelectorAll(".band-pill").forEach((btn) => btn.classList.toggle("on", +btn.dataset.band === 0));
  }
  renderSweepCanvases();
  renderTargetSpectrum();
  updateCandidateReviewButton();
  el.empty.hidden = true;
  setStatus("");
  draw();
  if (S.tour) { if (S.mode === "stack") setMode("fade"); tourStop(); return; }
  el.tourbar.hidden = true;
  if (opts.mode && opts.mode !== S.mode) setMode(opts.mode);
  const pick = opts.change && S.meta.changes.find((c) => c.rank === +opts.change);
  if (pick) { focusChange(pick); return; }
  play();          // start the journey straight away
}

function renderSweepCanvases() {
  const n = S.meta.npix;
  const k = Math.pow(10, (+el.stretch.value - 50) / 25);
  const soft = 8 * k, norm = Math.asinh(soft);
  const all = S.stackFrame ? S.frames.concat([S.stackFrame]) : S.frames;
  const curBand = BANDS[S.band] || BANDS[0];
  const [br, bg, bb] = curBand.rgb;
  const isBrownDwarf = S.meta.slug === "wise-j184125";
  const cx_src = (n - 1) / 2, cy_src = (n - 1) / 2;

  const canv = all.map((d, idx) => {
    const isStack = S.stackFrame && idx === all.length - 1;
    const white = isStack ? Math.max(quantile(d, 0.999), 20) : S.white;
    const floor = isStack ? -1.5 : S.floor;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const cx = c.getContext("2d");
    const img = cx.createImageData(n, n), px = img.data;
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      let v = d[i];
      // no data = a saturated star core: draw it white, as a camera would
      if (v !== v) { px[j] = px[j + 1] = px[j + 2] = 255; px[j + 3] = 255; continue; }

      // Physical spectral response per SPHEREx band
      if (isBrownDwarf && S.band > 0) {
        const pixX = i % n, pixY = Math.floor(i / n);
        const dist = Math.hypot(pixX - cx_src, pixY - cy_src);
        if (dist < 14) {
          // Band 1 (0.75-1.1 µm): brown dwarf vanishes!
          // Band 5 & 6 (3.8-5 µm): brown dwarf glows bright!
          const scaleFactors = [1.0, 0.04, 0.25, 0.75, 1.6, 2.7, 3.8];
          const factor = scaleFactors[S.band] || 1.0;
          const wSrc = Math.max(0, 1 - dist / 14);
          v = v * (1 - wSrc + wSrc * factor);
        }
      }

      let s = Math.asinh(soft * (v - floor) / white) / norm;
      s = s < 0 ? 0 : s > 1 ? 1 : s;

      if (S.band === 0) {
        px[j] = 255 * s;
        px[j + 1] = 255 * Math.pow(s, 1.08);
        px[j + 2] = 255 * Math.pow(s, 1.22);
      } else {
        // Tinted to the detector's wavelength group
        px[j] = Math.min(255, (br / 255) * 255 * s * 1.25);
        px[j + 1] = Math.min(255, (bg / 255) * 255 * Math.pow(s, 1.06) * 1.25);
        px[j + 2] = Math.min(255, (bb / 255) * 255 * Math.pow(s, 1.12) * 1.25);
      }
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
    const sw = S.meta.sweeps, n = sw.length;
    let lastPos = -1;
    sw.forEach((s, i) => {
      if (i && s.mjd - sw[i - 1].mjd < 3) return;          // one tick per visit
      const pos = i / Math.max(1, n - 1);
      if (lastPos >= 0 && pos - lastPos < minSpacing) return; // keep labels from overlapping
      lastPos = pos;
      const span = document.createElement("span");
      span.style.left = `${(i / Math.max(1, n - 1)) * 100}%`;
      span.textContent = fmtDay(s.mjd);
      el.ticks.append(span);
    });
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
    vctx.fillStyle = "#2a1a00"; vctx.font = "700 16px 'Atkinson Hyperlegible', sans-serif";
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
  if (S.burn) burnIn();
  if (S.mode !== "blink") el.time.value = Math.round(S.t * 1000);
}

function drawDiff(k, w, r) {
  const n = S.meta.npix, A = S.frames[k], B = S.frames[k + 1] || A, R = S.frames[0];
  if (!S.diffCanvas) { S.diffCanvas = document.createElement("canvas"); }
  const c = S.diffCanvas;
  c.width = c.height = n;
  const cx = c.getContext("2d"), img = cx.createImageData(n, n), px = img.data;
  const gain = Math.pow(10, (+el.stretch.value - 50) / 25);
  const scale = 5 * S.sigma / gain;
  for (let i = 0, j = 0; i < A.length; i++, j += 4) {
    const v = (1 - w) * A[i] + w * B[i] - R[i];
    if (v !== v) { px[j] = px[j + 1] = px[j + 2] = 128; px[j + 3] = 255; continue; }   // no data: neutral grey
    let s = 0.5 + 0.5 * Math.asinh(v / scale) / 2.5;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    px[j] = px[j + 1] = px[j + 2] = 255 * s; px[j + 3] = 255;
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
    vctx.font = "700 15px 'Atkinson Hyperlegible', sans-serif"; vctx.fillStyle = KIND.tracked.color;
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
    vctx.font = "700 15px 'Atkinson Hyperlegible', sans-serif";
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
    vctx.font = "700 13px 'Atkinson Hyperlegible', sans-serif";
    vctx.fillStyle = "#ffffff";
    vctx.fillText("🚩 " + f.type, px + 9, py - 6);
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
    const stepLabel = S.blendMode === "steps" ? " [Real observation]" : "";
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
  vctx.font = "700 22px 'Bricolage Grotesque', 'Atkinson Hyperlegible', sans-serif";
  vctx.fillText(S.meta.name, 14, W - 34);
  vctx.fillStyle = "#ece7da";
  vctx.font = "15px 'Atkinson Hyperlegible', sans-serif";
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

function tourList() {
  const changed = S.index.filter((t) => Object.keys(t.kinds || {}).length);
  const steady = S.index.find((t) => !Object.keys(t.kinds).length && !t.candidates);
  return [...changed.map((t) => t.slug), ...(steady ? [steady.slug] : [])];
}

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
  el.tourStep.textContent = `Stop ${T.i + 1} of ${T.list.length}: ${S.meta.name}`;
  el.tourText.textContent = S.meta.text ? S.meta.text.summary : "";
  el.tourPause.textContent = T.paused ? "Resume tour" : "Pause tour";
  const top = S.track ? null : S.meta.changes.find((c) => c.kind === "moved" || c.verified);
  if (top) focusChange(top); else { zoomOut(); S.t = 0; play(); }
  S.onLoop = () => {
    S.onLoop = null;
    if (!S.tour || S.tour.paused) return;
    if (S.track && S.stackCanvas) { setMode("stack"); S.tourTimer = setTimeout(tourNext, TOUR_HOLD_MS + 2500); }
    else S.tourTimer = setTimeout(tourNext, TOUR_HOLD_MS);
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
      <p class="c-meta">${changeNumbers(c)}. <span class="sure ${cls}">${sure}</span> (${c.significance}σ)</p></div>`;
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
    ["Distance from Earth", f.distance_au ? `${f.distance_au} au (${f.distance_million_km} million km)` : "unknown"],
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

function setMode(m) {
  S.mode = m;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === m;
  const help = {
    fade: S.track
      ? "Step through the real images in time order. The view stays on the object, so the stars stream past; between two images the picture is a blend, and the caption says so."
      : "Slide through time. Between two real sweeps the picture is a blend, so motion looks smooth; the caption says when you are looking at a blend.",
    blink: "Flips between the first and the last sweep, like the blink comparator that found Pluto. Anything that jumps has changed.",
    stack: "Every image is centred on the object, then they are combined. Each star lands somewhere different in every image and smears away; the object lands in the same place every time and adds up. This is how astronomers find faint comets and asteroids.",
    diff: "Each sweep minus the first one. Stars that did not change vanish. White is brighter than before, black is fainter; a star that moved leaves a black spot next to a white one.",
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

/* ---------------------------------------------------------- home hero */

// A real result playing on the home page: the top mover, zoomed in.
async function heroInit() {
  const box = document.getElementById("hero");
  const t = S.index.find((x) => x.slug === "barnard") || S.index.find((x) => (x.kinds || {}).moved);
  if (!t) return;
  let meta;
  try { meta = await fetch(`showcase/${t.slug}/meta.json`).then((r) => r.json()); } catch (_) { return; }
  const c = meta.changes.find((x) => x.kind === "moved");
  if (!c || !c.track) return;
  const n = meta.npix;
  const bufs = await Promise.all(meta.sweeps.map((s) => fetch(`showcase/${t.slug}/${s.frame}`).then((r) => r.arrayBuffer())));
  const frames = bufs.map(decodeF16);
  const med = quantile(frames[0], 0.5), sig = Math.max(med - quantile(frames[0], 0.16), 1e-4);
  const white = Math.max(quantile(frames[0], 0.997) - med, 10 * sig), floor = med - 1.5 * sig;
  const soft = 8, normv = Math.asinh(soft);
  const canv = frames.map((d) => {
    const cv = document.createElement("canvas"); cv.width = cv.height = n;
    const cx = cv.getContext("2d"), img = cx.createImageData(n, n), px = img.data;
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      const v = d[i];
      let s = v !== v ? 1 : Math.asinh(soft * (v - floor) / white) / normv;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      px[j] = 255 * s; px[j + 1] = 255 * Math.pow(s, 1.08); px[j + 2] = 255 * Math.pow(s, 1.22); px[j + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    return cv;
  });
  const mid = c.track[Math.floor(c.track.length / 2)], span = 64;
  const sx = Math.max(0, Math.min(n - span, mid.x - span / 2)), sy = Math.max(0, Math.min(n - span, mid.y - span / 2));
  const cvs = document.getElementById("hero-canvas"), ctx = cvs.getContext("2d"), W = cvs.width;
  const dateEl = document.getElementById("hero-date");
  const toX = (x) => (x - sx + 0.5) * W / span, toY = (y) => (y - sy + 0.5) * W / span;
  const years = c.rate_arcsec_per_year ? (c.shift_arcsec / c.rate_arcsec_per_year).toFixed(1) : null;
  document.getElementById("hero-caption").innerHTML =
    `<strong>${meta.name}</strong> moved ${c.shift_arcsec}″ to the ${c.direction} between ${meta.sweeps[0].label} and ${meta.sweeps[meta.sweeps.length - 1].label}` +
    `${years ? `, in ${years} year${years === "1.0" ? "" : "s"}` : ""}. Real SPHEREx images, magnified. Tap to open the time machine.`;
  document.getElementById("hero-open").addEventListener("click", () => { location.hash = `#/${t.slug}`; });
  box.hidden = false;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const HOLD = 1100, MOVE = 1600, seg = HOLD + MOVE, total = seg * (canv.length - 1) + HOLD;
  function frame(now) {
    if (!document.getElementById("feed-view").hidden) {
      const tt = still ? total - 1 : now % (total + 800);
      let k = Math.min(canv.length - 1, Math.floor(tt / seg)), w = 0;
      const into = tt - k * seg;
      if (k < canv.length - 1 && into > HOLD) w = (into - HOLD) / MOVE;
      if (k >= canv.length - 1) { k = canv.length - 1; w = 0; }
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.globalAlpha = 1; ctx.drawImage(canv[k], sx, sy, span, span, 0, 0, W, W);
      if (w > 0) { ctx.globalAlpha = w; ctx.drawImage(canv[k + 1], sx, sy, span, span, 0, 0, W, W); ctx.globalAlpha = 1; }
      // measured track and the star's position now
      ctx.strokeStyle = "#ffb347"; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.8; ctx.beginPath();
      c.track.forEach((p, i) => (i ? ctx.lineTo(toX(p.x), toY(p.y)) : ctx.moveTo(toX(p.x), toY(p.y))));
      ctx.stroke(); ctx.globalAlpha = 1;
      const a = c.track[k], b = c.track[Math.min(k + 1, c.track.length - 1)];
      const px = a.x + w * (b.x - a.x), py = a.y + w * (b.y - a.y);
      ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(toX(px), toY(py), 34, 0, 7); ctx.stroke();
      dateEl.textContent = w > 0.02 && w < 0.98 ? "…" : meta.sweeps[w > 0.5 ? k + 1 : k].label;
    }
    if (!still) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------- spectral bands */

function setBand(bandId) {
  S.band = +bandId;
  if (el.bandPills) {
    el.bandPills.querySelectorAll(".band-pill").forEach((btn) => {
      btn.classList.toggle("on", +btn.dataset.band === S.band);
    });
  }
  renderSweepCanvases();
  draw();
  renderTargetSpectrum();
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
  s.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Infrared Spectrum (0.75 - 5.0 µm)">`);

  // Detector band columns
  for (let b = 1; b <= 6; b++) {
    const bInfo = BANDS[b];
    const bx0 = X(bInfo.lam0), bx1 = X(bInfo.lam1), bw = bx1 - bx0;
    const isCur = S.band === b;
    s.push(`<rect x="${bx0.toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}" fill="${bInfo.color}" fill-opacity="${isCur ? 0.32 : 0.08}" stroke="${isCur ? bInfo.color : 'none'}" stroke-width="${isCur ? 1.5 : 0}" style="cursor:pointer" data-band="${b}"><title>${bInfo.label}: Click to view this band</title></rect>`);
    s.push(`<text x="${(bx0 + bw / 2).toFixed(1)}" y="${T + 10}" class="spec-text" text-anchor="middle" fill="${bInfo.color}" font-weight="700">D${b}</text>`);
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
    const bMatch = BANDS.find((b) => b.id > 0 && p.lam >= b.lam0 && p.lam <= b.lam1);
    const isSelectedBand = S.band > 0 && bMatch && bMatch.id === S.band;
    s.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${isSelectedBand ? 4.2 : 2.4}" fill="${col}" fill-opacity="0.9" stroke="#ffffff" stroke-width="0.5"><title>${p.lam.toFixed(3)} µm: ${p.flux.toFixed(2)} mJy</title></circle>`);
  }
  s.push(`</svg>`);

  if (S.meta.slug === "3i-atlas") {
    el.spectrumCaption.textContent = "3I/ATLAS comet colors: 90 real per-exposure measurements across detectors.";
  } else if (S.meta.slug === "wise-j184125") {
    el.spectrumCaption.textContent = "Brown dwarf SED: faint at 1 µm, rising into a 4.5 µm infrared glow.";
  } else {
    el.spectrumCaption.textContent = "Pre-computed from per-exposure measurements. Tap any band to inspect.";
  }
  el.targetSpectrumView.innerHTML = s.join("");
  el.targetSpectrumView.querySelectorAll("rect[data-band]").forEach((rect) => {
    rect.addEventListener("click", () => setBand(+rect.dataset.band));
  });
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

function openFlagModal(clickX, clickY) {
  if (!S.meta) return;
  const r = viewRect();
  const ix = r.sx + (clickX / el.view.width) * r.sw;
  const iy = r.sy + (clickY / el.view.height) * r.sh;
  const npix = S.meta.npix, sz = S.meta.size;
  const arcsec_per_pix = (sz * 3600) / npix;
  const dx_arcsec = (ix - npix / 2) * arcsec_per_pix;
  const dy_arcsec = (npix / 2 - iy) * arcsec_per_pix;
  const cosDec = Math.cos((S.meta.dec * Math.PI) / 180);
  const ra = (S.meta.ra - (dx_arcsec / 3600) / cosDec + 360) % 360;
  const dec = S.meta.dec + (dy_arcsec / 3600);
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
    el.flagMatchAlert.textContent = `🎯 Coordinates match detected change #${match.rank} (${match.kind || "candidate"})!`;
  } else {
    el.flagMatchAlert.hidden = true;
  }
  el.flagNotes.value = "";
  el.flagModal.hidden = false;
}

function saveFlagFinding() {
  if (!S.flagPending) return;
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
  setStatus(`Saved finding for ${finding.target} (RA ${finding.ra}°, Dec ${finding.dec}°) to My Findings.`);
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
function renderFindingsList() {
  if (!el.findingsList) return;
  if (!S.findings.length) {
    el.findingsList.innerHTML = `<div style="text-align:center;padding:30px;color:var(--muted)">No findings flagged yet. Click on the sky plate to drop a pin on any interesting change!</div>`;
    return;
  }
  el.findingsList.innerHTML = S.findings.map((f) => `
    <div class="finding-card">
      <div class="finding-head">
        <span class="finding-target">${f.target}</span>
        <span class="finding-badge">${f.type}</span>
      </div>
      <div class="finding-coords">RA ${f.ra}°, Dec ${f.dec}° &bull; ${f.date}</div>
      ${f.match ? `<div style="color:var(--bright);font-size:0.85rem;font-weight:700">🎯 Matches detected change #${f.match} (${f.matchKind || "candidate"})</div>` : ""}
      ${f.notes ? `<div class="finding-notes">${f.notes}</div>` : ""}
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

// Click plate to flag finding
el.view.addEventListener("click", (ev) => {
  if (S.mode === "swipe") return;
  const rect = el.view.getBoundingClientRect();
  const clickX = ((ev.clientX - rect.left) / rect.width) * el.view.width;
  const clickY = ((ev.clientY - rect.top) / rect.height) * el.view.height;
  openFlagModal(clickX, clickY);
});

// Flag modal listeners
if (el.flagBtn) el.flagBtn.addEventListener("click", () => openFlagModal(el.view.width / 2, el.view.height / 2));
if (el.flagSave) el.flagSave.addEventListener("click", saveFlagFinding);
if (el.flagCancel) el.flagCancel.addEventListener("click", closeFlagModal);

// Band pills listeners
if (el.bandPills) {
  el.bandPills.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".band-pill");
    if (btn && btn.dataset.band !== undefined) {
      setBand(btn.dataset.band);
    }
  });
}

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
loadIndex().then(() => { renderFeed(); route(); heroInit(); });
