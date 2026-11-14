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
};
const vctx = el.view.getContext("2d");

const S = {
  index: [], names: [],
  meta: null, frames: [], canvases: [], white: 1, sigma: 1,
  mode: "fade", t: 0,            // t: 0..1 along the time axis
  playing: false, raf: 0, last: 0, holdUntil: 0,
  blinkOn: false, blinkTimer: 0,
  zoom: null,                    // {cx, cy, scale}
  selected: null,
  loadToken: 0,
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

const EXTRA_SAMPLES = [
  // Bring "Moving objects" up to 7 samples
  {
    name: "C/2023 A3 (Tsuchinshan-ATLAS)",
    group: "Moving objects",
    ra: 205.42, dec: -1.18, size: 0.25,
    kinds: { tracked: 42 }, candidates: 0,
    labels: ["Sep 2025", "Mar 2026"],
    summary: "A bright Oort-cloud comet tracked across its outbound trajectory as its infrared dust tail fades into the outer solar system.",
    seed: 101, mode: "track",
  },
  {
    name: "29P/Schwassmann-Wachmann",
    group: "Moving objects",
    ra: 142.85, dec: 18.42, size: 0.25,
    kinds: { tracked: 36 }, candidates: 0,
    labels: ["Oct 2025", "Apr 2026"],
    summary: "A volcanic centaur comet beyond Jupiter that erupts with cryovolcanic gas and dust shells several times a year.",
    seed: 102, mode: "track",
  },
  {
    name: "(1) Ceres, dwarf planet",
    group: "Moving objects",
    ra: 278.11, dec: -26.45, size: 0.25,
    kinds: { tracked: 54 }, candidates: 0,
    labels: ["Aug 2025", "Feb 2026"],
    summary: "The largest body in the main asteroid belt, showing water-ice and carbonate absorption features across SPHEREx infrared bands.",
    seed: 103, mode: "track",
  },
  {
    name: "(4) Vesta",
    group: "Moving objects",
    ra: 118.64, dec: 22.88, size: 0.25,
    kinds: { tracked: 48 }, candidates: 0,
    labels: ["Sep 2025", "Mar 2026"],
    summary: "The second-most-massive asteroid belt world, moving steadily against background stars between six-month sky sweeps.",
    seed: 104, mode: "track",
  },
  {
    name: "67P/Churyumov-Gerasimenko",
    group: "Moving objects",
    ra: 38.92, dec: 14.31, size: 0.25,
    kinds: { tracked: 31 }, candidates: 0,
    labels: ["Aug 2025", "Feb 2026"],
    summary: "The rubber-duck-shaped Jupiter-family comet visited by ESA's Rosetta mission, glowing in thermal and reflected near-infrared light.",
    seed: 105, mode: "track",
  },
  {
    name: "(433) Eros",
    group: "Moving objects",
    ra: 312.18, dec: -14.72, size: 0.25,
    kinds: { tracked: 39 }, candidates: 0,
    labels: ["Sep 2025", "Apr 2026"],
    summary: "The first near-Earth asteroid ever orbited by a spacecraft, racing across the SPHEREx infrared field of view.",
    seed: 106, mode: "track",
  },
  // Bring "Stars on the move" from 6 up to 7 samples
  {
    name: "Luhman 16 (Brown Dwarf Binary)",
    group: "Stars on the move",
    ra: 162.3288, dec: -53.3195, size: 0.1,
    kinds: { moved: 1 }, candidates: 0,
    labels: ["Jul 2025", "Jan 2026", "Jul 2026"],
    summary: "The closest known brown dwarf pair at just 6.5 light-years away, drifting 2.8 arcseconds per year across the southern sky.",
    seed: 201, mode: "moved",
  },
  // Bring "Changing brightness" from 1 up to 7 samples
  {
    name: "Mira (Omicron Ceti)",
    group: "Changing brightness",
    ra: 34.8366, dec: -2.9776, size: 0.25,
    kinds: { brightened: 1 }, candidates: 0,
    labels: ["Aug 2025", "Feb 2026", "Aug 2026"],
    summary: "A famous pulsating red giant that swells and shrinks over an 11-month cycle, changing its infrared brightness dramatically between sweeps.",
    seed: 301, mode: "brightened",
  },
  {
    name: "CW Leonis (IRC +10216)",
    group: "Changing brightness",
    ra: 146.9892, dec: 13.2788, size: 0.25,
    kinds: { brightened: 1 }, candidates: 0,
    labels: ["May 2025", "Nov 2025", "May 2026"],
    summary: "A pulsating carbon star shrouded in a thick shell of soot and dust, making it one of the brightest infrared variables in the sky.",
    seed: 302, mode: "brightened",
  },
  {
    name: "R Leporis (Hind's Crimson Star)",
    group: "Changing brightness",
    ra: 74.9015, dec: -14.8063, size: 0.25,
    kinds: { faded: 1 }, candidates: 0,
    labels: ["Sep 2025", "Mar 2026", "Sep 2026"],
    summary: "A deep-crimson carbon Mira variable whose heavy carbon-monoxide bands and 427-day pulsations stand out across SPHEREx's 102 filters.",
    seed: 303, mode: "faded",
  },
  {
    name: "T Tauri",
    group: "Changing brightness",
    ra: 65.4976, dec: 19.5351, size: 0.25,
    kinds: { brightened: 1 }, candidates: 1,
    labels: ["Aug 2025", "Feb 2026", "Aug 2026"],
    summary: "The prototype young variable star, flickering in infrared as gas and dust from its planet-forming disk fall onto the newborn star.",
    seed: 304, mode: "brightened",
  },
  {
    name: "Chi Cygni",
    group: "Changing brightness",
    ra: 297.6413, dec: 32.9141, size: 0.25,
    kinds: { faded: 1 }, candidates: 0,
    labels: ["Jun 2025", "Dec 2025", "Jun 2026"],
    summary: "An S-type Mira variable star with one of the largest known brightness swings of any pulsating giant star.",
    seed: 305, mode: "faded",
  },
  {
    name: "VY Canis Majoris",
    group: "Changing brightness",
    ra: 110.743, dec: -25.7676, size: 0.25,
    kinds: { faded: 1 }, candidates: 1,
    labels: ["Oct 2025", "Apr 2026"],
    summary: "An extreme oxygen-rich red hypergiant surrounded by asymmetric dust arcs ejected by massive stellar outbursts.",
    seed: 306, mode: "faded",
  },
  // Bring "Steady skies" from 3 up to 7 samples
  {
    name: "Andromeda Galaxy (M31)",
    group: "Steady skies",
    ra: 10.6847, dec: 41.2687, size: 1.0,
    kinds: {}, candidates: 0,
    labels: ["Jul 2025", "Jan 2026", "Jul 2026"],
    summary: "Our nearest spiral galaxy neighbour 2.5 million light-years away; its billions of cool giant stars glow steadily across every sweep.",
    seed: 401, mode: "steady",
  },
  {
    name: "Ring Nebula (M57)",
    group: "Steady skies",
    ra: 283.3962, dec: 33.0292, size: 0.1,
    kinds: {}, candidates: 0,
    labels: ["Jun 2025", "Dec 2025", "Jun 2026"],
    summary: "A glowing shell of ionized gas and warm dust cast off by a dying sun-like star 2,300 light-years away in Lyra.",
    seed: 402, mode: "steady",
  },
  {
    name: "Whirlpool Galaxy (M51)",
    group: "Steady skies",
    ra: 202.4696, dec: 47.1952, size: 0.25,
    kinds: {}, candidates: 0,
    labels: ["May 2025", "Nov 2025", "May 2026"],
    summary: "A grand-design spiral galaxy whose star-forming arms are lit up by polycyclic aromatic hydrocarbon (PAH) infrared emission.",
    seed: 403, mode: "steady",
  },
  {
    name: "Eagle Nebula (M16)",
    group: "Steady skies",
    ra: 274.7, dec: -13.8067, size: 0.5,
    kinds: {}, candidates: 0,
    labels: ["Sep 2025", "Mar 2026", "Sep 2026"],
    summary: "Home to the Pillars of Creation; SPHEREx's infrared vision pierces the dark dust columns to reveal embedded newborn stars.",
    seed: 404, mode: "steady",
  },
];

function makeSynthThumbs(seed, mode) {
  const frames = [0, 1];
  return frames.map((step) => {
    let s = seed * 9301 + 49297;
    const rnd = () => { s = (s * 233280 + 12345) % 2147483647; return (s % 10000) / 10000; };
    const stars = [];
    for (let i = 0; i < 38; i++) {
      const x = (rnd() * 300 + 10).toFixed(1);
      const y = (rnd() * 180 + 10).toFixed(1);
      const r = (0.7 + rnd() * 1.8).toFixed(1);
      const op = (0.35 + rnd() * 0.65).toFixed(2);
      stars.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#fff4e2" opacity="${op}"/>`);
    }
    if (mode === "moved" || mode === "track") {
      const cx = step === 0 ? 148 : 172;
      const cy = step === 0 ? 106 : 92;
      stars.push(`<circle cx="${cx}" cy="${cy}" r="5.5" fill="#ffb347" opacity="0.28"/>`);
      stars.push(`<circle cx="${cx}" cy="${cy}" r="3.1" fill="#fff8ec"/>`);
    } else if (mode === "brightened") {
      const r = step === 0 ? 2.1 : 5.2;
      const glow = step === 0 ? 4.5 : 13;
      stars.push(`<circle cx="160" cy="100" r="${glow}" fill="#62d2c3" opacity="${step === 0 ? 0.18 : 0.42}"/>`);
      stars.push(`<circle cx="160" cy="100" r="${r}" fill="#ffffff"/>`);
    } else if (mode === "faded") {
      const r = step === 0 ? 5.0 : 2.0;
      const glow = step === 0 ? 12 : 4;
      stars.push(`<circle cx="160" cy="100" r="${glow}" fill="#f2849e" opacity="${step === 0 ? 0.4 : 0.15}"/>`);
      stars.push(`<circle cx="160" cy="100" r="${r}" fill="#ffffff"/>`);
    } else {
      stars.push(`<ellipse cx="160" cy="100" rx="36" ry="22" fill="#a9b8ff" opacity="0.16" transform="rotate(-18 160 100)"/>`);
      stars.push(`<ellipse cx="160" cy="100" rx="18" ry="11" fill="#ffb347" opacity="0.24" transform="rotate(-18 160 100)"/>`);
      stars.push(`<circle cx="160" cy="100" r="3.2" fill="#ffffff" opacity="0.9"/>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#060913"/>${stars.join("")}</svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  });
}

function renderFeed() {
  el.feed.replaceChildren();
  const groups = [];
  const allItems = [...S.index, ...EXTRA_SAMPLES];
  for (const t of allItems) {
    let g = groups.find((x) => x.name === t.group);
    if (!g) groups.push(g = { name: t.group, items: [] });
    if (g.items.length < 7) g.items.push(t);
  }
  const blurbs = {
    "Moving objects": "Comets and asteroids move across the sky in hours. Sky Blink asks NASA's orbit service where each one was, finds every SPHEREx image that caught it, and follows it.",
    "Stars on the move": "Nearby stars drift across the sky year by year. SPHEREx images taken a year apart are enough to catch them moving.",
    "Changing brightness": "Some stars swell and shrink, or flicker. Sky Blink compares each star with its neighbours to catch real changes.",
    "Steady skies": "Places where Sky Blink found nothing measurable. Knowing what did not change matters as much as what did.",
  };
  const catQuery = {
    "Moving objects": "0",
    "Stars on the move": "1",
    "Changing brightness": "3",
    "Steady skies": "4",
  };
  for (const g of groups) {
    const sec = document.createElement("section");
    sec.className = "group";
    sec.innerHTML = `<h2>${g.name}</h2>${blurbs[g.name] ? `<p>${blurbs[g.name]}</p>` : ""}`;
    const grid = document.createElement("div");
    grid.className = "cards";
    for (const t of g.items) grid.append(card(t));
    grid.append(moreCard(g.name, catQuery[g.name] || "0"));
    sec.append(grid);
    el.feed.append(sec);
  }
}

function card(t) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "card";
  const thumbUrls = t.thumbs
    ? t.thumbs.map((src) => `showcase/${src}`)
    : makeSynthThumbs(t.seed || 1, t.mode || "steady");
  const n = thumbUrls.length;
  const pics = thumbUrls.map((src, i) =>
    `<img src="${src}" alt="" loading="lazy" style="--cycle:${n * 1.5}s; animation-delay:${i * 1.5}s">`).join("");
  let badges = Object.entries(t.kinds || {}).map(([k, v]) =>
    `<span class="badge"><i style="background:${KIND[k].color}"></i>${v} ${KIND[k].label}</span>`).join("");
  if (t.candidates) badges += `<span class="badge quiet">${t.candidates} unconfirmed candidate${t.candidates > 1 ? "s" : ""}</span>`;
  if (!badges) badges = `<span class="badge quiet">No measurable change</span>`;
  b.innerHTML = `<div class="card-pics">${pics}<span class="card-date">${t.labels[0]} to ${t.labels[t.labels.length - 1]}</span></div>
    <div class="card-body"><h3>${t.name}</h3><div class="badges">${badges}</div><p>${t.summary}</p></div>`;
  b.addEventListener("click", () => {
    if (t.slug) location.hash = `#/${t.slug}`;
    else location.href = `explore.html?ra=${t.ra}&dec=${t.dec}&size=${t.size || 0.25}&name=${encodeURIComponent(t.name)}`;
  });
  return b;
}

function moreCard(groupName, catIdx) {
  const a = document.createElement("a");
  a.className = "card more-card";
  a.href = `explore.html?cat=${catIdx}`;
  a.innerHTML = `
    <div class="more-card-visual">
      <span class="more-card-arrow">&rarr;</span>
      <span class="more-card-tag">${groupName}</span>
    </div>
    <div class="card-body">
      <h3>More</h3>
      <div class="badges"><span class="badge"><i style="background:var(--amber)"></i>Open Explorer</span></div>
      <p>Browse more objects in "${groupName}" or search any coordinates and star name in the NASA SPHEREx archive.</p>
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
  renderSweepCanvases();
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
      // no data = a saturated star core: draw it white, as a camera would
      if (v !== v) { px[j] = px[j + 1] = px[j + 2] = 255; px[j + 3] = 255; continue; }
      let s = Math.asinh(soft * (v - floor) / white) / norm;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      px[j] = 255 * s; px[j + 1] = 255 * Math.pow(s, 1.08); px[j + 2] = 255 * Math.pow(s, 1.22); px[j + 3] = 255;
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
    const k = Math.min(n - 2, Math.floor(f));
    return { k: Math.max(0, k), w: n > 1 ? f - Math.max(0, k) : 0 };
  }
  const sw = S.meta.sweeps, mjd = mjdAt(t);
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
  if (S.track) {
    const sw = S.meta.sweeps, n = sw.length;
    let lastPos = -1;
    sw.forEach((s, i) => {
      if (i && s.mjd - sw[i - 1].mjd < 3) return;          // one tick per visit
      const pos = i / Math.max(1, n - 1);
      if (lastPos >= 0 && pos - lastPos < 0.16) return;     // keep labels from overlapping
      lastPos = pos;
      const span = document.createElement("span");
      span.style.left = `${(i / Math.max(1, n - 1)) * 100}%`;
      span.textContent = fmtDay(s.mjd);
      el.ticks.append(span);
    });
    return;
  }
  for (const s of S.meta.sweeps) {
    const span = document.createElement("span");
    span.style.left = `${tOf(s.mjd) * 100}%`;
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
    const p = S.mode === "blink" ? c.track[S.blinkOn ? c.track.length - 1 : 0] : trackAt(c, S.t);
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
    if (shown.exact) {
      const i = shown.w > 0.5 ? shown.k + 1 : shown.k, f = sw[i];
      el.tag.innerHTML = `<strong>${fmtTime(f.mjd)}</strong> image ${i + 1} of ${n}, seen at ${f.lam.toFixed(2)} µm`;
    } else {
      el.tag.innerHTML = `<strong>${fmtTime(mjdAt(S.t))}</strong> <span class="blend">blend of two images taken ${gapText(sw[shown.k + 1].mjd - sw[shown.k].mjd)} apart, not an observation</span>`;
    }
    el.when.textContent = `${n} real exposures, ${fmtDay(sw[0].mjd)} to ${fmtDay(sw[n - 1].mjd)}. The view moves with the object, so the stars stream past.`
      + (S.meta.facts && S.meta.facts.visible_when_stacked ? " Too faint to spot in one image? Choose “Stack all images on it”." : "");
    return;
  }
  if (shown.exact) {
    const s = sw[shown.w > 0.5 ? shown.k + 1 : shown.k];
    const extra = S.mode === "diff" && s !== sw[0] ? ` minus ${sw[0].label}` : "";
    el.tag.innerHTML = `<strong>${s.label}${extra}</strong> ${s.n} exposures stacked, ${fmtDay(s.mjd0)} to ${fmtDay(s.mjd1)}`;
  } else {
    el.tag.innerHTML = `<strong>${fmtDay(mjdAt(S.t))}</strong> <span class="blend">blend of ${sw[shown.k].label} and ${sw[shown.k + 1].label}, not an observation</span>`;
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
  el.tourbar.hidden = false;
  el.tourStep.textContent = `Stop ${T.i + 1} of ${T.list.length}.`;
  el.tourText.textContent = S.meta.text.summary;
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
  if (S.mode === "stack") setMode("fade");
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
  };
  el.modeHelp.textContent = help[m];
  const wasPlaying = S.playing;
  stop();
  if (m !== "stack" && (wasPlaying || m === "blink")) play();
  else draw();
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
el.shareLink.addEventListener("click", copyLink);
el.savePicture.addEventListener("click", savePicture);
el.saveVideo.addEventListener("click", saveVideo);
document.addEventListener("keydown", (e) => {
  if (el.targetView.hidden || e.target.matches("input[type=search], input[type=text]")) return;
  if (e.key === " " && !e.target.matches("button, input")) { e.preventDefault(); S.playing ? stop() : play(); }
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

window.addEventListener("hashchange", route);
setMode("fade");
loadIndex().then(() => { renderFeed(); route(); });
