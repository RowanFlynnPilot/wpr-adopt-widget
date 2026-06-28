/**
 * Wausau Pilot & Review — Featured Adoptable Pet (newsletter snapshot)
 *
 * Picks ONE long-stay pet from the latest scraped data and renders a branded
 * card to a PNG that can be embedded in the daily email newsletters (email
 * clients strip iframes/JS, so a static image is the only reliable option).
 *
 * Selection rules:
 *   - Focus on pets that have been listed the longest ("≥ 2 months" goal).
 *     Tenure uses the best available signal per pet:
 *       1. firstSeen date (real, from pet-data.json tracking)
 *       2. Petfinder publishedAt (real, when the API path is active)
 *       3. otherwise the pet predates firstSeen tracking → treated as a
 *          long-stay "veteran", ranked oldest-first by Adoptapet listing ID.
 *     Until firstSeen matures past 60 days (tracking began 2026-06-13), the
 *     veterans ARE the long-stay pool, so the focus still lands correctly.
 *   - Never feature the same pet more than 3 times in any rolling 14 days.
 *   - Never repeat the immediately-previous edition's pet (AM ≠ PM ≠ next AM).
 *   - The chosen pet must have a photo and pass a tolerant liveness check.
 *
 * Runs twice daily (6 AM / 4 PM Central) from .github/workflows/snapshot.yml,
 * reading the pet-data.json committed by the main scraper (no re-scrape).
 *
 * Output:
 *   docs/snapshots/featured-pet-latest.png        (always the newest)
 *   docs/snapshots/featured-pet-YYYY-MM-DD-am.png (stable per-edition archive)
 *   docs/snapshots/featured-pet.json              (metadata sidecar)
 *   featured-history.json                         (rotation/dedup log)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PAGES_BASE = 'https://rowanflynnpilot.github.io/wpr-adopt-widget';
const TOOL_URL = 'https://wausaupilotandreview.com/pet-finder/'; // the full adoptable-pets tool
const DATA_FILE = path.join(ROOT, 'pet-data.json');
const HISTORY_FILE = path.join(ROOT, 'featured-history.json');
const SNAP_DIR = path.join(ROOT, 'docs', 'snapshots');

const DAY = 86400000;
const RECENT_WINDOW_DAYS = 14;
const MAX_FEATURES_PER_WINDOW = 3;
const LONGSTAY_DAYS = 60;            // "≥ 2 months" threshold for provable tenure
const HISTORY_RETAIN_DAYS = 90;      // prune older history entries

const SHELTER_META = {
  marathon:  { name: 'Humane Society of Marathon County', location: 'Wausau, WI',          logo: 'marathon.svg',    website: 'https://catsndogs.org' },
  clark:     { name: 'Clark County Humane Society',       location: 'Neillsville, WI',     logo: 'clark.jpg',       website: 'https://www.cchs-petshelter.org' },
  adams:     { name: 'Adams County Humane Society',       location: 'Friendship, WI',      logo: 'adams.jpg',       website: 'https://www.adamscountyhumanesociety.org' },
  lincoln:   { name: 'Lincoln County Humane Society',     location: 'Merrill, WI',         logo: 'lincoln.png',     website: 'https://furrypets.com' },
  nlpac:     { name: 'New Life Pet Adoption Center',      location: 'Marathon, WI',        logo: 'nlpac.png',       website: 'https://www.nlpac.com' },
  fetch:     { name: 'Fetch Foster and Rescue',          location: 'Wausau, WI',          logo: 'fetch.png',       website: 'https://www.fetchfosterandrescue.com' },
  southwood: { name: 'South Wood County Humane Society',  location: 'Wisconsin Rapids, WI',logo: 'southwood.jpg',   website: 'https://www.swchs.com' },
  marshfield:{ name: 'Marshfield Area Pet Shelter',       location: 'Marshfield, WI',      logo: 'marshfield.webp', website: 'https://www.marshfieldpetshelter.org' },
};

// ─── SELECTION (pure, exported for tests) ───

function adoptapetId(url) {
  const m = (url || '').match(/adoptapet\.com\/pet\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Best-available listing tenure in days; real=false means pre-tracking veteran. */
function tenure(pet, firstSeen, now) {
  const fs2 = firstSeen && firstSeen[pet.url];
  if (fs2) return { days: Math.floor((now - Date.parse(fs2)) / DAY), real: true };
  if (pet.publishedAt) return { days: Math.floor((now - Date.parse(pet.publishedAt)) / DAY), real: true };
  return { days: null, real: false };
}

/** Lower tier = higher priority for the long-stay focus. */
function tierOf(ten) {
  if (ten.real && ten.days >= LONGSTAY_DAYS) return 1; // provably ≥ 2 months
  if (!ten.real) return 2;                              // pre-tracking veteran (likely long-stay)
  return 3;                                             // tracked but younger than 2 months
}

function isFeatureable(p) {
  if (!p || !p.url || !p.photo) return false;
  if (/More (Pets|Dogs|Cats) Available/i.test(p.name || '')) return false;
  if (!p.name || /^\s*$/.test(p.name)) return false;
  return true;
}

/**
 * Rank all featureable pets best-first. Caller walks the list applying
 * liveness/photo checks and takes the first that renders.
 */
function rankCandidates(data, history, now, excludeUrl) {
  const recentCount = url => (history[url] || []).filter(t => now - Date.parse(t) < RECENT_WINDOW_DAYS * DAY).length;
  const lastFeatured = url => { const a = history[url] || []; return a.length ? Date.parse(a[a.length - 1]) : 0; };

  const scored = [];
  for (const [shelter, arr] of Object.entries(data.shelters || {})) {
    for (const p of arr || []) {
      if (!isFeatureable(p)) continue;
      const ten = tenure(p, data.firstSeen, now);
      const recent = recentCount(p.url);
      if (recent >= MAX_FEATURES_PER_WINDOW) continue; // ≤ 3 per 14 days
      if (excludeUrl && p.url === excludeUrl) continue; // different from last edition
      scored.push({ pet: { ...p, shelter }, ten, tier: tierOf(ten), id: adoptapetId(p.url), recent, last: lastFeatured(p.url) });
    }
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;        // long-stay focus
    if (a.recent !== b.recent) return a.recent - b.recent; // spread features around
    if (a.tier === 2) {                                    // veterans: oldest listing first
      const ai = a.id == null ? Infinity : a.id;
      const bi = b.id == null ? Infinity : b.id;
      if (ai !== bi) return ai - bi;
    } else {                                               // dated tiers: longest tenure first
      const ad = a.ten.days || 0, bd = b.ten.days || 0;
      if (ad !== bd) return bd - ad;
    }
    if (a.last !== b.last) return a.last - b.last;         // least recently featured
    return (a.pet.name || '').localeCompare(b.pet.name || '');
  });
  return scored;
}

/** URL of the most recently featured pet overall (to guarantee edition variety). */
function lastFeaturedUrl(history) {
  let best = null, bestT = 0;
  for (const [url, times] of Object.entries(history || {})) {
    for (const t of times) {
      const ms = Date.parse(t);
      if (ms > bestT) { bestT = ms; best = url; }
    }
  }
  return best;
}

/** Human, HONEST tenure label — only states a duration we can back up. */
function tenureLabel(cand) {
  const { ten } = cand;
  if (ten.real && ten.days >= LONGSTAY_DAYS) {
    const months = Math.round(ten.days / 30);
    return `🕓 Waiting ${months} month${months === 1 ? '' : 's'} for a home`;
  }
  if (ten.real && ten.days >= 30) return '🕓 Waiting over a month for a home';
  if (!ten.real) return '🕓 A long-time resident still hoping for a home';
  return '🏠 Hoping to find a forever home';
}

// ─── RENDER ───

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cleanBio(bio) {
  // Full description — no truncation; the card grows to fit.
  return (bio || '').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

function dataUri(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

function buildCardHtml(cand) {
  const p = cand.pet;
  const meta = SHELTER_META[p.shelter] || { name: p.shelter, location: '', logo: null };
  const wprLogo = dataUri(path.join(ROOT, 'logos', 'wpr-logo.jpg'));
  const shelterLogo = meta.logo && fs.existsSync(path.join(ROOT, 'logos', meta.logo))
    ? dataUri(path.join(ROOT, 'logos', meta.logo)) : null;
  const sc = (p.species || '').toLowerCase();
  const speciesClass = sc.includes('cat') ? 'cat' : sc.includes('dog') ? 'dog' : 'other';
  const gender = (p.gender || '').trim();
  const genderClass = /female/i.test(gender) ? 'female' : /male/i.test(gender) ? 'male' : '';
  const ageLine = [p.breed, p.age].filter(Boolean).join('  ·  ');
  const bio = cleanBio(p.bio) || `${p.name} is waiting at ${meta.name} for the right family to come along.`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--teal:#4a9e8e;--teal-dark:#3a7d70;--ink:#1a1a1a;--slate:#555;--sand:#f2efea;--border:#e2ddd4}
body{background:transparent;font-family:'Source Sans 3',sans-serif}
.card{width:600px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.16);border:1px solid var(--border)}
.head{display:flex;align-items:center;gap:14px;padding:16px 22px;background:linear-gradient(135deg,var(--teal-dark),var(--teal))}
.head img{width:54px;height:54px;border-radius:50%;background:#fff;object-fit:contain;flex-shrink:0;padding:2px}
.head .eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#cfeae3}
.head .title{font-family:'Playfair Display',serif;font-size:25px;font-weight:800;color:#fff;line-height:1.1;margin-top:2px}
.photo-wrap{width:600px;height:372px;background:var(--sand)}
.photo-wrap img{width:100%;height:100%;object-fit:cover;object-position:center 25%;display:block}
.body{padding:18px 24px 22px}
.name{font-family:'Playfair Display',serif;font-size:34px;font-weight:800;color:var(--ink);line-height:1.05}
.subline{font-size:16px;color:var(--slate);font-weight:600;margin-top:3px}
.tags{display:flex;gap:7px;margin-top:11px}
.tag{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:4px 11px;border-radius:100px}
.tag.dog{background:#e2dbd0;color:#6b5a3f}.tag.cat{background:#ccdce6;color:#3a5568}.tag.other{background:#d8cfe6;color:#4f3a68}
.tag.male{background:#d0e0d6;color:#3a5a47}.tag.female{background:#e5d0d0;color:#6b3a3a}
.bio{font-size:16px;line-height:1.55;color:#444;margin-top:14px}
.shelter{display:flex;align-items:center;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}
.shelter img{width:34px;height:34px;border-radius:7px;object-fit:contain;background:var(--sand);flex-shrink:0}
.shelter .s-name{font-size:14px;font-weight:700;color:var(--ink);line-height:1.2}
.shelter .s-loc{font-size:13px;color:var(--slate)}
</style></head>
<body>
<div class="card" id="card">
  <div class="head">
    <img src="${wprLogo}" alt="">
    <div><div class="eyebrow">Wausau Pilot &amp; Review</div><div class="title">Featured Adoptable Pet</div></div>
  </div>
  <div class="photo-wrap">
    <img id="petphoto" src="${esc(p.photo)}" alt="">
  </div>
  <div class="body">
    <div class="name">${esc(p.name)}</div>
    <div class="subline">${esc(ageLine)}</div>
    <div class="tags">
      <span class="tag ${speciesClass}">${esc(p.species || 'Pet')}</span>
      ${genderClass ? `<span class="tag ${genderClass}">${esc(gender)}</span>` : ''}
    </div>
    <div class="bio">${esc(bio)}</div>
    <div class="shelter">
      ${shelterLogo ? `<img src="${shelterLogo}" alt="">` : ''}
      <div><div class="s-name">${esc(meta.name)}</div><div class="s-loc">${esc(meta.location)}</div></div>
    </div>
  </div>
</div>
</body></html>`;
}

/**
 * Email-ready embed snippet: the featured PNG (clickable — wrapping an <img>
 * in an <a> works in email, even though text drawn inside the PNG cannot be a
 * link) followed by two real text links below it:
 *   1. "Meet [Name] →"           → the pet's individual adoption listing
 *   2. "View all adoptable pets →" → the full WP&R pet-finder tool
 * Written to a .html file the newsletter can paste in.
 */
function embedHtml(name, petUrl, pngUrl) {
  const n = esc(name), u = esc(petUrl), img = esc(pngUrl), tool = esc(TOOL_URL);
  const link = 'color:#3a7d70;font-weight:bold;text-decoration:none;';
  return `<!-- Wausau Pilot & Review — Featured Adoptable Pet (auto-generated; paste into newsletter) -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;">
  <tr><td style="text-align:center;">
    <a href="${u}" target="_blank" style="text-decoration:none;">
      <img src="${img}" alt="Featured adoptable pet: ${n}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:12px;">
    </a>
  </td></tr>
  <tr><td style="text-align:center;padding:14px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:19px;">
    <a href="${u}" target="_blank" style="${link}">Meet ${n} &rarr;</a>
  </td></tr>
  <tr><td style="text-align:center;padding:6px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;">
    <a href="${tool}" target="_blank" style="${link}">View all adoptable pets &rarr;</a>
  </td></tr>
</table>`;
}

/** Tolerant liveness check: only reject on a definitive 404/410. */
async function isLikelyGone(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(12000),
    });
    return res.status === 404 || res.status === 410;
  } catch (_) {
    return false; // network error / bot-block → give the benefit of the doubt
  }
}

async function renderCard(browser, cand, outPaths) {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 900, deviceScaleFactor: 2 });
  await page.setContent(buildCardHtml(cand), { waitUntil: 'networkidle0', timeout: 30000 });
  // The pet photo must actually load — otherwise this candidate is unusable.
  const photoOk = await page.evaluate(() => {
    const img = document.getElementById('petphoto');
    if (img && img.complete && img.naturalWidth > 0) return true;
    return new Promise(resolve => {
      const img2 = document.getElementById('petphoto');
      if (!img2) return resolve(false);
      img2.addEventListener('load', () => resolve(img2.naturalWidth > 0), { once: true });
      img2.addEventListener('error', () => resolve(false), { once: true });
      setTimeout(() => resolve(img2.complete && img2.naturalWidth > 0), 10000);
    });
  });
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (_) {}
  if (!photoOk) { await page.close(); return false; }
  const el = await page.$('#card');
  for (const out of outPaths) await el.screenshot({ path: out, omitBackground: true });
  await page.close();
  return true;
}

// ─── MAIN ───

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function pruneHistory(history, now) {
  const out = {};
  for (const [url, times] of Object.entries(history)) {
    const kept = times.filter(t => now - Date.parse(t) < HISTORY_RETAIN_DAYS * DAY);
    if (kept.length) out[url] = kept;
  }
  return out;
}

async function main() {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());

  const now = Date.now();
  const data = readJson(DATA_FILE, null);
  if (!data || !data.shelters) { console.error('No pet-data.json — run the scraper first.'); process.exit(1); }
  let history = pruneHistory(readJson(HISTORY_FILE, {}), now);

  const excludeUrl = lastFeaturedUrl(history);
  const candidates = rankCandidates(data, history, now, excludeUrl);
  if (candidates.length === 0) { console.error('No featureable pets found.'); process.exit(1); }

  console.log(`Ranked ${candidates.length} candidates. Top 5:`);
  candidates.slice(0, 5).forEach((c, i) =>
    console.log(`  ${i + 1}. ${c.pet.name} (${c.pet.shelter}) tier${c.tier} recent=${c.recent} id=${c.id ?? '-'} tenure=${c.ten.real ? c.ten.days + 'd' : 'veteran'}`));

  // Edition + filenames
  const d = new Date(now);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const edition = d.getUTCHours() < 16 ? 'am' : 'pm'; // 11:00 UTC run = AM, 21:00 UTC = PM
  const dateStr = `${yyyy}-${mm}-${dd}`;
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const latestPng = path.join(SNAP_DIR, 'featured-pet-latest.png');
  const editionPng = path.join(SNAP_DIR, `featured-pet-${dateStr}-${edition}.png`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  });

  let chosen = null;
  try {
    for (const cand of candidates) {
      if (await isLikelyGone(cand.pet.url)) {
        console.log(`  skip ${cand.pet.name} — listing returns 404/410`);
        continue;
      }
      if (await renderCard(browser, cand, [latestPng, editionPng])) { chosen = cand; break; }
      console.log(`  skip ${cand.pet.name} — photo failed to load`);
    }
  } finally {
    await browser.close();
  }

  if (!chosen) { console.error('Could not render any candidate.'); process.exit(1); }

  // Record the feature + write metadata sidecar
  const nowIso = new Date(now).toISOString();
  history[chosen.pet.url] = [...(history[chosen.pet.url] || []), nowIso];
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  const meta = SHELTER_META[chosen.pet.shelter] || {};
  const sidecar = {
    generatedAt: nowIso,
    edition,
    name: chosen.pet.name,
    species: chosen.pet.species,
    breed: chosen.pet.breed,
    age: chosen.pet.age,
    shelter: chosen.pet.shelter,
    shelterName: meta.name,
    tenureDays: chosen.ten.real ? chosen.ten.days : null,
    tenureSource: chosen.ten.real ? 'tracked' : 'pre-tracking-veteran',
    petUrl: chosen.pet.url,
    pngLatest: 'snapshots/featured-pet-latest.png',
    pngEdition: `snapshots/featured-pet-${dateStr}-${edition}.png`,
    embedLatest: 'snapshots/featured-pet-latest.html',
    embedEdition: `snapshots/featured-pet-${dateStr}-${edition}.html`,
  };
  fs.writeFileSync(path.join(SNAP_DIR, 'featured-pet.json'), JSON.stringify(sidecar, null, 2));

  // Ready-to-paste email embed snippets (clickable image + "Meet [Name] →" link)
  fs.writeFileSync(
    path.join(SNAP_DIR, 'featured-pet-latest.html'),
    embedHtml(chosen.pet.name, chosen.pet.url, `${PAGES_BASE}/snapshots/featured-pet-latest.png`));
  fs.writeFileSync(
    path.join(SNAP_DIR, `featured-pet-${dateStr}-${edition}.html`),
    embedHtml(chosen.pet.name, chosen.pet.url, `${PAGES_BASE}/snapshots/featured-pet-${dateStr}-${edition}.png`));

  console.log(`\n✅ Featured: ${chosen.pet.name} (${meta.name}) — ${edition.toUpperCase()} edition`);
  console.log(`   ${editionPng}`);
  console.log(`   ${latestPng}`);
}

module.exports = { rankCandidates, tenure, tierOf, tenureLabel, lastFeaturedUrl, isFeatureable, adoptapetId, pruneHistory, buildCardHtml, embedHtml };

if (require.main === module) {
  main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
}
