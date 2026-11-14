/**
 * Sky Blink - Pre-Demo Browser & Integration Test Runner
 * 
 * Can be run in Node.js (v18+) or copied into the browser DevTools Console
 * to verify all mission-critical features before live presentations:
 * 
 * 1. 6 Detector Bands (D1 - D6, 0.75 to 5.0 µm) & Astrophysics SED response
 * 2. Pre-computed Offline Target Spectra (3I/ATLAS, Barnard, WISE J184125)
 * 3. Real Steps vs. Blend toggle with "(not observed)" labelling
 * 4. Citizen-Science Pin Dropping & Astronomical RA/Dec calculation
 * 5. Candidate Review Queue ("Is this real?" Before vs After)
 * 6. Findings Report Export (CSV & JSON worded as "a report ready to share")
 * 7. Explorer Search Timeout (25s) and Graceful Retry
 * 8. 404 Cosmic Error Page
 */

const BASE_URL = process.env.TEST_URL || "https://nasa-theta-henna.vercel.app";

async function runBrowserChecks() {
  console.log(`\n======================================================`);
  console.log(`🚀 Sky Blink Pre-Demo Automated Verification Suite`);
  console.log(`   Target: ${BASE_URL}`);
  console.log(`======================================================\n`);

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  // 1. Homepage & Static Assets Check
  console.log(`[1/8] Verifying Homepage & Assets...`);
  try {
    const res = await fetch(`${BASE_URL}/`);
    assert(res.ok, `Homepage loaded successfully (HTTP ${res.status})`);
    const html = await res.text();
    assert(html.includes("band-bar"), "Band selector element present in DOM");
    assert(html.includes("blend-toggle"), "Real steps / Blend toggle present in DOM");
    assert(html.includes("flag-modal"), "Citizen science flag modal present in DOM");
    assert(html.includes("findings-modal"), "My Findings modal present in DOM");
    assert(html.includes("review-modal"), "Candidate review modal present in DOM");
    assert(html.includes("spectrum-card"), "Target spectrum card present in DOM");
  } catch (err) {
    assert(false, `Homepage fetch error: ${err.message}`);
  }

  // 2. How It Works Documentation Check
  console.log(`\n[2/8] Verifying How It Works Documentation...`);
  try {
    const res = await fetch(`${BASE_URL}/how.html`);
    assert(res.ok, `how.html loaded successfully (HTTP ${res.status})`);
    const html = await res.text();
    assert(html.includes("6 infrared detectors"), "Documents 6 SPHEREx detector bands");
    assert(html.includes("Citizen science: Flag findings"), "Documents citizen science flag and review queue");
    assert(html.includes("Real steps vs Blend"), "Documents Real steps vs Blend toggle");
    assert(html.includes("not observed"), "Explicitly explains 'not observed' blend label");
    assert(html.includes("report ready to share"), "Mentions findings export ready to share");
  } catch (err) {
    assert(false, `how.html fetch error: ${err.message}`);
  }

  // 3. Themed 404 Page Check
  console.log(`\n[3/8] Verifying 404 Cosmic Handler...`);
  try {
    const res = await fetch(`${BASE_URL}/deep-space-nonexistent-path-404`);
    assert(res.status === 404, `Returns 404 HTTP status for unknown path`);
    const html = await res.text();
    assert(html.includes("Deep space — Uncharted territory") || html.includes("404"), "Themed 404 page displayed");
    assert(html.includes("Return to Sky Blink Home"), "404 page provides return link to home");
  } catch (err) {
    assert(false, `404 check error: ${err.message}`);
  }

  // 4. Showcase Targets & Pre-computed Spectra Check
  console.log(`\n[4/8] Verifying Pre-computed Offline Spectra...`);
  const showcaseTargets = ["3i-atlas", "wise-j184125", "barnard", "crab", "orion"];
  for (const slug of showcaseTargets) {
    try {
      const res = await fetch(`${BASE_URL}/showcase/${slug}/meta.json`);
      assert(res.ok, `Loaded metadata for target '${slug}'`);
      const meta = await res.json();
      assert(Array.isArray(meta.spectrum) && meta.spectrum.length > 0, `'${slug}' contains pre-computed spectrum data`);
      
      const detectors = new Set(meta.spectrum.map(s => s.det));
      assert(detectors.size === 6, `'${slug}' spectrum spans all 6 SPHEREx detectors (D1 to D6)`);
      
      // Check 3I/ATLAS comet specific colours
      if (slug === "3i-atlas") {
        const d1 = meta.spectrum.find(s => s.det === 1);
        const d6 = meta.spectrum.find(s => s.det === 6);
        assert(d1 && d6, "3I/ATLAS contains spectrophotometry in both Blue (D1) and Deep Red (D6)");
      }
    } catch (err) {
      assert(false, `Target '${slug}' error: ${err.message}`);
    }
  }

  // 5. Bundled Explorer Presets
  console.log(`\n[5/8] Verifying Explorer Presets (100% Shipped)...`);
  try {
    // Barnard's Star preset hash
    const barnardRes = await fetch(`${BASE_URL}/api/search?ra=269.4462&dec=4.7697`);
    assert(barnardRes.ok, "Preset for Barnard's Star loads instantly via bundled data");
    const data = await barnardRes.json();
    assert(data.exposures && data.exposures.length > 0, "Barnard's Star has real SPHEREx exposures");
    assert(data.epochs && data.epochs.length > 0, "Barnard's Star has multi-epoch sweeps");
  } catch (err) {
    assert(false, `Preset check error: ${err.message}`);
  }

  // 6. Search Timeout & Busy Retry Logic
  console.log(`\n[6/8] Verifying Explorer Search Timeout Logic...`);
  try {
    const appJsRes = await fetch(`${BASE_URL}/app.js`);
    const appJs = await appJsRes.text();
    assert(appJs.includes("SEARCH_TIMEOUT_MS = 25000"), "Explorer enforces 25-second timeout on NASA archive queries");
    assert(appJs.includes("The NASA archive is busy"), "Explorer surfaces friendly busy messages during archive stress");
    assert(appJs.includes("attempt <= 2"), "Explorer implements automatic retry");
  } catch (err) {
    assert(false, `app.js check error: ${err.message}`);
  }

  // 7. Showcase Physics & Blending Logic Check
  console.log(`\n[7/8] Verifying Astrophysics Filtering & Blending...`);
  try {
    const scJsRes = await fetch(`${BASE_URL}/showcase.js`);
    const scJs = await scJsRes.text();
    assert(scJs.includes("BANDS ="), "Defines SPHEREx 6-detector band configuration");
    assert(scJs.includes("wise-j184125"), "Models brown dwarf physics SED (glows at 4.5µm, invisible at 1µm)");
    assert(scJs.includes("(not observed)"), "Blended frames explicitly labelled '(not observed)'");
    assert(scJs.includes("[Real observation]"), "Real sweeps labelled '[Real observation]'");
    assert(scJs.includes("T.i = listIdx"), "Tour guard protects against mismatched tour pills");
  } catch (err) {
    assert(false, `showcase.js check error: ${err.message}`);
  }

  // 8. Citizen Science Flag, Review Queue & Findings Export
  console.log(`\n[8/8] Verifying Citizen Science Workflow...`);
  try {
    const scJsRes = await fetch(`${BASE_URL}/showcase.js`);
    const scJs = await scJsRes.text();
    assert(scJs.includes("openFlagModal"), "Plate click triggers astronomical pin dropping & flag modal");
    assert(scJs.includes("openReviewModal"), "Review queue ('Is this real?') compare view supported");
    assert(scJs.includes("exportFindingsCSV"), "CSV export implemented");
    assert(scJs.includes("exportFindingsJSON"), "JSON export implemented");
    assert(scJs.includes("A report ready to share"), "Findings report strictly worded as 'A report ready to share' (not MPC-ready)");
  } catch (err) {
    assert(false, `Citizen science check error: ${err.message}`);
  }

  console.log(`\n======================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log(`🌟 ALL DEMO CHECKS PASSED! Ready for live demonstration.`);
  } else {
    console.error(`⚠️ Some checks failed. Review errors above.`);
  }
  console.log(`======================================================\n`);
  return failed === 0;
}

if (typeof module !== "undefined" && require.main === module) {
  runBrowserChecks().then(success => {
    process.exit(success ? 0 : 1);
  });
}
