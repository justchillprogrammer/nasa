"use strict";

/* Sky Blink: loads SPHEREx frames of one patch of sky and lets the viewer
   step, blink and subtract them. All image stretching happens here, on raw
   brightness values, so every control responds instantly. */

const VISIBLE_PILLS = 8;

const HOMEPAGE_CATS = [
  "All",
  "Moving objects",
  "Stars on the move",
  "Changing brightness",
  "Steady skies",
];

// The targets featured on the home page (web/showcase/index.json). They are
// loaded at start-up, so the Explorer always lists exactly what the home page shows.
const FEATURED_CAT = "On the home page";

const ASTRO_CATS = [
  "All",
  FEATURED_CAT,
  "Fast-Moving Stars",
  "Brown Dwarfs & Cool Worlds",
  "Variable & Pulsating Stars",
  "Nebulae & Star Clusters",
  "Galaxies & Deep Sky",
];

const ASTRO_TO_HOME = {
  "Fast-Moving Stars": "Stars on the move",
  "Brown Dwarfs & Cool Worlds": "Stars on the move",
  "Variable & Pulsating Stars": "Changing brightness",
  "Nebulae & Star Clusters": "Steady skies",
  "Galaxies & Deep Sky": "Steady skies",
};

const HOME_TO_ASTRO = {
  "Moving objects": [FEATURED_CAT],
  "Stars on the move": [FEATURED_CAT, "Fast-Moving Stars", "Brown Dwarfs & Cool Worlds"],
  "Changing brightness": [FEATURED_CAT, "Variable & Pulsating Stars"],
  "Steady skies": [FEATURED_CAT, "Nebulae & Star Clusters", "Galaxies & Deep Sky"],
};

const PRESET_CATEGORIES = [
  {
    category: "Fast-Moving Stars",
    items: [
      { name: "Barnard's Star (10.3″/yr)", aka: ["GJ 699"], ra: 269.4462, dec: 4.7697, size: 0.1 },
      { name: "Kapteyn's Star (8.6″/yr)", aka: ["HD 33793"], ra: 77.9871, dec: -45.0607, size: 0.1 },
      { name: "Groombridge 1830 (7.0″/yr)", aka: ["HD 103095"], ra: 178.2823, dec: 37.6757, size: 0.1 },
      { name: "Lacaille 9352 (6.9″/yr)", aka: ["GJ 887"], ra: 346.5285, dec: -35.8433, size: 0.1 },
      { name: "Teegarden's Star (5.1″/yr)", aka: ["SO J025300.5+165258"], ra: 43.2796, dec: 16.854, size: 0.1 },
      { name: "Wolf 359 (4.7″/yr)", aka: ["CN Leonis"], ra: 164.0919, dec: 6.9946, size: 0.1 },
      { name: "61 Cygni (5.2″/yr)", aka: ["Bessel's Star", "Flying Star"], ra: 316.7248, dec: 38.7494, size: 0.1 },
      { name: "Alpha Centauri (3.7″/yr)", aka: ["Rigil Kentaurus"], ra: 219.9021, dec: -60.834, size: 0.25 },
      { name: "Arcturus (2.3″/yr)", aka: ["Alpha Bootis"], ra: 213.9153, dec: 19.1824, size: 0.25 },
      { name: "Epsilon Eridani (1.0″/yr)", aka: ["Ran"], ra: 53.2327, dec: -9.4583, size: 0.1 },
      { name: "Epsilon Indi (4.7″/yr)", aka: ["HD 209100"], ra: 330.8402, dec: -56.786, size: 0.1 },
      { name: "Kruger 60 (1.0″/yr)", aka: ["DO Cephei"], ra: 336.999, dec: 57.695, size: 0.1 },
      { name: "Lacaille 8760 (3.5″/yr)", aka: ["AX Microscopii"], ra: 319.313, dec: -38.867, size: 0.1 },
      { name: "Lalande 21185 (4.8″/yr)", aka: ["HD 95735", "GJ 411"], ra: 165.8341, dec: 35.9699, size: 0.1 },
      { name: "Luyten's Star (3.7″/yr)", aka: ["GJ 273"], ra: 111.8521, dec: 5.2258, size: 0.1 },
      { name: "Proxima Centauri (3.8″/yr)", aka: ["Alpha Centauri C"], ra: 217.429, dec: -62.6795, size: 0.1 },
      { name: "Ross 128 (1.4″/yr)", aka: ["FI Virginis"], ra: 176.935, dec: 0.8046, size: 0.1 },
      { name: "Ross 154 (0.7″/yr)", aka: ["V1216 Sagittarii"], ra: 282.4557, dec: -23.8362, size: 0.1 },
      { name: "Ross 248 (1.6″/yr)", aka: ["HH Andromedae"], ra: 355.479, dec: 44.178, size: 0.1 },
      { name: "Sirius (1.3″/yr)", aka: ["Alpha Canis Majoris"], ra: 101.2872, dec: -16.7161, size: 0.25 },
      { name: "Struve 2398 (2.2″/yr)", aka: ["GJ 725"], ra: 280.695, dec: 59.63, size: 0.1 },
      { name: "Tau Ceti (1.9″/yr)", aka: ["HD 10700"], ra: 26.017, dec: -15.9375, size: 0.1 },
      { name: "Van Maanen's Star (3.0″/yr)", aka: ["GJ 35"], ra: 12.291, dec: 5.388, size: 0.1 },
    ],
  },
  {
    category: "Brown Dwarfs & Cool Worlds",
    items: [
      { name: "Luhman 16 (Brown Dwarf Binary)", aka: ["WISE J104915.57-531906.1"], ra: 162.3288, dec: -53.3195, size: 0.1 },
      { name: "WISE 0855-0714 (Coldest Brown Dwarf)", aka: ["Y-dwarf"], ra: 133.7875, dec: -7.2444, size: 0.1 },
      { name: "TRAPPIST-1 (Ultra-cool Dwarf + 7 Planets)", aka: ["2MASS J23062928-0502285"], ra: 346.6223, dec: -5.0414, size: 0.1 },
      { name: "Gliese 229B (First T-Dwarf)", aka: ["GJ 229B"], ra: 92.6442, dec: -21.8646, size: 0.1 },
      { name: "Gliese 581 (Exoplanet Host)", aka: ["GJ 581"], ra: 229.8618, dec: -7.7223, size: 0.1 },
      { name: "SIMP J013656.5+093347 (Rogue Planet/Dwarf)", aka: ["SIMP0136"], ra: 24.2358, dec: 9.5631, size: 0.1 },
      { name: "2M1207 (Brown Dwarf + Giant Planet)", aka: ["2MASS J12073346-3932539"], ra: 181.8894, dec: -39.5483, size: 0.1 },
      { name: "51 Eridani b (Young Methane Planet Host)", aka: ["51 Eri"], ra: 69.4006, dec: -2.4735, size: 0.1 },
      { name: "Beta Pictoris (Debris Disk + Planets)", aka: ["HD 39060"], ra: 86.8212, dec: -51.0665, size: 0.25 },
      { name: "GD 165B (Prototype L-Dwarf)", aka: ["GD 165"], ra: 216.1625, dec: 9.2864, size: 0.1 },
      { name: "GJ 1214 (Sub-Neptune Host)", aka: ["Gliese 1214"], ra: 258.8289, dec: 4.9639, size: 0.1 },
      { name: "HN Pegasi B (Young T-Dwarf)", aka: ["HN Peg B"], ra: 326.13, dec: 14.771, size: 0.1 },
      { name: "K2-18 (Hycean World Candidate Host)", aka: ["EPIC 201912552"], ra: 172.5605, dec: 7.5884, size: 0.1 },
      { name: "KELT-9 (Ultra-Hot Jupiter Host)", aka: ["HD 195689"], ra: 307.8598, dec: 39.9388, size: 0.1 },
      { name: "LHS 1140 (Rocky Super-Earth Host)", aka: ["GJ 3053"], ra: 11.2472, dec: -15.2715, size: 0.1 },
      { name: "OTS 44 (Free-Floating Planetary Object)", aka: ["Chamaeleon Dwarf"], ra: 167.479, dec: -76.539, size: 0.1 },
      { name: "Teide 1 (First Verified Brown Dwarf)", aka: ["Pleiades Brown Dwarf"], ra: 56.8258, dec: 24.3758, size: 0.1 },
      { name: "TOI-700 (Habitable Zone Host)", aka: ["2MASS J06282325-6534456"], ra: 97.0968, dec: -65.5793, size: 0.1 },
    ],
  },
  {
    category: "Variable & Pulsating Stars",
    items: [
      { name: "WISE J184125.47+095436.5", aka: ["SPHEREx Confirmed Fading Star"], ra: 280.3562, dec: 9.9101, size: 0.1 },
      { name: "Mira (Omicron Ceti)", aka: ["Prototype Mira Variable"], ra: 34.8366, dec: -2.9776, size: 0.25 },
      { name: "CW Leonis (IRC +10216)", aka: ["Brightest Infrared Carbon Star"], ra: 146.9892, dec: 13.2788, size: 0.25 },
      { name: "R Leporis (Hind's Crimson Star)", aka: ["Carbon Mira Variable"], ra: 74.9015, dec: -14.8063, size: 0.25 },
      { name: "T Tauri (Young Variable Star)", aka: ["Prototype T Tauri"], ra: 65.4976, dec: 19.5351, size: 0.25 },
      { name: "Chi Cygni (S-Type Mira Variable)", aka: ["Large Amplitude Pulsator"], ra: 297.6413, dec: 32.9141, size: 0.25 },
      { name: "Algol (Beta Persei)", aka: ["Demon Star Eclipsing Binary"], ra: 47.0422, dec: 40.9556, size: 0.25 },
      { name: "Betelgeuse (Alpha Orionis)", aka: ["Red Supergiant Variable"], ra: 88.7929, dec: 7.4071, size: 0.25 },
      { name: "Delta Cephei (Prototype Cepheid)", aka: ["Standard Candle Variable"], ra: 337.2928, dec: 58.4152, size: 0.25 },
      { name: "Eta Aquilae (Cepheid Variable)", aka: ["Bezek"], ra: 298.1182, dec: 1.0057, size: 0.25 },
      { name: "Eta Carinae (Eruptive Hypergiant)", aka: ["Homunculus Nebula"], ra: 161.2648, dec: -59.6844, size: 0.25 },
      { name: "Garnet Star (Mu Cephei)", aka: ["Herschel's Garnet Star"], ra: 325.8769, dec: 58.78, size: 0.25 },
      { name: "La Superba (Y Canum Venaticorum)", aka: ["Carbon Star"], ra: 191.2825, dec: 45.4403, size: 0.25 },
      { name: "P Cygni (Luminous Blue Variable)", aka: ["34 Cygni"], ra: 304.4467, dec: 38.0329, size: 0.25 },
      { name: "Polaris (North Star Cepheid)", aka: ["Alpha Ursae Minoris"], ra: 37.9546, dec: 89.2641, size: 0.25 },
      { name: "R Coronae Borealis", aka: ["Reverse Nova Carbon Star"], ra: 237.143, dec: 28.158, size: 0.25 },
      { name: "R Hydrae (Mira Variable)", aka: ["HR 5080"], ra: 202.428, dec: -23.281, size: 0.25 },
      { name: "RR Lyrae (Prototype Cluster Variable)", aka: ["HD 182989"], ra: 291.3663, dec: 42.7844, size: 0.25 },
      { name: "SS Cygni (Dwarf Nova)", aka: ["Cataclysmic Variable"], ra: 325.678, dec: 43.586, size: 0.25 },
      { name: "UV Ceti (Prototype Flare Star)", aka: ["Luyten 726-8 B"], ra: 24.756, dec: -17.95, size: 0.1 },
      { name: "VY Canis Majoris (Red Hypergiant)", aka: ["VY CMa"], ra: 110.743, dec: -25.7676, size: 0.25 },
      { name: "W Hydrae (Asymptotic Giant Variable)", aka: ["W Hya"], ra: 207.258, dec: -28.367, size: 0.25 },
    ],
  },
  {
    category: "Nebulae & Star Clusters",
    items: [
      { name: "Crab Nebula (M1)", aka: ["Messier 1", "SN 1054"], ra: 83.633, dec: 22.0145, size: 0.25 },
      { name: "Orion Nebula (M42)", aka: ["Messier 42", "NGC 1976"], ra: 83.822, dec: -5.391, size: 0.5 },
      { name: "Pleiades (M45)", aka: ["Seven Sisters"], ra: 56.75, dec: 24.12, size: 0.5 },
      { name: "Ring Nebula (M57)", aka: ["Messier 57", "NGC 6720"], ra: 283.3962, dec: 33.0292, size: 0.1 },
      { name: "Eagle Nebula (M16)", aka: ["Pillars of Creation"], ra: 274.7, dec: -13.8067, size: 0.5 },
      { name: "Hercules Cluster (M13)", aka: ["Messier 13", "NGC 6205"], ra: 250.4235, dec: 36.4613, size: 0.25 },
      { name: "47 Tucanae (NGC 104)", aka: ["Globular Cluster"], ra: 6.0236, dec: -72.0813, size: 0.5 },
      { name: "Beehive Cluster (M44)", aka: ["Praesepe"], ra: 130.1, dec: 19.667, size: 1.0 },
      { name: "Bubble Nebula (NGC 7635)", aka: ["Caldwell 11"], ra: 350.1904, dec: 61.2017, size: 0.25 },
      { name: "Butterfly Cluster (M6)", aka: ["Messier 6"], ra: 265.083, dec: -32.253, size: 0.5 },
      { name: "Carina Nebula (NGC 3372)", aka: ["Eta Carinae Nebula"], ra: 160.9, dec: -59.87, size: 1.0 },
      { name: "Cat's Eye Nebula (NGC 6543)", aka: ["Caldwell 6"], ra: 269.6391, dec: 66.6331, size: 0.1 },
      { name: "Double Cluster (NGC 869/884)", aka: ["Perseus Double Cluster"], ra: 35.125, dec: 57.133, size: 0.5 },
      { name: "Dumbbell Nebula (M27)", aka: ["Messier 27"], ra: 299.9016, dec: 22.7211, size: 0.25 },
      { name: "Eskimo Nebula (NGC 2392)", aka: ["Clownface Nebula"], ra: 112.2949, dec: 20.9118, size: 0.1 },
      { name: "Flame Nebula (NGC 2024)", aka: ["Orion B"], ra: 85.429, dec: -1.85, size: 0.5 },
      { name: "Heart Nebula (IC 1805)", aka: ["Cassiopeia H II Region"], ra: 38.175, dec: 61.45, size: 1.0 },
      { name: "Helix Nebula (NGC 7293)", aka: ["Eye of God"], ra: 337.411, dec: -20.8372, size: 0.5 },
      { name: "Horsehead Nebula (Barnard 33)", aka: ["IC 434"], ra: 85.2479, dec: -2.4583, size: 0.25 },
      { name: "Hyades Cluster (Caldwell 41)", aka: ["Nearest Open Cluster"], ra: 66.75, dec: 15.87, size: 1.0 },
      { name: "Iris Nebula (NGC 7023)", aka: ["Caldwell 4"], ra: 315.379, dec: 68.163, size: 0.5 },
      { name: "Lagoon Nebula (M8)", aka: ["Messier 8"], ra: 270.925, dec: -24.38, size: 0.5 },
      { name: "North America Nebula (NGC 7000)", aka: ["Caldwell 20"], ra: 314.75, dec: 44.33, size: 1.0 },
      { name: "Omega Centauri (NGC 5139)", aka: ["Largest Globular Cluster"], ra: 201.697, dec: -47.4795, size: 0.5 },
      { name: "Omega Nebula (M17)", aka: ["Swan Nebula"], ra: 275.196, dec: -16.171, size: 0.5 },
      { name: "Owl Nebula (M97)", aka: ["Messier 97"], ra: 168.6988, dec: 55.019, size: 0.25 },
      { name: "Rosette Nebula (NGC 2237)", aka: ["Caldwell 49"], ra: 97.98, dec: 4.95, size: 1.0 },
      { name: "Tarantula Nebula (30 Doradus)", aka: ["NGC 2070"], ra: 84.6765, dec: -69.1009, size: 0.5 },
      { name: "Trifid Nebula (M20)", aka: ["Messier 20"], ra: 270.675, dec: -22.971, size: 0.5 },
      { name: "Veil Nebula (NGC 6960)", aka: ["Cygnus Loop"], ra: 311.4, dec: 30.71, size: 1.0 },
    ],
  },
  {
    category: "Galaxies & Deep Sky",
    items: [
      { name: "Andromeda Galaxy (M31)", aka: ["Messier 31", "NGC 224"], ra: 10.6847, dec: 41.2687, size: 1 },
      { name: "Whirlpool Galaxy (M51)", aka: ["Messier 51", "NGC 5194"], ra: 202.4696, dec: 47.1952, size: 0.25 },
      { name: "Cigar Galaxy (M82)", aka: ["Messier 82", "Starburst Galaxy"], ra: 148.9685, dec: 69.6797, size: 0.25 },
      { name: "Bode's Galaxy (M81)", aka: ["Messier 81", "NGC 3031"], ra: 148.8882, dec: 69.0653, size: 0.5 },
      { name: "Triangulum Galaxy (M33)", aka: ["Messier 33", "NGC 598"], ra: 23.4621, dec: 30.6602, size: 1 },
      { name: "Galactic Centre (Sgr A*)", aka: ["Sagittarius A*", "Milky Way Core"], ra: 266.4168, dec: -29.0078, size: 0.5 },
      { name: "Abell 2151 (Hercules Cluster)", aka: ["Galaxy Cluster"], ra: 241.3125, dec: 17.7485, size: 0.5 },
      { name: "Antennae Galaxies (NGC 4038/4039)", aka: ["Merging Galaxies"], ra: 180.4708, dec: -18.8675, size: 0.25 },
      { name: "Black Eye Galaxy (M64)", aka: ["Messier 64", "NGC 4826"], ra: 194.1821, dec: 21.6827, size: 0.25 },
      { name: "Cartwheel Galaxy (ESO 350-40)", aka: ["Collisional Ring Galaxy"], ra: 9.4275, dec: -33.716, size: 0.1 },
      { name: "Centaurus A (NGC 5128)", aka: ["Active Radio Galaxy"], ra: 201.3651, dec: -43.0191, size: 0.5 },
      { name: "Fireworks Galaxy (NGC 6946)", aka: ["Caldwell 12"], ra: 308.718, dec: 60.1539, size: 0.25 },
      { name: "Large Magellanic Cloud (LMC)", aka: ["Satellite Galaxy"], ra: 80.8938, dec: -69.7561, size: 1.0 },
      { name: "Messier 87 (Virgo A)", aka: ["M87", "Black Hole Jet Galaxy"], ra: 187.7059, dec: 12.3911, size: 0.25 },
      { name: "NGC 1300 (Barred Spiral Galaxy)", aka: ["Eridanus Spiral"], ra: 49.9212, dec: -19.4114, size: 0.25 },
      { name: "Pinwheel Galaxy (M101)", aka: ["Messier 101", "NGC 5457"], ra: 210.8024, dec: 54.3489, size: 0.5 },
      { name: "Sculptor Galaxy (NGC 253)", aka: ["Silver Coin Galaxy"], ra: 11.888, dec: -25.2882, size: 0.5 },
      { name: "Small Magellanic Cloud (SMC)", aka: ["NGC 292"], ra: 13.1867, dec: -72.8286, size: 1.0 },
      { name: "Sombrero Galaxy (M104)", aka: ["Messier 104", "NGC 4594"], ra: 189.9976, dec: -11.6231, size: 0.25 },
      { name: "Southern Pinwheel Galaxy (M83)", aka: ["Messier 83", "NGC 5236"], ra: 204.2538, dec: -29.8658, size: 0.5 },
      { name: "Stephan's Quintet (HCG 92)", aka: ["Compact Galaxy Group"], ra: 339.014, dec: 33.96, size: 0.1 },
      { name: "Sunflower Galaxy (M63)", aka: ["Messier 63", "NGC 5055"], ra: 198.9555, dec: 42.0293, size: 0.25 },
    ],
  },
];
const PRESETS = PRESET_CATEGORIES.flatMap((c) => c.items);
// Filled by loadFeatured(); kept out of PRESETS so the name search is unchanged.
const FEATURED = { category: FEATURED_CAT, items: [] };

async function loadFeatured() {
  try {
    const r = await fetch("showcase/index.json");
    if (!r.ok) return;
    const idx = await r.json();
    FEATURED.items = (idx.targets || []).map((t) => {
      const item = {
        name: t.name, aka: t.group ? [t.group] : [], note: t.note || "", homeCat: t.group, slug: t.slug, featured: true,
        // the home page's time machine for this target
        link: `index.html#/${encodeURIComponent(t.slug)}`,
      };
      if (Number.isFinite(t.ra) && Number.isFinite(t.dec)) {
        item.ra = t.ra; item.dec = t.dec; item.size = 0.25; item.link = null;
      }
      return item;
    });
  } catch (_) { /* the other categories still work */ }
}

// Moving objects (comets) have no fixed position: open them in the home page's
// time machine, which follows them. Everything else opens here.
function openPreset(o, size) {
  if (o.link) { location.href = o.link; return; }
  lookAt(o.ra, o.dec, size ?? o.size, null, o.name);
}

function presetWhere(o) {
  return o.link ? "Follows its path · opens in the time machine" : fmtCoord(o.ra, o.dec);
}
const EPOCH_COLORS = ["#ffb347", "#62d2c3", "#f2849e", "#a9b8ff", "#d6e36b", "#ff8f5a"];
const FRAMES_PER_SWEEP = 2;
const CANDIDATES_PER_SWEEP = 5;   // extras, in case some only half-cover the view
const DEFAULT_LAM = 1.35;   // mid-detector, so views are rarely cut by a detector edge
const NODATA = [58, 42, 85];

const $ = (id) => document.getElementById(id);
const els = {
  form: $("target-form"), coords: $("coords"), suggest: $("coords-suggest"), size: $("size"),
  filterHome: $("filter-home"), filterAstro: $("filter-astro"), presets: $("presets"),
  morePanel: $("cat-more-panel"), moreQ: $("cat-more-q"), moreBtn: $("cat-more-btn"),
  moreClose: $("cat-more-close"), moreList: $("cat-more-list"),
  status: $("status"), view: $("view"), overlay: $("overlay"), empty: $("plate-empty"),
  caption: $("caption"), capEpoch: $("cap-epoch"), capDate: $("cap-date"), capLam: $("cap-lam"),
  readout: $("readout"), plate: $("plate"),
  prev: $("prev"), next: $("next"), play: $("play"), blink: $("blink"),
  diff: $("diff"), negative: $("negative"), reticle: $("reticle"), diffHelp: $("diff-help"),
  ref: $("ref"), speed: $("speed"), stretch: $("stretch"),
  timeline: $("timeline"), spectrum: $("spectrum"), specStatus: $("spec-status"),
};
const ctx = els.view.getContext("2d");

const state = {
  ra: null, dec: null, size: 0.25, npix: 384, lam: DEFAULT_LAM,
  epochs: [], exposures: [],
  frames: [],            // frames chosen for the current wavelength
  cur: 0, ref: 0,
  mode: "still",         // "still" | "play" | "blink"
  timer: null, blinkOnRef: false,
  white: 1,              // shared white level so frames are comparable
  run: 0,                // increases with every new target
  load: 0,               // increases with every new set of frames
  points: [], specTotal: 0, specDone: false, specPartial: null, specAbort: null,
};

/* ---------------------------------------------------------- coordinates */

function parseCoords(text) {
  const t = text.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!t) return null;
  const sexa = /[:hdms°'"]/i.test(t);
  if (!sexa) {
    const p = t.split(" ").map(Number);
    if (p.length === 2 && p.every(Number.isFinite)) return check(p[0], p[1]);
    return null;
  }
  const m = t.match(/^([0-9.:hms ]+?)\s+([+-]?[0-9.:d°'"ms ]+)$/i);
  if (!m) return null;
  const parts = (s) => s.replace(/[hdms°'":]/gi, " ").trim().split(/\s+/).map(Number);
  const a = parts(m[1]), d = parts(m[2]);
  if (![...a, ...d].every(Number.isFinite)) return null;
  const ra = (a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600) * 15;
  const sign = m[2].trim().startsWith("-") ? -1 : 1;
  const dec = sign * (Math.abs(d[0]) + (d[1] || 0) / 60 + (d[2] || 0) / 3600);
  return check(ra, dec);
  function check(ra, dec) {
    return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? { ra, dec } : null;
  }
}

const fmtCoord = (ra, dec) => `${ra.toFixed(4)} ${dec >= 0 ? "+" : ""}${dec.toFixed(4)}`;

function fmtDate(iso) {
  const d = new Date(iso + "Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) +
    ", " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}
const fmtDay = (iso) => new Date(iso + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function setStatus(msg, kind = "") {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

/* ---------------------------------------------------------- loading */

async function lookAt(ra, dec, size, lam, label) {
  stopMotion();
  const found = document.getElementById("found");
  if (found) found.replaceChildren();
  const run = ++state.run;
  Object.assign(state, { ra, dec, size, lam: lam || DEFAULT_LAM, npix: size >= 1 ? 512 : 384,
    label: label || null,
    frames: [], exposures: [], epochs: [], points: [], specTotal: 0, specDone: false, specPartial: null });
  if (state.specAbort) state.specAbort.abort();
  els.coords.value = label ? `${label} (${fmtCoord(ra, dec)})` : fmtCoord(ra, dec);
  els.size.value = String(size);
  els.timeline.replaceChildren();
  els.spectrum.replaceChildren();
  els.specStatus.textContent = "";
  els.caption.hidden = true;
  els.empty.hidden = false;
  els.empty.textContent = "Finding images of this spot…";
  ctx.clearRect(0, 0, els.view.width, els.view.height);
  drawOverlay();
  syncUrl();
  setStatus("Finding SPHEREx images of this spot. This usually takes a few seconds.");

  const SEARCH_TIMEOUT_MS = 25000;
  let res = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);
    try {
      if (attempt > 1) {
        setStatus("The first search did not finish; retrying (attempt 2 of 2)…");
      }
      const r = await fetch(`/api/search?ra=${ra}&dec=${dec}`, { signal: ac.signal });
      clearTimeout(timer);
      if (!r.ok) {
        const errDetail = (await r.json().catch(() => ({}))).detail || r.statusText;
        throw new Error(errDetail);
      }
      res = await r.json();
      break;
    } catch (e) {
      clearTimeout(timer);
      if (run !== state.run) return;
      if (attempt === 1) {
        setStatus("The search did not finish; retrying in a moment…");
        await new Promise((ok) => setTimeout(ok, 1000));
        if (run !== state.run) return;
        continue;
      }
      // Say what actually happened: our timeout, or the server's own reason.
      const why = e.name === "AbortError"
        ? "The search took longer than 25 seconds, so Sky Blink stopped waiting."
        : `The search failed: ${e.message}.`;
      els.empty.textContent = "No images loaded.";
      setStatus(`${why} Try again, or pick one of the ready-made spots below.`, "error");
      return;
    }
  }
  if (run !== state.run) return;
  state.exposures = res.exposures;
  state.epochs = res.epochs;
  if (!res.exposures.length) {
    els.empty.textContent = "No images loaded.";
    setStatus("SPHEREx has no public images of this spot yet. Try another position.", "error");
    return;
  }
  const n = res.exposures.length, s = res.epochs.length;
  const prefix = state.label ? `${state.label}: ` : "";
  setStatus(`${prefix}${n} images of this spot, from ${s} ${s === 1 ? "sweep" : "sweeps"} of the sky.`, "quiet");
  await loadFrames(run);
  if (run === state.run) loadSpectrum(run);
}

/* Pick, for each sweep, the exposures that saw the spot closest to the
   chosen wavelength. Only those are comparable like for like. */
function chooseFrames(lam) {
  // Half the view in detector pixels, with room for the detector's tilt.
  const half = state.size * 3600 / 6.15 / 2 * 1.25;
  const edgeDist = (e) => Math.min(e.x, e.y, 2039 - e.x, 2039 - e.y);
  const whole = (e) => edgeDist(e) > half;
  const chosen = [];
  for (const ep of state.epochs) {
    const allInSweep = state.exposures.filter((e) => e.epoch === ep.index)
      .map((e) => ({ e, off: Math.abs(e.lam - lam), cut: whole(e) ? 0 : 1, edge: edgeDist(e) }));
    let inSweep = allInSweep.filter((o) => o.off <= Math.max(2.2 * o.e.dlam, 0.06));
    if (!inSweep.length) {
      inSweep = allInSweep.filter((o) => o.off <= 0.18);
    }
    inSweep.sort((a, b) => a.cut - b.cut || a.off - b.off || b.edge - a.edge);
    chosen.push({
      epoch: ep.index,
      primary: inSweep.slice(0, FRAMES_PER_SWEEP).map((o) => o.e).sort((a, b) => a.mjd - b.mjd),
      backups: inSweep.slice(FRAMES_PER_SWEEP, CANDIDATES_PER_SWEEP).map((o) => o.e),
    });
  }
  return chosen;
}

async function fetchCutoutFrame(f) {
  for (let attempt = 0; attempt < 3 && f.status !== "ready"; attempt++) {
    try {
      const keyParam = f.exp.key ? `&key=${encodeURIComponent(f.exp.key)}` : "";
      const q = `ra=${state.ra}&dec=${state.dec}&size=${state.size}&npix=${state.npix}&id=${encodeURIComponent(f.exp.id)}${keyParam}`;
      const r = await fetch(`/api/cutout?${q}`);
      if (!r.ok) throw new Error(r.status + " " + r.statusText);
      const meta = JSON.parse(r.headers.get("X-Frame-Meta") || "{}");
      const data = new Float32Array(await r.arrayBuffer());
      Object.assign(f, { data, meta, status: "ready", ...frameStats(data) });
    } catch (e) {
      f.status = "failed";
      f.error = e.message;
      if (attempt < 2) await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1)));
    }
  }
}

async function loadFrames(run) {
  stopMotion();
  const load = ++state.load;
  const stale = () => run !== state.run || load !== state.load;
  const sweepChoices = chooseFrames(state.lam);
  const initialFrames = [];
  for (const sc of sweepChoices) {
    for (const exp of sc.primary) initialFrames.push({ exp, data: null, status: "loading" });
  }
  state.frames = initialFrames;
  state.cur = 0;
  state.ref = 0;
  buildTimeline();
  buildRefSelect();
  updateButtons();
  syncUrl();
  els.caption.hidden = true;
  els.empty.hidden = false;
  if (!initialFrames.length) {
    ctx.clearRect(0, 0, els.view.width, els.view.height);
    els.empty.textContent = "No image of this spot at that wavelength. Select another wavelength in the chart.";
    return;
  }
  let got = 0;
  els.empty.textContent = `Loading images… 0 of ${initialFrames.length}`;

  // Fetch primary frames and render progressively as soon as the first frame arrives!
  await Promise.all(initialFrames.map(async (f, idx) => {
    await fetchCutoutFrame(f);
    if (stale()) return;
    got++;
    if (f.status === "ready") {
      const ready = readyIndexes();
      if (ready.length === 1) {
        state.ref = idx;
        state.cur = idx;
      } else {
        state.ref = ready[0];
        state.cur = ready[ready.length - 1];
      }
      updateWhite();
      refreshThumbs();
      buildRefSelect();
      render();
      updateButtons();
    } else {
      els.empty.textContent = `Loading images… ${got} of ${initialFrames.length}`;
    }
  }));
  if (stale()) return;

  // Only fetch backups for any sweep where a primary frame failed or was <35% covered.
  const backupTasks = [];
  for (const sc of sweepChoices) {
    const goodInSweep = state.frames.filter(
      (f) => f.exp.epoch === sc.epoch && f.status === "ready" && (f.meta?.coverage ?? 1) > 0.35
    );
    const needed = FRAMES_PER_SWEEP - goodInSweep.length;
    if (needed > 0 && sc.backups.length > 0) {
      for (const bexp of sc.backups.slice(0, needed)) {
        const bf = { exp: bexp, data: null, status: "loading" };
        backupTasks.push(fetchCutoutFrame(bf).then(() => bf));
      }
    }
  }
  if (backupTasks.length) {
    const extras = await Promise.all(backupTasks);
    if (stale()) return;
    const allCandidates = [...state.frames, ...extras];
    const kept = [];
    for (const ep of state.epochs) {
      const ok = allCandidates
        .filter((f) => f.status === "ready" && f.exp.epoch === ep.index && f.meta.coverage > 0.3)
        .sort((x, y) => (y.meta.coverage > 0.97) - (x.meta.coverage > 0.97)
          || (x.meta.coverage > 0.97 ? 0 : y.meta.coverage - x.meta.coverage)
          || Math.abs(x.exp.lam - state.lam) - Math.abs(y.exp.lam - state.lam))
        .slice(0, FRAMES_PER_SWEEP);
      kept.push(...ok.sort((x, y) => x.exp.mjd - y.exp.mjd));
    }
    if (kept.length) state.frames = kept;
  } else {
    const kept = state.frames.filter((f) => f.status === "ready" && (f.meta?.coverage ?? 1) > 0.3);
    if (kept.length) state.frames = kept;
  }

  const ready = readyIndexes();
  if (!ready.length) {
    els.empty.hidden = false;
    els.empty.textContent = initialFrames.some((f) => f.status === "failed")
      ? `The images could not be loaded (${initialFrames.find((f) => f.error)?.error || "no reply"}). Select "Look here" to retry.`
      : "No usable image of this spot at that wavelength. Select another wavelength in the chart.";
    return;
  }
  state.ref = ready[0];
  state.cur = ready[ready.length - 1];   // default comparison: first against last, the longest gap
  updateWhite();
  buildTimeline();
  refreshThumbs();
  buildRefSelect();
  render();
  updateButtons();
}

/* Sky level, noise and a bright reference level of one frame. */
function frameStats(data) {
  const step = Math.max(1, Math.floor(data.length / 20000));
  const sample = [];
  for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) sample.push(data[i]);
  if (sample.length < 10) return { bg: 0, sigma: 1, bright: 1 };
  sample.sort((a, b) => a - b);
  const q = (p) => sample[Math.min(sample.length - 1, Math.floor(p * sample.length))];
  const bg = q(0.5);
  const sigma = Math.max((q(0.5) - q(0.16)), 1e-6);   // lower half is clean sky
  return { bg, sigma, bright: Math.max(q(0.995) - bg, 5 * sigma) };
}

/* Soften a frame by about one detector pixel. SPHEREx pixels are coarse, so
   a star lands differently on the pixel grid each visit; without this every
   star would leave a false black-and-white smear in the difference view. */
function smoothed(f) {
  if (f.smooth) return f.smooth;
  const n = state.npix, src = f.data;
  const sigma = Math.max(0.8, 1.3 * 6.15 / (state.size * 3600 / n));
  const rad = Math.ceil(2.5 * sigma), w = [];
  for (let i = -rad; i <= rad; i++) w.push(Math.exp(-i * i / (2 * sigma * sigma)));
  const pass = (a, dx, dy) => {
    const out = new Float32Array(a.length);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let sum = 0, ws = 0;
      for (let k = -rad; k <= rad; k++) {
        const xx = x + k * dx, yy = y + k * dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const v = a[yy * n + xx];
        if (v === v) { sum += v * w[k + rad]; ws += w[k + rad]; }
      }
      out[y * n + x] = src[y * n + x] === src[y * n + x] && ws > 0 ? sum / ws : NaN;
    }
    return out;
  };
  f.smooth = pass(pass(src, 1, 0), 0, 1);
  return f.smooth;
}

/* How much brighter the stars are overall in one frame than in another.
   The two frames never sit at exactly the same wavelength, so every star is
   a little brighter or fainter; dividing this out leaves real changes. */
function matchGain(frame, refFrame) {
  const key = refFrame.exp.id;
  if (frame.gains && frame.gains[key]) return frame.gains[key];
  const a = smoothed(frame), b = smoothed(refFrame), ratios = [];
  const cut = 6 * refFrame.sigma;
  for (let i = 0; i < a.length; i += 3) {
    const rb = b[i] - refFrame.bg;
    if (rb > cut && a[i] === a[i]) ratios.push((a[i] - frame.bg) / rb);
  }
  ratios.sort((x, y) => x - y);
  let g = ratios.length > 30 ? ratios[ratios.length >> 1] : 1;
  if (!(g > 0.3 && g < 3)) g = 1;
  (frame.gains ||= {})[key] = g;
  return g;
}

function updateWhite() {
  const b = state.frames.filter((f) => f.status === "ready").map((f) => f.bright).sort((a, c) => a - c);
  if (b.length) state.white = b[Math.floor(b.length / 2)];
}

/* ---------------------------------------------------------- drawing */

function paint(canvasCtx, n, frame, refFrame, opts) {
  const img = canvasCtx.createImageData(n, n);
  const px = img.data;
  const d = refFrame ? smoothed(frame) : frame.data;
  const k = Math.pow(10, (opts.stretch - 50) / 25);          // slider -> gain
  if (refFrame) {
    const r = smoothed(refFrame);
    const gain = matchGain(frame, refFrame);
    const scale = 4 * Math.hypot(frame.sigma, refFrame.sigma) / k;
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      const v = (d[i] - frame.bg) / gain - (r[i] - refFrame.bg);
      if (!Number.isFinite(v)) { px[j] = NODATA[0]; px[j + 1] = NODATA[1]; px[j + 2] = NODATA[2]; px[j + 3] = 255; continue; }
      let s = 0.5 + 0.5 * Math.asinh(v / scale) / 2.5;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const g = 255 * s;
      px[j] = g; px[j + 1] = g; px[j + 2] = g; px[j + 3] = 255;
    }
  } else {
    const soft = 8 * k, norm = Math.asinh(soft);
    const white = state.white, floor = frame.bg - 1.5 * frame.sigma;
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      const v = d[i];
      if (!Number.isFinite(v)) { px[j] = NODATA[0]; px[j + 1] = NODATA[1]; px[j + 2] = NODATA[2]; px[j + 3] = 255; continue; }
      let s = Math.asinh(soft * (v - floor) / white) / norm;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      if (opts.negative) s = 1 - s;
      // faint warm tint: this is infrared light
      px[j] = 255 * s; px[j + 1] = 255 * Math.pow(s, 1.08); px[j + 2] = 255 * Math.pow(s, 1.22); px[j + 3] = 255;
    }
  }
  canvasCtx.putImageData(img, 0, 0);
}

function shownIndex() {
  return state.mode === "blink" && state.blinkOnRef ? state.ref : state.cur;
}

function render() {
  const i = shownIndex();
  const f = state.frames[i];
  if (!f || f.status !== "ready") return;
  if (els.view.width !== state.npix) { els.view.width = state.npix; els.view.height = state.npix; }
  const ref = state.frames[state.ref];
  const useDiff = els.diff.checked && state.mode !== "blink" && ref && ref.status === "ready" && i !== state.ref;
  paint(ctx, state.npix, f, useDiff ? ref : null, { stretch: +els.stretch.value, negative: els.negative.checked });
  els.empty.hidden = true;

  const ep = state.epochs[f.exp.epoch];
  els.caption.hidden = false;
  els.capEpoch.textContent = useDiff ? `${ep.label} minus ${state.epochs[ref.exp.epoch].label}` : ep.label;
  els.capEpoch.style.color = EPOCH_COLORS[f.exp.epoch % EPOCH_COLORS.length];
  els.capDate.textContent = fmtDate(f.exp.date);
  els.capLam.textContent = `${(f.meta.lam || f.exp.lam).toFixed(2)} µm infrared`;
  els.diffHelp.hidden = !els.diff.checked;
  for (const b of els.timeline.querySelectorAll(".thumb")) {
    b.setAttribute("aria-current", String(+b.dataset.i === i));
    b.classList.toggle("is-ref", +b.dataset.i === state.ref);
  }
  drawOverlay();
}

/* ---------------------------------------------------------- find changes */

const CHANGE_COLORS = { moved: "#ffb347", brightened: "#62d2c3", faded: "#f2849e", appeared: "#62d2c3", vanished: "#f2849e" };
const CHANGE_NOUN = { moved: "Moved", brightened: "Brightened", faded: "Faded", appeared: "Appeared", vanished: "Disappeared" };
state.found = null;

async function findChanges() {
  if (state.ra === null) return;
  const btn = $("find-changes"), box = $("found");
  const at = { ra: state.ra, dec: state.dec, size: Math.min(state.size, 0.5) };
  btn.disabled = true;
  box.innerHTML = "<p class='help'>Stacking every sweep and comparing them. This takes about a minute…</p>";
  try {
    const r = await fetch(`/api/changes?ra=${at.ra}&dec=${at.dec}&size=${at.size}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const res = await r.json();
    if (at.ra !== state.ra || at.dec !== state.dec) return;
    state.found = res;
    const texts = Object.fromEntries((res.text.items || []).map((i) => [i.rank, i.text]));
    box.innerHTML = `<p>${res.text.summary}</p>` + res.changes.map((c) =>
      `<div class="found-item"><b style="color:${CHANGE_COLORS[c.kind]}">${c.rank}. ${CHANGE_NOUN[c.kind]}.</b>${texts[c.rank] || ""}
       <br><small>${c.kind === "moved" ? "Measured motion" : c.season_pattern ? "Candidate: may be a reflection inside the instrument" : "Candidate: not double-checked in single images"}, ${c.significance}σ</small></div>`).join("")
      + `<p><small>${res.checked ? `Measured from ${res.checked.images_used} real images in ${res.sweeps.length} sweeps (${res.sweeps.map((w) => w.label).join(", ")})${res.checked.images_failed ? `; ${res.checked.images_failed} could not be read and were left out` : ""}. ` : ""}`
      + `${res.text.writer.startsWith("AI") ? "Text written by AI from the measurements; numbers checked." : "Text written automatically from the measurements."}</small></p>`;
    drawOverlay();
  } catch (e) {
    box.innerHTML = `<p class="help">Change detection did not finish (${e.message}). Select the button to try again.</p>`;
  } finally {
    btn.disabled = false;
  }
}
$("find-changes").addEventListener("click", findChanges);

function changeMarks(light) {
  const f = state.found;
  if (!f || Math.abs(f.ra - state.ra) > 1e-6 || Math.abs(f.dec - state.dec) > 1e-6) return [];
  const out = [];
  const cosd = Math.cos(state.dec * Math.PI / 180);
  for (const c of f.changes) {
    // sky position -> fraction of this view (north up, east left)
    let dra = c.ra - state.ra; if (dra > 180) dra -= 360; if (dra < -180) dra += 360;
    const fx = 50 - (dra * cosd / state.size) * 100, fy = 50 - ((c.dec - state.dec) / state.size) * 100;
    if (fx < 0 || fx > 100 || fy < 0 || fy > 100) continue;
    const col = CHANGE_COLORS[c.kind];
    out.push(`<circle cx="${fx}" cy="${fy}" r="3" fill="none" stroke="${col}" stroke-width="0.5"${c.kind === "moved" ? "" : ' stroke-dasharray="1 0.8"'}/>`);
    out.push(`<text x="${fx + 2.4}" y="${fy - 2.4}" font-size="3" fill="${col}" font-family="Atkinson Hyperlegible, sans-serif">${c.rank}</text>`);
  }
  return out;
}

function drawOverlay() {
  const parts = [];
  const light = els.negative.checked && !els.diff.checked ? "#1b2440" : "#ece7da";
  if (els.reticle.checked) {
    const c = 50, a = 2.2, b = 5;
    for (const [x1, y1, x2, y2] of [[c - b, c, c - a, c], [c + a, c, c + b, c], [c, c - b, c, c - a], [c, c + a, c, c + b]])
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffb347" stroke-width="0.35"/>`);
  }
  if (state.ra !== null && state.frames.length) {
    // scale bar: a round number of arcminutes near a fifth of the view
    const arcmin = state.size * 60;
    const nice = [0.5, 1, 2, 5, 10, 15, 30].reduce((p, v) => (Math.abs(v - arcmin / 5) < Math.abs(p - arcmin / 5) ? v : p));
    const w = (nice / arcmin) * 100;
    parts.push(`<line x1="4" y1="6" x2="${4 + w}" y2="6" stroke="${light}" stroke-width="0.5"/>`);
    parts.push(`<text x="4" y="4.6" font-size="2.6" fill="${light}" font-family="Atkinson Hyperlegible, sans-serif">${nice} arcmin</text>`);
    // compass: north up, east left
    parts.push(`<path d="M93 12 L93 5 M93 12 L86 12" stroke="${light}" stroke-width="0.35" fill="none"/>`);
    parts.push(`<text x="92.1" y="4.2" font-size="2.6" fill="${light}" font-family="Atkinson Hyperlegible, sans-serif">N</text>`);
    parts.push(`<text x="83.2" y="12.9" font-size="2.6" fill="${light}" font-family="Atkinson Hyperlegible, sans-serif">E</text>`);
  }
  parts.push(...changeMarks(light));
  els.overlay.innerHTML = parts.join("");
}

/* ---------------------------------------------------------- timeline */

function buildTimeline() {
  els.timeline.replaceChildren();
  for (const ep of state.epochs) {
    const wrap = document.createElement("div");
    const head = document.createElement("div");
    head.className = "sweep-head";
    head.innerHTML = `<i class="dot" style="background:${EPOCH_COLORS[ep.index % EPOCH_COLORS.length]}"></i>` +
      `<strong>${ep.label}</strong><span>${ep.n} images at all wavelengths</span>`;
    wrap.append(head);
    const row = document.createElement("div");
    row.className = "thumbs";
    state.frames.forEach((f, i) => {
      if (f.exp.epoch !== ep.index) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "thumb loading";
      b.dataset.i = i;
      b.title = `${fmtDate(f.exp.date)}, ${f.exp.lam.toFixed(2)} µm`;
      b.innerHTML = `<canvas width="64" height="64"></canvas><span class="t-date">${fmtDay(f.exp.date)}</span>`;
      b.addEventListener("click", () => { stopMotion(); state.cur = i; render(); });
      row.append(b);
    });
    if (!row.children.length) {
      const none = document.createElement("p");
      none.className = "sweep-none";
      none.textContent = "No image at this wavelength in this sweep.";
      wrap.append(none);
    } else wrap.append(row);
    els.timeline.append(wrap);
  }
}

function refreshThumbs() {
  for (const b of els.timeline.querySelectorAll(".thumb")) {
    const f = state.frames[+b.dataset.i];
    if (!f) continue;
    b.classList.toggle("loading", f.status === "loading");
    b.classList.toggle("failed", f.status === "failed");
    if (f.status === "failed") b.querySelector(".t-date").textContent = "not loaded";
    if (f.status === "ready" && !b.dataset.drawn) {
      b.dataset.drawn = "1";
      // downsample by picking pixels: thumbnails only need the gist
      const n = 64, step = state.npix / n, small = new Float32Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
        small[y * n + x] = f.data[Math.floor(y * step) * state.npix + Math.floor(x * step)];
      paint(b.querySelector("canvas").getContext("2d"), n, { ...f, data: small }, null, { stretch: 55, negative: false });
    }
  }
}

function buildRefSelect() {
  els.ref.replaceChildren();
  state.frames.forEach((f, i) => {
    if (f.status === "failed") return;
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `${state.epochs[f.exp.epoch].label}, ${fmtDay(f.exp.date)}`;
    els.ref.append(o);
  });
  els.ref.value = String(state.ref);
}

/* ---------------------------------------------------------- motion */

function readyIndexes() {
  return state.frames.map((f, i) => (f.status === "ready" ? i : -1)).filter((i) => i >= 0);
}

function step(dir) {
  const ok = readyIndexes();
  if (!ok.length) return;
  const at = ok.indexOf(state.cur);
  state.cur = ok[(at + dir + ok.length) % ok.length];
  render();
}

function stopMotion() {
  clearInterval(state.timer);
  state.timer = null;
  state.mode = "still";
  state.blinkOnRef = false;
  updateButtons();
}

function start(mode) {
  const was = state.mode;
  stopMotion();
  if (was === mode) { render(); return; }
  if (readyIndexes().length < 2) return;
  if (mode === "blink" && state.cur === state.ref) step(1);
  state.mode = mode;
  const tick = () => {
    if (state.mode === "play") step(1);
    else { state.blinkOnRef = !state.blinkOnRef; render(); }
  };
  state.timer = setInterval(tick, +els.speed.value);
  updateButtons();
  render();
}

function updateButtons() {
  const many = readyIndexes().length > 1;
  for (const b of [els.prev, els.next, els.play, els.blink]) b.disabled = !many;
  els.play.textContent = state.mode === "play" ? "Pause" : "Play all images";
  els.blink.textContent = state.mode === "blink" ? "Stop blinking" : "Blink against reference";
  els.blink.classList.toggle("on", state.mode === "blink");
}

/* ---------------------------------------------------------- spectrum */

async function loadSpectrum(run) {
  const ac = new AbortController();
  state.specAbort = ac;
  els.specStatus.textContent = "Measuring the centre point in every image…";
  drawSpectrum();
  try {
    const r = await fetch(`/api/spectrum?ra=${state.ra}&dec=${state.dec}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exposures: state.exposures }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(r.statusText);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", seen = 0, last = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const p = JSON.parse(line);
        if (run !== state.run) return;
        if (p.total) state.specTotal = p.total;
        else if (p.done) { state.specDone = true; if (p.partial) state.specPartial = p.error || "the archive stopped answering"; }
        else { seen++; if (!p.skip) state.points.push(p); }
      }
      if (performance.now() - last > 250 || state.specDone) {
        last = performance.now();
        drawSpectrum();
        els.specStatus.textContent = state.specDone && state.specPartial
          ? `${state.points.length} measurements so far: ${state.specPartial}.`
          : state.specDone
          ? `${state.points.length} measurements. Dots are missing where the centre fell on a bad or saturated pixel.`
          : `Measured ${seen} of ${state.specTotal} images…`;
      }
    }
  } catch (e) {
    if (e.name !== "AbortError" && run === state.run)
      els.specStatus.textContent = "The brightness measurements did not finish. Reload the page to try again.";
  }
}

function drawSpectrum() {
  const W = 460, H = 250, L = 46, R = 10, T = 10, B = 34;
  const x0 = 0.7, x1 = 5.1;
  const pts = state.points;
  const fl = pts.map((p) => p.flux).sort((a, b) => a - b);
  let lo = 0, hi = 1;
  if (fl.length) {
    const q = (p) => fl[Math.min(fl.length - 1, Math.floor(p * fl.length))];
    hi = q(0.97) * 1.2; lo = Math.min(0, q(0.03));
    if (!(hi > lo)) hi = lo + 1;
  }
  const X = (l) => L + (l - x0) / (x1 - x0) * (W - L - R);
  const Y = (f) => T + (1 - (Math.min(Math.max(f, lo), hi) - lo) / (hi - lo)) * (H - T - B);
  const s = [];
  s.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Brightness of the centre point against infrared wavelength">`);
  const bw = Math.max(nearestWidth(state.lam), 0.03);
  s.push(`<rect class="band" x="${X(state.lam - bw / 2)}" y="${T}" width="${X(state.lam + bw / 2) - X(state.lam - bw / 2)}" height="${H - T - B}"/>`);
  s.push(`<line class="band-line" x1="${X(state.lam)}" y1="${T}" x2="${X(state.lam)}" y2="${H - B}"/>`);
  s.push(`<line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/><line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>`);
  for (let l = 1; l <= 5; l++) s.push(`<line class="axis" x1="${X(l)}" y1="${H - B}" x2="${X(l)}" y2="${H - B + 4}"/><text x="${X(l)}" y="${H - B + 16}" text-anchor="middle">${l}</text>`);
  s.push(`<text x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle">wavelength, micrometres</text>`);
  for (const f of niceTicks(lo, hi)) s.push(`<line class="axis" x1="${L - 4}" y1="${Y(f)}" x2="${L}" y2="${Y(f)}"/><text x="${L - 7}" y="${Y(f) + 4}" text-anchor="end">${fmtFlux(f)}</text>`);
  s.push(`<text transform="translate(11 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">brightness, mJy</text>`);
  for (const p of pts)
    s.push(`<circle cx="${X(p.lam).toFixed(1)}" cy="${Y(p.flux).toFixed(1)}" r="2.6" fill="${EPOCH_COLORS[p.epoch % EPOCH_COLORS.length]}" fill-opacity="0.85"/>`);
  s.push("</svg>");
  const legend = state.epochs.map((e) => `<span><i style="background:${EPOCH_COLORS[e.index % EPOCH_COLORS.length]}"></i>${e.label}</span>`).join("");
  els.spectrum.innerHTML = s.join("") + `<div class="legend">${legend}</div>`;
  const svg = els.spectrum.querySelector("svg");
  svg.addEventListener("click", (ev) => {
    const box = svg.getBoundingClientRect();
    const l = x0 + ((ev.clientX - box.left) / box.width * W - L) / (W - L - R) * (x1 - x0);
    if (l >= 0.74 && l <= 5.02) setWavelength(l);
  });
}

function nearestWidth(lam) {
  let best = null;
  for (const e of state.exposures) if (!best || Math.abs(e.lam - lam) < Math.abs(best.lam - lam)) best = e;
  return best ? best.dlam : 0.04;
}

function niceTicks(lo, hi) {
  const span = hi - lo, raw = span / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const stepv = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  const out = [];
  for (let v = Math.ceil(lo / stepv) * stepv; v <= hi + 1e-9; v += stepv) out.push(Math.abs(v) < 1e-12 ? 0 : v);
  return out;
}
const fmtFlux = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? +v.toFixed(1) : +v.toPrecision(2)).toString();

function setWavelength(lam) {
  // snap to the nearest wavelength this spot was actually seen at
  let best = null;
  for (const e of state.exposures) if (!best || Math.abs(e.lam - lam) < Math.abs(best.lam - lam)) best = e;
  if (!best) return;
  state.lam = +best.lam.toFixed(3);
  drawSpectrum();
  loadFrames(state.run);
}

/* ---------------------------------------------------------- wiring */

function syncUrl() {
  if (state.ra === null) return;
  const q = new URLSearchParams({ ra: state.ra.toFixed(5), dec: state.dec.toFixed(5), size: state.size, lam: state.lam });
  history.replaceState(null, "", "?" + q);
}

let currentHomeFilter = "All";
let currentAstroFilter = "All";
let moreSelectedIndex = -1;
let moreFilteredItems = [];

function getFilteredItems() {
  const all = [FEATURED, ...PRESET_CATEGORIES].flatMap((c) =>
    c.items.map((it) => ({
      ...it,
      astroCat: c.category,
      homeCat: it.homeCat || ASTRO_TO_HOME[c.category] || "Steady skies",
    }))
  );
  // A home-page target usually also sits in its own category: list it once,
  // as the home-page entry, unless that category is picked on its own.
  const near = (a, b) => a.ra !== undefined && b.ra !== undefined &&
    Math.abs(a.dec - b.dec) < 0.01 && Math.abs(((a.ra - b.ra + 540) % 360) - 180) < 0.01;
  const dedupe = currentAstroFilter === "All";
  return all.filter((it) => {
    if (dedupe && !it.featured && FEATURED.items.some((f) => near(f, it))) return false;
    const homeOk = currentHomeFilter === "All" || it.homeCat === currentHomeFilter;
    const astroOk = currentAstroFilter === "All" || it.astroCat === currentAstroFilter;
    return homeOk && astroOk;
  });
}

function renderFilterTabs() {
  if (els.filterHome) {
    els.filterHome.replaceChildren();
    HOMEPAGE_CATS.forEach((cat) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.role = "tab";
      const isOn = cat === currentHomeFilter;
      tab.className = "filter-tab" + (isOn ? " on" : "");
      tab.textContent = cat;
      tab.setAttribute("aria-selected", String(isOn));
      tab.addEventListener("click", () => {
        currentHomeFilter = cat;
        if (cat !== "All" && currentAstroFilter !== "All") {
          const allowed = HOME_TO_ASTRO[cat] || [];
          if (!allowed.includes(currentAstroFilter)) {
            currentAstroFilter = "All";
          }
        }
        applyFilters();
      });
      els.filterHome.append(tab);
    });
  }

  if (els.filterAstro) {
    els.filterAstro.replaceChildren();
    ASTRO_CATS.forEach((cat) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.role = "tab";
      const isOn = cat === currentAstroFilter;
      tab.className = "filter-tab" + (isOn ? " on" : "");
      tab.textContent = cat;
      tab.setAttribute("aria-selected", String(isOn));
      tab.addEventListener("click", () => {
        currentAstroFilter = cat;
        if (cat !== "All") {
          currentHomeFilter = ASTRO_TO_HOME[cat] || "All";
        }
        applyFilters();
      });
      els.filterAstro.append(tab);
    });
  }
}

function renderMoreList() {
  if (!els.moreList) return;
  const rawQ = els.moreQ ? els.moreQ.value.trim() : "";
  const q = normPrefix(rawQ);

  const filtered = getFilteredItems();
  // All objects in current selection sorted in strict alphabetical order (A -> Z)
  const alphaItems = [...filtered].sort((a, b) => a.name.localeCompare(b.name));

  if (!q) {
    moreFilteredItems = alphaItems.map((obj) => ({ obj, matchedAlias: null }));
  } else {
    const exactStart = [];
    const aliasStart = [];
    const wordStart = [];
    for (const o of alphaItems) {
      const nName = normPrefix(o.name);
      if (nName.startsWith(q)) {
        exactStart.push({ obj: o, matchedAlias: null });
        continue;
      }
      const matchingAlias = (o.aka || []).find((a) => normPrefix(a).startsWith(q));
      if (matchingAlias) {
        aliasStart.push({ obj: o, matchedAlias });
        continue;
      }
      const words = nName.split(/\s+/);
      if (words.some((w) => w.startsWith(q))) {
        wordStart.push({ obj: o, matchedAlias: null });
      }
    }
    moreFilteredItems = [...exactStart, ...aliasStart, ...wordStart];
  }

  els.moreList.replaceChildren();
  moreSelectedIndex = -1;

  if (!moreFilteredItems.length) {
    const emptyLi = document.createElement("div");
    emptyLi.className = "cat-more-empty";
    const filterDesc = currentAstroFilter !== "All" ? currentAstroFilter : (currentHomeFilter !== "All" ? currentHomeFilter : "selection");
    emptyLi.textContent = `No objects in "${filterDesc}" starting with "${rawQ}". Press Search to look it up across all catalogs (SIMBAD/NED).`;
    els.moreList.append(emptyLi);
    return;
  }

  moreFilteredItems.forEach((item) => {
    const o = item.obj;
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const sub = item.matchedAlias
      ? `${highlightPrefix(item.matchedAlias, rawQ)} · ${presetWhere(o)}`
      : `${(o.aka && o.aka[0]) ? o.aka[0] + " · " : ""}${presetWhere(o)}`;
    li.innerHTML = `<span>${highlightPrefix(o.name, rawQ)}</span><small>${sub}</small>`;
    if (o.note) li.title = o.note;
    li.addEventListener("click", () => {
      closeMorePanel();
      openPreset(o);
    });
    els.moreList.append(li);
  });
}

function openMorePanel() {
  if (!els.morePanel) return;
  const filterDesc = currentAstroFilter !== "All" ? currentAstroFilter : (currentHomeFilter !== "All" ? currentHomeFilter : "All Objects");
  els.morePanel.hidden = false;
  if (els.moreQ) {
    els.moreQ.value = "";
    els.moreQ.placeholder = `Search in ${filterDesc} (type A, An...)`;
  }
  const moreToggle = els.presets.querySelector(".more-btn");
  if (moreToggle) moreToggle.classList.add("on");
  renderMoreList();
  if (els.moreQ) setTimeout(() => els.moreQ.focus(), 20);
}

function closeMorePanel() {
  if (!els.morePanel) return;
  els.morePanel.hidden = true;
  const moreToggle = els.presets.querySelector(".more-btn");
  if (moreToggle) moreToggle.classList.remove("on");
}

function applyFilters() {
  renderFilterTabs();
  closeMorePanel();
  els.presets.replaceChildren();

  const items = getFilteredItems();
  const visible = items.slice(0, VISIBLE_PILLS);
  for (const p of visible) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.name;
    if (p.featured) { b.classList.add("featured"); b.title = (p.note ? p.note + " " : "") + (p.link ? "Opens in the time machine on the home page." : "Featured on the home page."); }
    b.addEventListener("click", () => {
      closeMorePanel();
      openPreset(p);
    });
    els.presets.append(b);
  }

  if (items.length > 0) {
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "more-btn";
    moreBtn.textContent = `More (${items.length}) ▾`;
    const filterDesc = currentAstroFilter !== "All" ? currentAstroFilter : (currentHomeFilter !== "All" ? currentHomeFilter : "all categories");
    moreBtn.title = `Show all ${items.length} objects in ${filterDesc} in alphabetical order`;
    moreBtn.addEventListener("click", () => {
      if (els.morePanel && !els.morePanel.hidden) closeMorePanel();
      else openMorePanel();
    });
    els.presets.append(moreBtn);
  }
}

if (els.moreQ) {
  els.moreQ.addEventListener("input", renderMoreList);
  els.moreQ.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeMorePanel();
      return;
    }
    const items = [...els.moreList.querySelectorAll("li")];
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!items.length) return;
      ev.preventDefault();
      moreSelectedIndex = (moreSelectedIndex + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === moreSelectedIndex)));
      if (items[moreSelectedIndex]) items[moreSelectedIndex].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (moreSelectedIndex >= 0 && moreFilteredItems[moreSelectedIndex]) {
        const o = moreFilteredItems[moreSelectedIndex].obj;
        closeMorePanel();
        openPreset(o);
      } else if (els.moreBtn) {
        els.moreBtn.click();
      }
    }
  });
}

if (els.moreBtn) {
  els.moreBtn.addEventListener("click", () => {
    if (moreFilteredItems.length) {
      const pick = moreSelectedIndex >= 0 ? moreFilteredItems[moreSelectedIndex].obj : moreFilteredItems[0].obj;
      closeMorePanel();
      openPreset(pick);
      return;
    }
    const raw = els.moreQ ? els.moreQ.value.trim() : "";
    if (raw) {
      closeMorePanel();
      els.coords.value = raw;
      els.form.requestSubmit();
    }
  });
}

if (els.moreClose) {
  els.moreClose.addEventListener("click", closeMorePanel);
}

/* ---------------------------------------------------------- prefix search helper */

let catalog = [...PRESETS.map((p) => ({ name: p.name, aka: [], ra: p.ra, dec: p.dec, size: p.size }))];
fetch("names.json")
  .then((r) => r.json())
  .then((d) => {
    if (!d || !Array.isArray(d.objects)) return;
    const seen = new Set(catalog.map((x) => x.name.toLowerCase()));
    for (const o of d.objects) {
      if (!seen.has(o.name.toLowerCase())) {
        catalog.push(o);
        seen.add(o.name.toLowerCase());
      }
    }
    catalog.sort((a, b) => a.name.localeCompare(b.name));
  })
  .catch(() => {});

function normPrefix(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9+.\- ]/g, "").trim();
}

function findPrefixMatches(rawQuery) {
  const q = normPrefix(rawQuery);
  if (!q) return [];
  // Ignore if user is typing pure coordinates
  if (/^[0-9.+\-\s:]+$/.test(q) && q.includes(" ")) return [];

  const exactStart = [];
  const aliasStart = [];
  const wordStart = [];

  for (const o of catalog) {
    const nName = normPrefix(o.name);
    if (nName.startsWith(q)) {
      exactStart.push({ obj: o, matchedAlias: null });
      continue;
    }
    const matchingAlias = (o.aka || []).find((a) => normPrefix(a).startsWith(q));
    if (matchingAlias) {
      aliasStart.push({ obj: o, matchedAlias });
      continue;
    }
    const words = nName.split(/\s+/);
    if (words.some((w) => w.startsWith(q))) {
      wordStart.push({ obj: o, matchedAlias: null });
    }
  }
  return [...exactStart, ...aliasStart, ...wordStart].slice(0, 10);
}

function highlightPrefix(text, q) {
  const cleanQ = q.trim();
  if (!cleanQ) return text;
  if (text.toLowerCase().startsWith(cleanQ.toLowerCase())) {
    return `<mark>${text.slice(0, cleanQ.length)}</mark>${text.slice(cleanQ.length)}`;
  }
  return text;
}

let suggestIndex = -1;
let currentSuggestions = [];

function updateSuggestDropdown() {
  if (!els.suggest) return;
  const raw = els.coords.value.trim();
  currentSuggestions = findPrefixMatches(raw);
  els.suggest.replaceChildren();
  suggestIndex = -1;
  if (!currentSuggestions.length) {
    els.suggest.hidden = true;
    return;
  }
  currentSuggestions.forEach((item, idx) => {
    const o = item.obj;
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const sub = item.matchedAlias
      ? `${highlightPrefix(item.matchedAlias, raw)} · ${fmtCoord(o.ra, o.dec)}`
      : `${(o.aka && o.aka[0]) ? o.aka[0] + " · " : ""}${fmtCoord(o.ra, o.dec)}`;
    li.innerHTML = `<span>${highlightPrefix(o.name, raw)}</span><small>${sub}</small>`;
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      els.suggest.hidden = true;
      lookAt(o.ra, o.dec, o.size || +els.size.value, null, o.name);
    });
    els.suggest.append(li);
  });
  els.suggest.hidden = false;
}

els.coords.addEventListener("input", updateSuggestDropdown);
els.coords.addEventListener("focus", () => {
  els.coords.select();
  updateSuggestDropdown();
});
els.coords.addEventListener("blur", () => {
  setTimeout(() => { if (els.suggest) els.suggest.hidden = true; }, 120);
});
els.coords.addEventListener("keydown", (ev) => {
  if (!els.suggest || els.suggest.hidden || !currentSuggestions.length) return;
  const items = [...els.suggest.children];
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    suggestIndex = (suggestIndex + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, idx) => li.setAttribute("aria-selected", String(idx === suggestIndex)));
    if (items[suggestIndex]) items[suggestIndex].scrollIntoView({ block: "nearest" });
  } else if (ev.key === "Escape") {
    els.suggest.hidden = true;
  }
});

els.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (els.suggest) els.suggest.hidden = true;
  if (suggestIndex >= 0 && currentSuggestions[suggestIndex]) {
    const o = currentSuggestions[suggestIndex].obj;
    lookAt(o.ra, o.dec, o.size || +els.size.value, null, o.name);
    return;
  }
  const raw = els.coords.value.trim();
  if (!raw) return;
  // Strip trailing "(ra dec)" if user submits a labeled preset string
  const cleaned = raw.replace(/\s*\([0-9.+\-\s]+\)\s*$/, "").trim();
  const c = parseCoords(cleaned) || parseCoords(raw);
  if (c) {
    lookAt(c.ra, c.dec, +els.size.value, state.ra === null ? null : state.lam);
    return;
  }
  // Check prefix/catalog matches first
  const matches = findPrefixMatches(cleaned);
  if (matches.length) {
    const o = matches[0].obj;
    lookAt(o.ra, o.dec, o.size || +els.size.value, null, o.name);
    return;
  }
  // Resolve any object name via astronomical catalogs (SIMBAD / NED / VizieR)
  setStatus(`Looking up "${cleaned}" in astronomical catalogs (SIMBAD/NED)…`);
  try {
    const r = await fetch(`/api/resolve?name=${encodeURIComponent(cleaned)}`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.statusText);
    }
    const resolved = await r.json();
    const label = resolved.otype ? `${resolved.name} [${resolved.otype}]` : resolved.name;
    lookAt(resolved.ra, resolved.dec, +els.size.value, state.ra === null ? null : state.lam, label);
  } catch (e) {
    setStatus(`Could not find "${cleaned}" (${e.message}). Enter an object name (e.g. Barnard's Star, M51, TRAPPIST-1) or coordinates like 56.75 +24.12.`, "error");
    els.coords.focus();
  }
});

els.prev.addEventListener("click", () => { stopMotion(); step(-1); });
els.next.addEventListener("click", () => { stopMotion(); step(1); });
els.play.addEventListener("click", () => start("play"));
els.blink.addEventListener("click", () => start("blink"));
els.ref.addEventListener("change", () => { state.ref = +els.ref.value; render(); });
els.speed.addEventListener("input", () => {
  if (state.timer) { const m = state.mode; state.mode = "still"; clearInterval(state.timer); state.timer = null; start(m); }
});
for (const c of [els.diff, els.negative, els.reticle, els.stretch]) c.addEventListener("input", () => { render(); drawOverlay(); });

document.addEventListener("keydown", (ev) => {
  if (ev.target.matches("input[type=text], select")) return;
  if (ev.key === "ArrowLeft") { stopMotion(); step(-1); }
  else if (ev.key === "ArrowRight") { stopMotion(); step(1); }
  else if (ev.key === " " && !ev.target.matches("button, input")) { ev.preventDefault(); start("blink"); }
});

els.plate.addEventListener("mousemove", (ev) => {
  if (state.ra === null || !state.frames.length) return;
  const box = els.plate.getBoundingClientRect();
  const fx = (ev.clientX - box.left) / box.width - 0.5, fy = (ev.clientY - box.top) / box.height - 0.5;
  const dec = state.dec - fy * state.size;
  const ra = (state.ra - fx * state.size / Math.cos(state.dec * Math.PI / 180) + 360) % 360;
  els.readout.hidden = false;
  els.readout.textContent = fmtCoord(ra, dec);
});
els.plate.addEventListener("mouseleave", () => { els.readout.hidden = true; });

updateButtons();
(async () => {
  const q = new URLSearchParams(location.search);
  const homeCatParam = q.get("homecat");
  const catParam = q.get("cat");

  if (homeCatParam && HOMEPAGE_CATS.includes(homeCatParam)) {
    currentHomeFilter = homeCatParam;
    // comets live only in the home-page list, so show that tab as picked
    currentAstroFilter = homeCatParam === "Moving objects" ? FEATURED_CAT : "All";
  } else if (catParam) {
    if (HOMEPAGE_CATS.includes(catParam)) {
      currentHomeFilter = catParam;
      currentAstroFilter = "All";
    } else if (ASTRO_CATS.includes(catParam)) {
      currentAstroFilter = catParam;
      currentHomeFilter = ASTRO_TO_HOME[catParam] || "All";
    } else {
      const idx = parseInt(catParam, 10);
      if (Number.isFinite(idx) && idx >= 0 && idx < PRESET_CATEGORIES.length) {
        currentAstroFilter = PRESET_CATEGORIES[idx].category;
        currentHomeFilter = ASTRO_TO_HOME[currentAstroFilter] || "All";
      }
    }
  }

  applyFilters();          // show the built-in categories straight away
  await loadFeatured();
  applyFilters();          // then again with the home-page targets

  const ra = parseFloat(q.get("ra")), dec = parseFloat(q.get("dec"));
  const name = q.get("name") || null;
  if (Number.isFinite(ra) && Number.isFinite(dec)) {
    lookAt(ra, dec, parseFloat(q.get("size")) || 0.25, parseFloat(q.get("lam")) || null, name);
  } else {
    // start on the first listed object that has a fixed position (never
    // jump away to the time machine on page load)
    const pool = getFilteredItems().filter((o) => !o.link);
    const startObj = pool[0] || PRESET_CATEGORIES[0].items[0];
    lookAt(startObj.ra, startObj.dec, startObj.size, null, startObj.name);
  }
})();
