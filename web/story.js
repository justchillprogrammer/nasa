"use strict";

/* Home page story. The reader's scroll position, measured in screen heights,
   drives everything: which passage is showing, where the camera looks, and
   (in the Barnard's Star chapter) the date. All pixels are real SPHEREx
   images from web/showcase/barnard; nothing here plays on its own.
   Uses decodeF16() and quantile() from showcase.js. */

(() => {
  const root = document.getElementById("story");
  if (!root) return;

  const SLUG = "barnard";
  const stage = root.querySelector(".story-stage");
  const cvs = document.getElementById("story-canvas");
  const ctx = cvs.getContext("2d");
  const chapters = [...root.querySelectorAll(".chapter")].map((node) => ({
    node, from: +node.dataset.from, to: +node.dataset.to,
  }));
  const steps = [...root.querySelectorAll(".story-steps li")];
  const timeBox = document.getElementById("story-time");
  const dateEl = document.getElementById("story-date");
  const fillEl = document.getElementById("story-fill");
  const ticksEl = document.getElementById("story-ticks");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const SCREENS = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--screens")) || 8.6;

  // Story beats, in screen heights from the top of the story.
  const B = {
    plateIn: 2.05, plateFull: 2.35, plateOut: 3.25, plateGone: 3.55,
    zoomStart: 3.45, zoomEnd: 4.35,
    timeStart: 4.7, timeEnd: 5.7,
    stepsStart: 6.05, stepsEach: 0.38,
    dimStart: 6.0, dimEnd: 6.3,
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const ramp = (s, a, b) => ease((s - a) / (b - a));

  // Resting points, in screen heights. A small scroll glides to the next one:
  // each passage, each flip of the glass plate, each SPHEREx pass of
  // Barnard's Star, each detection step. The Apr 2026 stop is set from the
  // real dates once they load.
  let stops = [0, 1.5, 2.47, 2.68, 2.9, 3.12, 3.9, 4.7, 5.2, 5.7, 6.4, 6.78, 7.16, 7.5, 8.3];
  const LAST = () => stops[stops.length - 1];

  let data = null;        // images and the measured motion
  let target = 0;         // where the scroll is
  let shown = 0;          // where the picture is (eases toward target)
  let tween = null;       // a glide from one stop to the next
  let raf = 0;

  /* ------------------------------------------------------------ images */

  // stretch: how pixel values map to brightness. negative: draw as a glass plate.
  function paint(frame, n, stretch, negative) {
    const { floor, white, soft, norm } = stretch;
    const cv = document.createElement("canvas");
    cv.width = cv.height = n;
    const c = cv.getContext("2d");
    const img = c.createImageData(n, n), px = img.data;
    for (let i = 0, j = 0; i < frame.length; i++, j += 4) {
      const v = frame[i];
      let s = v !== v ? 1 : Math.asinh(soft * (v - floor) / white) / norm;   // NaN: saturated centre
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      if (negative) {
        // pale glass (217,223,227) darkening to plate ink (20,24,36)
        px[j] = 217 - 197 * s; px[j + 1] = 223 - 199 * s; px[j + 2] = 227 - 191 * s;
      } else {
        // deep sky (4,7,15) to warm infrared white
        px[j] = 4 + 251 * s;
        px[j + 1] = 7 + 241 * Math.pow(s, 1.1);
        px[j + 2] = 15 + 225 * Math.pow(s, 1.3);
      }
      px[j + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  async function load() {
    const meta = await fetch(`showcase/${SLUG}/meta.json`).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
    const move = meta.changes.find((c) => c.kind === "moved" && c.track);
    if (!move) return;
    const bufs = await Promise.all(meta.sweeps.map((s) =>
      fetch(`showcase/${SLUG}/${s.frame}`).then((r) => r.arrayBuffer())));
    const frames = bufs.map(decodeF16);
    const n = meta.npix;
    const med = quantile(frames[0], 0.5);
    const sig = Math.max(med - quantile(frames[0], 0.16), 1e-4);
    const stretch = {
      floor: med - 1.2 * sig,
      white: Math.max(quantile(frames[0], 0.998) - med, 12 * sig),
      soft: 10, norm: Math.asinh(10),
    };
    // A harder stretch for the close-up, so the bright star shrinks to its
    // core and its shift against the neighbours shows.
    const core = {
      floor: med + 2 * sig,
      white: Math.max(quantile(frames[0], 0.9995) - med, 40 * sig),
      soft: 3, norm: Math.asinh(3),
    };
    data = {
      meta, move, n,
      sky: frames.map((f) => paint(f, n, stretch, false)),
      core: frames.map((f) => paint(f, n, core, false)),
      glass: frames.map((f) => paint(f, n, stretch, true)),
      mjd: meta.sweeps.map((s) => s.mjd),
      mid: move.track[Math.floor(move.track.length / 2)],
    };
    writeStarText();
    buildTicks();
    // the middle Barnard stop sits exactly on the middle SPHEREx pass
    const mjd = data.mjd;
    if (mjd.length === 3) {
      const f = (mjd[1] - mjd[0]) / (mjd[2] - mjd[0]);
      stops = stops.map((v) => (v === 5.2 ? +(B.timeStart + f * (B.timeEnd - B.timeStart)).toFixed(3) : v));
    }
    cvs.classList.add("ready");
    schedule();
  }

  function writeStarText() {
    const { meta, move } = data;
    const first = meta.sweeps[0].label, last = meta.sweeps[meta.sweeps.length - 1].label;
    const err = move.rate_err_arcsec_per_year != null ? ` ± ${move.rate_err_arcsec_per_year}` : "";
    const cat = move.catalogue
      ? ` Star catalogues give ${move.catalogue.rate_arcsec_per_year}; ${move.catalogue.agrees ? "our measurement agrees" : "our measurement does not agree"}.`
      : "";
    document.getElementById("story-star-text").innerHTML =
      `Measured from ${first} to ${last}, it moves <b>${move.rate_arcsec_per_year}${err} arcseconds a year ${move.direction}</b>: ` +
      `in a year, about the width of a coin seen from half a kilometre away.${cat}`;
  }

  function buildTicks() {
    const { mjd, meta } = data;
    const t0 = mjd[0], t1 = mjd[mjd.length - 1];
    ticksEl.replaceChildren(...meta.sweeps.map((s) => {
      const tick = document.createElement("span");
      tick.style.left = `${((s.mjd - t0) / (t1 - t0)) * 100}%`;
      tick.innerHTML = `<em>${s.label}</em>`;
      return tick;
    }));
  }

  /* ------------------------------------------------------------ camera */

  // Everything the picture shows at scroll position s.
  function camera(s, W, H) {
    const { n, mid, mjd } = data;
    let span = s < B.zoomStart ? lerp(n, n * 0.68, ease(s / B.zoomStart))
      : lerp(n * 0.68, 64, ramp(s, B.zoomStart, B.zoomEnd));
    span = lerp(span, 120, ramp(s, B.dimStart, B.dimEnd + 0.4));

    // Bring the star off-centre, away from the text (right on wide screens,
    // up on tall ones), once the story turns to it.
    const toStar = ramp(s, 1.6, B.zoomEnd);
    const wide = W > H * 1.1;
    const scale = Math.max(W, H) / span;
    const viewW = W / scale, viewH = H / scale;
    const cx = lerp(n / 2, mid.x + 0.5 - (wide ? viewW * 0.2 : 0), toStar);
    const cy = lerp(n / 2, mid.y + 0.5 + (wide ? 0 : viewH * 0.07), toStar);

    const plate = ramp(s, B.plateIn, B.plateFull) * (1 - ramp(s, B.plateOut, B.plateGone));

    // Which sweeps to show. On the plate, scrolling flips first and last.
    let a = 0, b = 0, w = 0, tt = 0;
    const last = mjd.length - 1;
    if (s >= B.plateFull && s < B.plateOut) {
      a = b = Math.floor((s - B.plateFull) / 0.22) % 2 ? last : 0;
    } else if (s >= B.timeStart) {
      tt = clamp((s - B.timeStart) / (B.timeEnd - B.timeStart), 0, 1);
      const m = lerp(mjd[0], mjd[last], tt);
      a = 0;
      while (a < last - 1 && m > mjd[a + 1]) a++;
      b = Math.min(a + 1, last);
      w = b === a ? 0 : clamp((m - mjd[a]) / (mjd[b] - mjd[a]), 0, 1);
    }
    const starOn = ramp(s, B.zoomEnd - 0.2, B.timeStart) * (1 - ramp(s, B.dimStart, B.dimEnd));
    const close = ramp(s, B.zoomStart + 0.3, B.zoomEnd) * (1 - ramp(s, B.dimStart, B.dimEnd));
    const dim = 0.62 * ramp(s, B.dimStart, B.dimEnd);
    return { cx, cy, scale, viewW, viewH, plate, a, b, w, tt, starOn, close, dim };
  }

  /* ------------------------------------------------------------ drawing */

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(stage.clientWidth * dpr), H = Math.round(stage.clientHeight * dpr);
    if (cvs.width !== W || cvs.height !== H) { cvs.width = W; cvs.height = H; }
    return { W, H, dpr };
  }

  function layer(set, cam, alpha, W, H) {
    if (alpha <= 0) return;
    const sx = cam.cx - cam.viewW / 2, sy = cam.cy - cam.viewH / 2;
    ctx.globalAlpha = alpha;
    ctx.drawImage(set[cam.a], sx, sy, cam.viewW, cam.viewH, 0, 0, W, H);
    if (cam.w > 0) {
      ctx.globalAlpha = alpha * cam.w;
      ctx.drawImage(set[cam.b], sx, sy, cam.viewW, cam.viewH, 0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  function draw(s) {
    const { W, H, dpr } = size();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#04070f";
    ctx.fillRect(0, 0, W, H);
    if (!data) return;
    const cam = camera(s, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // The image is cropped to cover the window: fill the edges beyond it first.
    if (cam.plate > 0) { ctx.globalAlpha = cam.plate; ctx.fillStyle = "#d9dfe3"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    layer(data.sky, cam, 1 - cam.plate, W, H);
    layer(data.core, cam, cam.close, W, H);
    layer(data.glass, cam, cam.plate, W, H);

    const X = (x) => (x + 0.5 - (cam.cx - cam.viewW / 2)) * cam.scale;
    const Y = (y) => (y + 0.5 - (cam.cy - cam.viewH / 2)) * cam.scale;
    const { track } = data.move;
    const ring = Math.max(4 * cam.scale, 22 * dpr);

    // On the plate: two ink ticks pointing at the star, as astronomers
    // marked their glass plates.
    if (cam.plate > 0.5) {
      const p = track[cam.a === 0 ? 0 : track.length - 1];
      const x = X(p.x), y = Y(p.y), g = ring * 1.15, l = ring * 1.4;
      ctx.globalAlpha = (cam.plate - 0.5) * 2;
      ctx.strokeStyle = "#141824"; ctx.lineWidth = 2.5 * dpr; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - g - l, y); ctx.lineTo(x - g, y);
      ctx.moveTo(x, y - g - l); ctx.lineTo(x, y - g);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The measured motion: path so far, and a ring on the star.
    if (cam.starOn > 0) {
      const k = cam.a, w = cam.w;
      const pa = track[k], pb = track[Math.min(cam.b, track.length - 1)];
      const px = pa.x + w * (pb.x - pa.x), py = pa.y + w * (pb.y - pa.y);
      ctx.globalAlpha = cam.starOn;
      ctx.strokeStyle = "#ffb347"; ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (cam.tt > 0) {
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(X(track[0].x), Y(track[0].y));
        for (let i = 1; i <= k; i++) ctx.lineTo(X(track[i].x), Y(track[i].y));
        ctx.lineTo(X(px), Y(py));
        ctx.stroke();
      }
      // where it started: a dashed ring that stays behind
      if (cam.tt > 0) {
        ctx.save();
        ctx.globalAlpha = cam.starOn * 0.75;
        ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([5 * dpr, 6 * dpr]);
        ctx.beginPath(); ctx.arc(X(track[0].x), Y(track[0].y), ring, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = cam.starOn;
      }
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath(); ctx.arc(X(px), Y(py), ring, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (cam.dim > 0) { ctx.fillStyle = `rgba(4,7,15,${cam.dim})`; ctx.fillRect(0, 0, W, H); }
    updateTime(s, cam);
    root.classList.toggle("on-plate", cam.plate > 0.5);
  }

  function updateTime(s, cam) {
    const live = s > B.timeStart - 0.2 && s < B.stepsStart;
    timeBox.classList.toggle("live", live);
    if (!live) return;
    const { meta } = data;
    fillEl.style.width = `${cam.tt * 100}%`;
    const between = cam.w > 0.03 && cam.w < 0.97;
    const label = meta.sweeps[cam.w >= 0.5 ? cam.b : cam.a].label;
    // honest about blends: only the sweep dates are real observations
    dateEl.innerHTML = between
      ? `${label}<small>between passes: a blend, not an observation</small>`
      : `${label}<small>SPHEREx pass, ${meta.sweeps[cam.w >= 0.5 ? cam.b : cam.a].n} exposures</small>`;
  }

  /* ------------------------------------------------------------ passages */

  const FADE = 0.3;
  function updateText(s) {
    const still = reduce.matches;
    for (const c of chapters) {
      const o = Math.min(ramp(s, c.from, c.from + FADE), 1 - ramp(s, c.to - FADE, c.to));
      const n = c.node;
      if (o <= 0.001) { n.classList.remove("live"); n.style.opacity = 0; continue; }
      n.classList.add("live");
      n.style.opacity = o.toFixed(3);
      if (still) { n.style.transform = ""; n.style.filter = ""; continue; }
      // arriving text rises into place; leaving text drifts up and blurs away
      const leaving = s > (c.from + c.to) / 2;
      const off = (1 - o) * (leaving ? -28 : 28);
      n.style.transform = `translate3d(0, ${off.toFixed(1)}px, 0)`;
      n.style.filter = o > 0.98 ? "" : `blur(${((1 - o) * 8).toFixed(1)}px)`;
    }
    const at = Math.floor((s - B.stepsStart - 0.15) / B.stepsEach);
    steps.forEach((li, i) => {
      li.classList.toggle("on", i <= at);
      li.classList.toggle("now", i === Math.min(at, steps.length - 1));
    });
  }

  /* ------------------------------------------------------------ scroll */

  const progressEl = document.getElementById("story-progress");
  const unitPx = () => stage.clientHeight || window.innerHeight;
  const storyTop = () => root.getBoundingClientRect().top + window.scrollY;
  const onHome = () => !document.getElementById("feed-view").hidden;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function measure() {
    target = clamp((window.scrollY - storyTop()) / unitPx(), 0, SCREENS);
  }

  // Inside the story (above its last stop) scrolling moves between stops.
  function inStory() {
    return onHome() && target <= LAST() + 0.01;
  }

  function nearestStop(s) {
    return stops.reduce((b, v) => (Math.abs(v - s) < Math.abs(b - s) ? v : b), stops[0]);
  }

  function nextStop(dir) {
    const from = tween ? tween.to : target;
    if (dir > 0) return stops.find((v) => v > from + 0.01) ?? LAST();
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < from - 0.01) return stops[i];
    return stops[0];
  }

  // Jump the page to the stop at once, and let the picture glide there.
  function goTo(s) {
    const dist = Math.abs(s - shown);
    tween = reduce.matches || dist < 0.002 ? null
      : { from: shown, to: s, t0: performance.now(), dur: clamp(520 + 420 * dist, 600, 1300) };
    if (!tween) shown = s;
    window.scrollTo({ top: storyTop() + s * unitPx(), behavior: "instant" });
    measure();
    schedule();
  }

  function frame(now) {
    raf = 0;
    if (!onHome()) return;
    if (tween) {
      const p = clamp((now - tween.t0) / tween.dur, 0, 1);
      shown = lerp(tween.from, tween.to, easeInOut(p));
      if (p >= 1) { shown = tween.to; tween = null; }
    } else {
      // dragged or keyed scrolling: ease the picture toward the page
      shown += (target - shown) * (reduce.matches ? 1 : 0.16);
      if (Math.abs(target - shown) < 0.0015) shown = target;
    }
    draw(shown);
    updateText(shown);
    if (progressEl) progressEl.style.height = `${(shown / LAST()) * 100}%`;
    if (tween || shown !== target) schedule();
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

  /* wheel and trackpad: one gesture moves one stop. A trackpad sends a
     stream of small events (with momentum), so a new gesture starts only
     after a short quiet gap. */
  let lastWheel = 0, gesture = false, acc = 0;
  function onWheel(e) {
    if (!inStory() || e.ctrlKey) return;           // ctrl+wheel is zoom
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (!dy) return;
    if (dy > 0 && target >= LAST() - 0.01 && !tween) return;   // let the page carry on to the feed
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel > 180) { gesture = false; acc = 0; }
    lastWheel = now;
    if (gesture) return;
    acc += dy;
    if (Math.abs(acc) < 24) return;
    gesture = true;
    goTo(nextStop(Math.sign(acc)));
  }

  /* touch: a short swipe moves one stop */
  let touchY = null, touchUsed = false;
  function onTouchStart(e) { touchY = e.touches[0].clientY; touchUsed = false; }
  function onTouchMove(e) {
    if (touchY === null || !inStory()) return;
    const dy = touchY - e.touches[0].clientY;
    if (dy > 0 && target >= LAST() - 0.01 && !tween) return;
    e.preventDefault();
    if (touchUsed || Math.abs(dy) < 36) return;
    touchUsed = true;
    goTo(nextStop(Math.sign(dy)));
  }
  function onTouchEnd() { touchY = null; }

  /* keyboard */
  function onKey(e) {
    if (!inStory() || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest("input, textarea, select, button, a, [contenteditable]") && e.key === " ") return;
    const down = ["ArrowDown", "PageDown", " "].includes(e.key) && !e.shiftKey;
    const up = ["ArrowUp", "PageUp"].includes(e.key) || (e.key === " " && e.shiftKey);
    if (!down && !up) return;
    if (down && target >= LAST() - 0.01) return;
    e.preventDefault();
    goTo(nextStop(down ? 1 : -1));
  }

  // If the page comes to rest between stops (scrollbar, find-in-page,
  // an overshoot coming back up from the feed), settle on the nearest one.
  let idle = 0;
  function onScroll() {
    measure();
    schedule();
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (tween || !inStory()) return;
      const s = nearestStop(target);
      if (Math.abs(s - target) > 0.01) goTo(s);
    }, 200);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", () => {
    // keep the same stop under a new window size
    const s = tween ? tween.to : nearestStop(target);
    tween = null;
    if (inStory()) { shown = s; goTo(s); } else { measure(); shown = target; schedule(); }
  });
  window.addEventListener("hashchange", () => setTimeout(() => { measure(); shown = target; tween = null; schedule(); }, 0));

  measure();
  shown = target;
  updateText(shown);
  draw(shown);
  load().catch(() => { /* the passages still tell the story without pictures */ });
  fetch("showcase/index.json").then((r) => r.json()).then((idx) => {
    const n = (idx.targets || []).length;
    const el = document.getElementById("story-count");
    if (el && n) el.textContent = n === 1 ? "One place is" : `${n} places are`;
  }).catch(() => {});
})();
