// Renders web/og.png, the picture shown when a Sky Blink link is shared.
// Run from the repository root with a local server on port 8011:
//   uvicorn app:app --app-dir backend --port 8011 &   then   node tools/make_og.js
const { chromium } = require("playwright");
const path = require("path");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await p.goto("http://localhost:8011/how.html");          // same origin, so images load
  await p.setContent(`<!doctype html><html><head>
  <base href="http://localhost:8011/">
  <link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600&family=Bricolage+Grotesque:opsz,wght@12..96,700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; width: 1200px; height: 630px; background: #04070f; color: #eef0f6; font-family: "Public Sans"; overflow: hidden; }
    .sky { position: absolute; right: 0; top: 0; width: 630px; height: 630px; background: url(showcase/pleiades/s0.png) center/cover; }
    .sky::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, #04070f 0%, rgba(4,7,15,0.2) 45%, rgba(4,7,15,0) 100%); }
    .ring { position: absolute; right: 291px; top: 291px; width: 48px; height: 48px; border: 3px solid #ffb347; border-radius: 50%; }
    .txt { position: absolute; left: 64px; top: 0; bottom: 0; width: 640px; display: flex; flex-direction: column; justify-content: center; }
    .mark { font-family: "Bricolage Grotesque"; font-weight: 700; color: #ffb347; font-size: 40px; letter-spacing: -0.03em; }
    h1 { font-family: "Bricolage Grotesque"; font-weight: 700; font-size: 82px; line-height: 0.92; letter-spacing: -0.045em; margin: 26px 0 0; }
    p { font-size: 27px; line-height: 1.4; color: #b4bbcf; margin: 26px 0 0; max-width: 560px; }
  </style></head><body>
    <div class="sky"></div>
    <div class="txt"><div class="mark">Sky Blink</div>
      <h1>The sky is not as still as it looks.</h1>
      <p>Real NASA SPHEREx images, lined up months apart, show what moved and what changed.</p></div>
  </body></html>`, { waitUntil: "networkidle" });
  await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(__dirname, "..", "web", "og.png") });
  await b.close();
})();
